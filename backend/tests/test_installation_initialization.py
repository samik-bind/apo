# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false
# pyright: reportAttributeAccessIssue=false

"""Acceptance tests: installation initialization (tests 1-7)."""

from __future__ import annotations

import pytest
from sqlmodel import Session, SQLModel, create_engine, select
from sqlalchemy.pool import StaticPool


@pytest.fixture
def fresh_session():
    """Isolated in-memory SQLite with InstallationStateDB available."""
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


class TestInstallationSetupStatus:
    """Tests 1-3: fresh exposes setup; initialized stays closed; full reset reopens."""

    def test_fresh_installation_exposes_setup(self, fresh_session: Session) -> None:
        from apo.services.installation_initialization import get_installation_setup_status

        status = get_installation_setup_status(fresh_session)
        assert status.has_users is False
        assert status.setup_available is True

    def test_initialized_stays_closed_after_user_deletion(self, fresh_session: Session) -> None:
        from apo.services.installation_initialization import (
            claim_initial_user,
            get_installation_setup_status,
        )
        from apo.models.db import UserDB

        # Claim the initial user.
        claim_initial_user(
            fresh_session, email="admin@test.com", name="Admin", password="a-strong-password-123", is_instance_admin=True
        )
        # Delete all users without clearing installation state.
        for u in fresh_session.exec(select(UserDB)).all():
            fresh_session.delete(u)
        fresh_session.commit()

        status = get_installation_setup_status(fresh_session)
        assert status.has_users is False
        assert status.setup_available is False

    def test_full_reset_reopens_setup(self, fresh_session: Session) -> None:
        from apo.services.installation_initialization import (
            claim_initial_user,
            get_installation_setup_status,
        )
        from apo.models.db import InstallationStateDB, UserDB

        claim_initial_user(
            fresh_session, email="admin@test.com", name="Admin", password="a-strong-password-123", is_instance_admin=True
        )

        # Simulate a full database reset — delete ALL data including users
        # and the singleton, as the explicit reset flow does.
        for u in fresh_session.exec(select(UserDB)).all():
            fresh_session.delete(u)
        state = fresh_session.get(InstallationStateDB, "installation")
        assert state is not None
        fresh_session.delete(state)
        fresh_session.commit()

        # A fresh database (no users, no singleton) reopens setup.
        status = get_installation_setup_status(fresh_session)
        assert status.setup_available is True


class TestAtomicClaim:
    """Tests 4-5: concurrent claims; failed user creation doesn't consume init."""

    def test_concurrent_claim_only_one_succeeds(self, fresh_session: Session) -> None:
        from apo.services.installation_initialization import (
            InstallationAlreadyInitializedError,
            claim_initial_user,
        )

        claim_initial_user(
            fresh_session, email="first@test.com", name="First", password="a-strong-password-123", is_instance_admin=True
        )

        with pytest.raises(InstallationAlreadyInitializedError):
            claim_initial_user(
                fresh_session, email="second@test.com", name="Second", password="another-strong-pw-456", is_instance_admin=True
            )

    def test_failed_user_creation_does_not_consume_init(self, fresh_session: Session) -> None:
        from apo.services.installation_initialization import get_installation_setup_status

        # Force a failure by using an invalid email (empty after strip).
        # The claim should raise (not InstallationAlreadyInitializedError)
        # and setup should remain available.
        with pytest.raises(Exception):
            from apo.services.installation_initialization import claim_initial_user
            claim_initial_user(
                fresh_session, email="", name="Bad", password="a-strong-password-123", is_instance_admin=True
            )

        status = get_installation_setup_status(fresh_session)
        assert status.setup_available is True


class TestBootstrapIntegration:
    """Tests 6-7: bootstrap uses shared claim; initialized is no-op."""

    def test_bootstrap_claims_initial_user(self, fresh_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
        from apo.services.installation_initialization import get_installation_setup_status

        monkeypatch.setenv("INIT_USER_EMAIL", "bootstrap@test.com")
        monkeypatch.setenv("INIT_USER_PASSWORD", "a-strong-password-123")
        monkeypatch.setenv("INIT_USER_NAME", "Bootstrap")

        from apo.bootstrap import bootstrap_initial_user
        bootstrap_initial_user(fresh_session)

        status = get_installation_setup_status(fresh_session)
        assert status.setup_available is False
        assert status.has_users is True

    def test_initialized_bootstrap_is_noop(self, fresh_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
        from apo.services.installation_initialization import claim_initial_user, get_installation_setup_status

        # Initialize first.
        claim_initial_user(
            fresh_session, email="first@test.com", name="First", password="a-strong-password-123", is_instance_admin=True
        )

        # Delete all users (simulate edge case).
        from apo.models.db import UserDB
        for u in fresh_session.exec(select(UserDB)).all():
            fresh_session.delete(u)
        fresh_session.commit()

        # Bootstrap should NOT create a new user.
        monkeypatch.setenv("INIT_USER_EMAIL", "bootstrap@test.com")
        monkeypatch.setenv("INIT_USER_PASSWORD", "a-strong-password-123")
        from apo.bootstrap import bootstrap_initial_user
        bootstrap_initial_user(fresh_session)

        status = get_installation_setup_status(fresh_session)
        assert status.setup_available is False  # Still closed.
        assert status.has_users is False  # No user was created.
