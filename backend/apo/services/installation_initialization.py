"""SPEC-153: Installation initialization service.

The sole authority for setup eligibility and initial-user claims. Uses a
durable singleton row (``InstallationStateDB``) as the source of truth — not
the User count. An atomic database compare-and-set ensures exactly one
initial-user claim can succeed, even under concurrency.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import update
from sqlmodel import Session, col, select

from ..auth import hash_password
from ..models.db import InstallationStateDB, UserDB

INSTALLATION_STATE_ID = "installation"


@dataclass(frozen=True)
class InstallationSetupStatus:
    """Durable initialization eligibility plus current User presence."""

    has_users: bool
    setup_available: bool


class InstallationAlreadyInitializedError(RuntimeError):
    """Raised when an initial-user claim is attempted after initialization."""


def _ensure_singleton(session: Session) -> InstallationStateDB:
    """Ensure the singleton row exists and return it."""
    state = session.get(InstallationStateDB, INSTALLATION_STATE_ID)
    if state is None:
        state = InstallationStateDB(id=INSTALLATION_STATE_ID)
        session.add(state)
        session.flush()
    return state


def get_installation_setup_status(session: Session) -> InstallationSetupStatus:
    """Return durable initialization eligibility plus current User presence."""
    state = _ensure_singleton(session)
    has_users = session.exec(select(UserDB).limit(1)).first() is not None
    setup_available = state.initialized_at is None
    return InstallationSetupStatus(has_users=has_users, setup_available=setup_available)


def claim_initial_user(
    session: Session,
    *,
    email: str,
    name: str,
    password: str,
    is_instance_admin: bool,
) -> UserDB:
    """Atomically initialize the installation and create exactly one User.

    Performs a database-level compare-and-set against the singleton row: the
    UPDATE succeeds only when ``initialized_at IS NULL``. If zero rows are
    affected, another caller won the race — raise immediately and roll back
    the User insert.

    Raises :class:`InstallationAlreadyInitializedError` when the installation
    has already been claimed. Raises ``ValueError`` for invalid input (empty
    email, etc.) without consuming initialization.
    """
    normalized_email = email.strip().lower()
    if not normalized_email:
        raise ValueError("email is required")

    _ensure_singleton(session)

    # Create the User first (flush to get the ID, but don't commit yet).
    user = UserDB(
        email=normalized_email,
        name=name.strip() if name else "",
        password_hash=hash_password(password),
        is_admin=is_instance_admin,
    )
    session.add(user)
    session.flush()

    # Atomic compare-and-set: UPDATE ... WHERE initialized_at IS NULL.
    now = datetime.now(timezone.utc)
    stmt = (
        update(InstallationStateDB)
        .where(
            col(InstallationStateDB.id) == INSTALLATION_STATE_ID,
            col(InstallationStateDB.initialized_at).is_(None),
        )
        .values(initialized_at=now, initial_user_id=user.id)
    )
    result = session.execute(stmt)

    if getattr(result, "rowcount", 0) == 0:
        # Another caller already claimed initialization.
        session.rollback()
        raise InstallationAlreadyInitializedError(
            "Installation has already been initialized"
        )

    session.commit()
    session.refresh(user)
    return user
