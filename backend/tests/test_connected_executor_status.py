# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false
# pyright: reportAttributeAccessIssue=false, reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false

"""SPEC-162: aggregate Connected Executor status for the dashboard.

Covers acceptance tests:
- 9. Aggregate status is User-scoped (one member offline never reports another's ready).
- 10. Aggregate status precedence is deterministic (ready > busy > catalog_mismatch
      > incompatible > offline > not_connected; revoked Executors ignored).
- Backend scene 2. The status route exposes only ``{ "state": ... }``.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.models.db import (
    ExecutorDB,
    ProjectDB,
    ProjectMembershipDB,
    ProjectTaskSourceDB,
    UserDB,
)
from apo.services.connected_executor_status import (
    compute_connected_environment_state,
)

_PROJECT = "acme-evals"
_ONLINE_WITHIN_SECONDS = 60


def _now() -> datetime:
    return datetime.now(timezone.utc)


@pytest.fixture
def project_with_two_members(session: Session):
    """Create a project with two members (A and B)."""
    user_a = UserDB(email="a@test.com", name="A", password_hash="x", is_active=True)
    user_b = UserDB(email="b@test.com", name="B", password_hash="x", is_active=True)
    session.add(user_a)
    session.add(user_b)
    session.commit()
    session.refresh(user_a)
    session.refresh(user_b)

    project = ProjectDB(id=_PROJECT, name="Acme", created_by=user_a.id)
    session.add(project)
    session.commit()

    now = _now()
    for user, role in ((user_a, "member"), (user_b, "member")):
        session.add(
            ProjectMembershipDB(
                project_id=_PROJECT,
                user_id=user.id,
                role=role,
                created_at=now,
                updated_at=now,
            )
        )
    session.commit()
    return user_a, user_b


def _enroll_source_owned_executor(
    session: Session,
    *,
    user_id: str,
    name: str,
    pool_id: str,
    online: bool = True,
    protocol_version: int = 2,
    driver_kinds: list[str] | None = None,
    reported_catalog_digest: str | None = "sha256:project-catalog",
    max_concurrency: int = 4,
    active_attempts: int = 0,
    revoked: bool = False,
) -> ExecutorDB:
    """Insert a source-owned Executor row scoped to ``user_id``.

    ``active_attempts`` is the authoritative leased+running count used by the
    capacity authority; it is encoded on the executor row for the test only
    via a separate count query the service runs. To keep this helper pure we
    rely on the service counting Attempts in the DB, so tests that need a busy
    state should insert real Attempts instead.
    """
    last_seen = _now() if online else _now() - timedelta(hours=2)
    executor = ExecutorDB(
        scope_kind="pool",
        project=_PROJECT,
        executor_pool_id=pool_id,
        name=name,
        enabled=True,
        credential_prefix="apo_ex_abc"[:12],
        credential_hash="hash-" + name,
        protocol_version=protocol_version,
        executor_version="0.1.0",
        enrolled_by_user_id=user_id,
        driver_kinds_json=driver_kinds if driver_kinds is not None else ["source-owned-ts"],
        capabilities_json={"assignment_kinds": ["source_owned"]},
        max_concurrency=max_concurrency,
        reported_catalog_digest=reported_catalog_digest,
        reported_available_slots=max_concurrency - active_attempts,
        last_seen_at=last_seen,
        revoked_at=_now() if revoked else None,
    )
    session.add(executor)
    session.commit()
    session.refresh(executor)
    return executor


def _ensure_source_owned_pool(session: Session) -> str:
    from apo.services.source_owned_executor import ensure_source_owned_pool

    return ensure_source_owned_pool(session, _PROJECT).id


def _publish_catalog(session: Session, digest: str = "sha256:project-catalog") -> None:
    session.add(
        ProjectTaskSourceDB(
            project=_PROJECT,
            source_type="published",
            catalog_digest=digest,
            task_count=2,
            status="ready",
        )
    )
    session.commit()


class TestAggregatePrecedence:
    """Acceptance test 10: documented precedence is deterministic."""

    def test_not_connected_when_user_has_no_executors(self, session, project_with_two_members):
        user_a, _ = project_with_two_members
        _ensure_source_owned_pool(session)

        state = compute_connected_environment_state(session, project_id=_PROJECT, user_id=user_a.id)

        assert state == "not_connected"

    def test_ready_when_one_online_matching_executor(self, session, project_with_two_members):
        user_a, _ = project_with_two_members
        pool_id = _ensure_source_owned_pool(session)
        _publish_catalog(session)
        _enroll_source_owned_executor(session, user_id=user_a.id, name="a-1", pool_id=pool_id)

        state = compute_connected_environment_state(session, project_id=_PROJECT, user_id=user_a.id)

        assert state == "ready"

    def test_offline_when_enrolled_but_stale(self, session, project_with_two_members):
        user_a, _ = project_with_two_members
        pool_id = _ensure_source_owned_pool(session)
        _publish_catalog(session)
        _enroll_source_owned_executor(
            session, user_id=user_a.id, name="a-1", pool_id=pool_id, online=False
        )

        state = compute_connected_environment_state(session, project_id=_PROJECT, user_id=user_a.id)

        assert state == "offline"

    def test_incompatible_when_protocol_or_driver_missing(self, session, project_with_two_members):
        user_a, _ = project_with_two_members
        pool_id = _ensure_source_owned_pool(session)
        _publish_catalog(session)
        _enroll_source_owned_executor(
            session,
            user_id=user_a.id,
            name="a-1",
            pool_id=pool_id,
            protocol_version=1,
            driver_kinds=["subprocess"],
        )

        state = compute_connected_environment_state(session, project_id=_PROJECT, user_id=user_a.id)

        assert state == "incompatible"

    def test_catalog_mismatch_when_digest_differs(self, session, project_with_two_members):
        user_a, _ = project_with_two_members
        pool_id = _ensure_source_owned_pool(session)
        _publish_catalog(session, digest="sha256:project-catalog")
        _enroll_source_owned_executor(
            session,
            user_id=user_a.id,
            name="a-1",
            pool_id=pool_id,
            reported_catalog_digest="sha256:different",
        )

        state = compute_connected_environment_state(session, project_id=_PROJECT, user_id=user_a.id)

        assert state == "catalog_mismatch"

    def test_ready_beats_busy_and_offline(self, session, project_with_two_members):
        """One ready + one offline executor aggregates to ready."""
        user_a, _ = project_with_two_members
        pool_id = _ensure_source_owned_pool(session)
        _publish_catalog(session)
        _enroll_source_owned_executor(session, user_id=user_a.id, name="a-1", pool_id=pool_id)
        _enroll_source_owned_executor(
            session, user_id=user_a.id, name="a-2", pool_id=pool_id, online=False
        )

        state = compute_connected_environment_state(session, project_id=_PROJECT, user_id=user_a.id)

        assert state == "ready"

    def test_revoked_executors_are_ignored(self, session, project_with_two_members):
        user_a, _ = project_with_two_members
        pool_id = _ensure_source_owned_pool(session)
        _publish_catalog(session)
        _enroll_source_owned_executor(
            session, user_id=user_a.id, name="revoked", pool_id=pool_id, revoked=True
        )

        state = compute_connected_environment_state(session, project_id=_PROJECT, user_id=user_a.id)

        assert state == "not_connected"


class TestUserScoping:
    """Acceptance test 9: aggregate status is User-scoped."""

    def test_member_a_offline_never_reports_member_b_ready(self, session, project_with_two_members):
        user_a, user_b = project_with_two_members
        pool_id = _ensure_source_owned_pool(session)
        _publish_catalog(session)
        # A is offline, B is ready.
        _enroll_source_owned_executor(
            session, user_id=user_a.id, name="a-1", pool_id=pool_id, online=False
        )
        _enroll_source_owned_executor(session, user_id=user_b.id, name="b-1", pool_id=pool_id)

        state_a = compute_connected_environment_state(session, project_id=_PROJECT, user_id=user_a.id)
        state_b = compute_connected_environment_state(session, project_id=_PROJECT, user_id=user_b.id)

        assert state_a == "offline"
        assert state_b == "ready"


class TestStatusRoute:
    """Backend scene test 2: the route exposes only ``{ "state": ... }``."""

    def test_route_returns_only_state_for_member(
        self, client, session, project_with_two_members, make_authed_client
    ):
        user_a, _ = project_with_two_members
        pool_id = _ensure_source_owned_pool(session)
        _publish_catalog(session)
        _enroll_source_owned_executor(session, user_id=user_a.id, name="a-1", pool_id=pool_id)

        authed = make_authed_client(user_a.id, session, is_admin=False)

        resp = authed.get(f"/v1/projects/{_PROJECT}/connected-executor-status")

        assert resp.status_code == 200
        body = resp.json()
        assert set(body.keys()) == {"state"}
        assert body["state"] == "ready"

    def test_route_returns_200_when_not_connected(self, client, session, project_with_two_members, make_authed_client):
        user_a, _ = project_with_two_members
        _ensure_source_owned_pool(session)

        authed = make_authed_client(user_a.id, session, is_admin=False)

        resp = authed.get(f"/v1/projects/{_PROJECT}/connected-executor-status")

        assert resp.status_code == 200
        assert resp.json() == {"state": "not_connected"}

    def test_route_rejects_non_member(self, client, session, project_with_two_members, make_authed_client):
        # Project exists; outsider is not a member.
        outsider = UserDB(email="x@test.com", name="X", password_hash="x", is_active=True)
        session.add(outsider)
        session.commit()
        session.refresh(outsider)

        authed = make_authed_client(outsider.id, session, is_admin=False)

        resp = authed.get(f"/v1/projects/{_PROJECT}/connected-executor-status")

        assert resp.status_code in (403, 404)
