"""Installation initialization service.

The sole authority for setup eligibility and initial-user claims. Uses a
durable singleton row (``InstallationStateDB``) as the source of truth — not
the User count. An atomic database compare-and-set ensures exactly one
initial-user claim can succeed, even under concurrency.
"""

# pyright: reportDeprecated=false, reportUnusedCallResult=false

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
    """Ensure the singleton row exists and return it.

    When first created on a database that already has Users, backfills
    ``initialized_at`` from the earliest User. Also repairs a pre-backfill
    singleton that has ``initialized_at IS NULL`` but Users exist.
    """
    state = session.get(InstallationStateDB, INSTALLATION_STATE_ID)
    if state is None:
        earliest = session.exec(
            select(UserDB).order_by(col(UserDB.created_at)).limit(1)
        ).first()
        if earliest is not None:
            state = InstallationStateDB(
                id=INSTALLATION_STATE_ID,
                initialized_at=earliest.created_at,
                initial_user_id=earliest.id,
            )
        else:
            state = InstallationStateDB(id=INSTALLATION_STATE_ID)
        session.add(state)
        session.commit()
        session.refresh(state)
    elif state.initialized_at is None:
        # Repair a pre-backfill singleton: if users exist, mark initialized.
        earliest = session.exec(
            select(UserDB).order_by(col(UserDB.created_at)).limit(1)
        ).first()
        if earliest is not None:
            state.initialized_at = earliest.created_at
            state.initial_user_id = earliest.id
            session.add(state)
            session.commit()
            session.refresh(state)
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
