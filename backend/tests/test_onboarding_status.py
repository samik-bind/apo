# pyright: reportAny=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnusedCallResult=false, reportUnusedParameter=false, reportAttributeAccessIssue=false, reportUntypedFunctionDecorator=false, reportUnknownParameterType=false, reportUnusedImport=false, reportUnknownVariableType=false, reportCallIssue=false

"""SPEC-180: bounded Project onboarding-status projection.

Answers exactly one question — has this Project published Tasks or
recorded Runs — with two scalars. Loads no Run, Trace, Check, Deliverable,
or Task Definition bodies, and is guarded by the canonical SPEC-178
Project authorizer.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.models.db import (
    AgentTaskBatchRunDB,
    ProjectTaskSourceDB,
    AgentTaskRunDB,
    ProjectDB,
    ProjectMembershipDB,
    ProjectTaskInventoryDB,
    UserDB,
)


def _seed_project(session: Session, email: str) -> tuple[UserDB, ProjectDB]:
    user = UserDB(email=email, name="Owner", password_hash="x", is_active=True)
    session.add(user)
    session.commit()
    session.refresh(user)
    project = ProjectDB(id=f"proj-{uuid4().hex[:8]}", name="P", created_by=user.id)
    session.add(project)
    session.add(
        ProjectMembershipDB(project_id=project.id, user_id=user.id, role="owner")
    )
    session.commit()
    session.refresh(project)
    return user, project


def _add_run(session: Session, project_id: str) -> None:
    batch = AgentTaskBatchRunDB(
        id=f"bch_{uuid4().hex[:12]}",
        project=project_id,
        selection_type="manual",
        trigger="manual",
        status="completed",
    )
    session.add(batch)
    session.commit()
    session.add(
        AgentTaskRunDB(
            id=f"run_{uuid4().hex[:16]}",
            batch_run_id=batch.id,
            task_id="t",
            task_path="t",
            status="passed",
        )
    )
    session.commit()


class TestOnboardingStatus:
    def test_empty_project_reports_zero_counts(
        self,
        session: Session,
        make_authed_client: Any,
        monkeypatch: Any,
    ) -> None:
        monkeypatch.setenv("APO_PUBLIC_URL", "https://public.example.com")
        user, project = _seed_project(session, "owner@example.com")
        client: TestClient = make_authed_client(user.id, session)

        resp = client.get(f"/v1/projects/{project.id}/onboarding-status")

        assert resp.status_code == 200
        body = resp.json()
        assert body["published_task_count"] == 0
        assert body["recorded_run_count"] == 0
        assert body["public_url"] == "https://public.example.com"

    def test_counts_reflect_inventory_and_runs(
        self, session: Session, make_authed_client: Any
    ) -> None:
        user, project = _seed_project(session, "owner@example.com")
        session.add(
            ProjectTaskSourceDB(
                id="src-x",
                project=project.id,
                source_type="filesystem",
                display_name="Tasks",
                status="ready",
            )
        )
        session.commit()
        session.add(
            ProjectTaskInventoryDB(
                project=project.id,
                task_source_id="src-x",
                task_id="a",
                display_name="A",
                folder_path="f",
                task_path="a/task.eval.ts",
                source_type="filesystem",
            )
        )
        session.commit()
        _add_run(session, project.id)
        _add_run(session, project.id)
        client: TestClient = make_authed_client(user.id, session)

        resp = client.get(f"/v1/projects/{project.id}/onboarding-status")

        assert resp.status_code == 200
        body = resp.json()
        assert body["published_task_count"] == 1
        assert body["recorded_run_count"] == 2

    def test_counts_do_not_leak_across_projects(
        self, session: Session, make_authed_client: Any
    ) -> None:
        user, project = _seed_project(session, "owner@example.com")
        _, other = _seed_project(session, "other@example.com")
        session.add(
            ProjectTaskSourceDB(
                id="src-x",
                project=other.id,
                source_type="filesystem",
                display_name="Tasks",
                status="ready",
            )
        )
        session.commit()
        session.add(
            ProjectTaskInventoryDB(
                project=other.id,
                task_source_id="src-x",
                task_id="a",
                display_name="A",
                folder_path="f",
                task_path="a/task.eval.ts",
                source_type="filesystem",
            )
        )
        session.commit()
        _add_run(session, other.id)
        client: TestClient = make_authed_client(user.id, session)

        resp = client.get(f"/v1/projects/{project.id}/onboarding-status")

        assert resp.status_code == 200
        body = resp.json()
        assert body["published_task_count"] == 0
        assert body["recorded_run_count"] == 0

    def test_non_member_is_forbidden(
        self, session: Session, make_authed_client: Any
    ) -> None:
        _user, project = _seed_project(session, "owner@example.com")
        outsider = UserDB(
            email="out@example.com", name="O", password_hash="x", is_active=True
        )
        session.add(outsider)
        session.commit()
        session.refresh(outsider)
        client: TestClient = make_authed_client(outsider.id, session)

        resp = client.get(f"/v1/projects/{project.id}/onboarding-status")

        assert resp.status_code == 403

    def test_api_key_bound_to_other_project_is_forbidden(
        self, session: Session, make_api_key_client: Any
    ) -> None:
        user, project = _seed_project(session, "owner@example.com")
        _, other = _seed_project(session, "other@example.com")
        client: TestClient = make_api_key_client(user.id, other.id, session)

        resp = client.get(f"/v1/projects/{project.id}/onboarding-status")

        assert resp.status_code == 403
