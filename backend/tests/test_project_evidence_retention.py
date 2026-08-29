# pyright: reportAny=false, reportAttributeAccessIssue=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUnusedParameter=false

"""Per-project evidence retention: tri-state setting, window resolution,
and the PATCH authorization."""

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskCheckReportDB,
    AgentTaskRunDB,
    ProjectDB,
    UserDB,
)
from apo.services.project_memberships import create_owner_membership
from apo.services.retention import (
    effective_evidence_days,
    expire_run_evidence,
    project_evidence_windows,
)
from tests.conftest import engine as test_engine
from tests.test_maintenance_cleanup import _make_user

NOW = datetime.now(timezone.utc)


def _seed_project(session: Session, project_id: str, *, owner: UserDB) -> None:
    session.add(ProjectDB(id=project_id, name=project_id, created_by=owner.id))
    session.commit()
    create_owner_membership(session, project_id, owner.id)


def _seed_old_run(session: Session, project_id: str, run_id: str) -> None:
    session.add(
        AgentTaskBatchRunDB(
            id=f"b-{run_id}",
            project=project_id,
            selection_type="task",
            task_root="/tmp",
            environment="default",
            status="completed",
            created_at=NOW - timedelta(days=30),
        )
    )
    session.commit()
    session.add(
        AgentTaskRunDB(
            id=run_id,
            batch_run_id=f"b-{run_id}",
            task_id="t",
            task_path="/tmp/t",
            status="passed",
            pass_result=True,
            transcript_json={"turns": ["..."]},
            started_at=NOW - timedelta(days=30),
            completed_at=NOW - timedelta(days=30),
        )
    )
    session.commit()
    session.add(AgentTaskCheckReportDB(run_id=run_id, value_json=[{"c": 1}], created_at=NOW))
    session.commit()


class TestWindowResolution:
    def test_effective_days_tri_state(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("APO_EVIDENCE_RETENTION_DAYS", raising=False)
        assert effective_evidence_days(None) == 0  # inherit: default off
        monkeypatch.setenv("APO_EVIDENCE_RETENTION_DAYS", "30")
        assert effective_evidence_days(None) == 30  # inherit a set default
        assert effective_evidence_days(0) == 0  # explicit forever beats default
        assert effective_evidence_days(7) == 7  # override beats default

    def test_project_windows_override_and_forever(
        self, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        owner = _make_user(session, "win@t.dev")
        _seed_project(session, "p-inherit", owner=owner)
        _seed_project(session, "p-override", owner=owner)
        _seed_project(session, "p-forever", owner=owner)
        _seed_project(session, "demo", owner=owner)
        inherit = session.get(ProjectDB, "p-inherit")
        override = session.get(ProjectDB, "p-override")
        forever = session.get(ProjectDB, "p-forever")
        assert inherit is not None and override is not None and forever is not None
        inherit.evidence_retention_days = None
        override.evidence_retention_days = 7
        forever.evidence_retention_days = 0
        session.add_all([inherit, override, forever])
        session.commit()

        monkeypatch.setenv("APO_EVIDENCE_RETENTION_DAYS", "30")
        windows = project_evidence_windows(session)

        # Inherit picks up the default; override wins; forever and
        # default-off drop out; demo never appears.
        assert windows == {"p-inherit": 30, "p-override": 7}

    def test_expiry_uses_each_projects_own_window(self, session: Session) -> None:
        owner = _make_user(session, "exp@t.dev")
        _seed_project(session, "p-short", owner=owner)
        _seed_project(session, "p-long", owner=owner)
        short = session.get(ProjectDB, "p-short")
        long_p = session.get(ProjectDB, "p-long")
        assert short is not None and long_p is not None
        short.evidence_retention_days = 7
        long_p.evidence_retention_days = 90
        session.add_all([short, long_p])
        session.commit()
        _seed_old_run(session, "p-short", "r-short")
        _seed_old_run(session, "p-long", "r-long")

        summary = asyncio.run(expire_run_evidence(session, NOW))

        assert summary["runs_affected"] == 1  # only the 7-day window matched
        assert session.get(AgentTaskCheckReportDB, "r-short") is None
        assert session.get(AgentTaskCheckReportDB, "r-long") is not None


class TestPatchEndpoint:
    def test_tri_state_roundtrip(
        self, client: TestClient, session: Session
    ) -> None:
        owner = _make_user(session, "patch@t.dev")
        _seed_project(session, "p-patch", owner=owner)

        # Explicit window.
        resp = client.patch(
            "/v1/projects/p-patch", json={"evidence_retention_days": 14}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["evidence_retention_days"] == 14
        assert resp.json()["effective_evidence_retention_days"] == 14

        # Forever override.
        resp = client.patch(
            "/v1/projects/p-patch", json={"evidence_retention_days": 0}
        )
        assert resp.status_code == 200
        assert resp.json()["evidence_retention_days"] == 0

        # Back to inherit (explicit null, distinct from absent).
        resp = client.patch(
            "/v1/projects/p-patch", json={"evidence_retention_days": None, "name": "p-patch"}
        )
        assert resp.status_code == 200
        assert resp.json()["evidence_retention_days"] is None

        # Absent leaves the value unchanged (name-only patch).
        project = session.get(ProjectDB, "p-patch")
        assert project is not None
        project.evidence_retention_days = 21
        session.add(project)
        session.commit()
        resp = client.patch("/v1/projects/p-patch", json={"name": "p-patch"})
        assert resp.status_code == 200
        assert resp.json()["evidence_retention_days"] == 21

    def test_rejects_out_of_range(
        self, client: TestClient, session: Session
    ) -> None:
        owner = _make_user(session, "range@t.dev")
        _seed_project(session, "p-range", owner=owner)
        for bad in (-1, 3651):
            resp = client.patch(
                "/v1/projects/p-range", json={"evidence_retention_days": bad}
            )
            assert resp.status_code == 422 or resp.status_code == 400, bad

    def test_member_cannot_change(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        from apo.models.db import ProjectMembershipDB

        owner = _make_user(session, "mem-owner@t.dev")
        _seed_project(session, "p-member", owner=owner)
        member = _make_user(session, "member@t.dev")
        now = NOW
        session.add(
            ProjectMembershipDB(
                project_id="p-member",
                user_id=member.id,
                role="member",
                created_at=now,
                updated_at=now,
            )
        )
        session.commit()
        authed = make_authed_client(member.id, session)

        resp = authed.patch(
            "/v1/projects/p-member", json={"evidence_retention_days": 7}
        )

        assert resp.status_code == 403
        project = session.get(ProjectDB, "p-member")
        assert project is not None and project.evidence_retention_days is None

    def test_demo_rejected(self, client: TestClient, session: Session) -> None:
        owner = _make_user(session, "demo@t.dev")
        _seed_project(session, "demo", owner=owner)
        resp = client.patch(
            "/v1/projects/demo", json={"evidence_retention_days": 7}
        )
        assert resp.status_code in (400, 403)


class TestMaintenanceWiring:
    def test_maintenance_uses_project_override_not_env(
        self, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from apo.services import retention

        owner = _make_user(session, "maint@t.dev")
        _seed_project(session, "p-maint", owner=owner)
        project = session.get(ProjectDB, "p-maint")
        assert project is not None
        project.evidence_retention_days = 7
        session.add(project)
        session.commit()
        _seed_old_run(session, "p-maint", "r-maint")
        monkeypatch.setattr(retention, "engine", test_engine)
        monkeypatch.setattr(retention, "is_sqlite", lambda: False)
        monkeypatch.setattr(retention, "RETENTION_DAYS", 0)
        # The env default says keep everything; the project override wins.
        monkeypatch.delenv("APO_EVIDENCE_RETENTION_DAYS", raising=False)

        summary = retention.run_maintenance_cleanup()

        assert summary["runs_affected"] == 1
        assert session.get(AgentTaskCheckReportDB, "r-maint") is None
