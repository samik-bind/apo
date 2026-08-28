"""Scene tests: the corrections route end-to-end against the app.

Covers the API contract (error kinds, status codes), the atomic Run/Batch
scalar flip while the raw Check Report stays recorded, auth matrix rejections,
idempotent retries, and retention/deletion of correction rows.
"""

# pyright: reportAny=false, reportMissingParameterType=false, reportUnknownParameterType=false
# pyright: reportUnusedCallResult=false, reportUnusedImport=false, reportAttributeAccessIssue=false
# pyright: reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false
# pyright: reportPrivateUsage=false

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    AgentTaskTestResultCorrectionDB,
    ProjectDB,
    ProjectMembershipDB,
    UserDB,
)
from apo.services.check_report_storage import persist_check_report
from apo.services.project_deletion import delete_project_data
from apo.services.retention import _delete_old_batch_runs
from apo.services.task_view_comparison import create_comparison

NOW = datetime.now(timezone.utc)


def _checks(
    passing: int = 2, failing: int = 1, judge_model: str | None = None
) -> list[dict[str, object]]:
    checks: list[dict[str, object]] = []
    for i in range(passing):
        checks.append({"id": f"pass-{i}", "pass": True, "reasoning": "passed"})
    for i in range(failing):
        entry: dict[str, object] = {
            "id": f"fail-{i}",
            "pass": False,
            "reasoning": "judge said no table",
        }
        if judge_model:
            entry["judge"] = {"model": judge_model, "response": '{"pass": false}'}
        checks.append(entry)
    return checks


def _seed_run(
    session: Session,
    *,
    run_id: str = "run-1",
    project: str = "p1",
    status: str = "failed",
    checks: list[dict[str, object]] | None = None,
    completed_at: datetime | None = NOW,
    with_report: bool = True,
) -> AgentTaskRunDB:
    if not session.get(UserDB, "u1"):
        session.add(UserDB(id="u1", email="u1@test.com", name="U1", password_hash="x"))
    if not session.get(ProjectDB, project):
        session.add(ProjectDB(id=project, name=f"Project {project}", created_by="u1"))
    session.flush()
    if (
        project != "demo"
        and session.exec(
            select(ProjectMembershipDB).where(
                ProjectMembershipDB.project_id == project,
                ProjectMembershipDB.user_id == "u1",
            )
        ).first()
        is None
    ):
        now = datetime.now(timezone.utc)
        session.add(
            ProjectMembershipDB(
                project_id=project, user_id="u1", role="owner",
                created_at=now, updated_at=now,
            )
        )
        session.flush()
    batch = AgentTaskBatchRunDB(
        id=f"batch-{run_id}",
        project=project,
        selection_type="task",
        status="completed",
        created_at=NOW,
    )
    session.add(batch)
    session.flush()
    run = AgentTaskRunDB(
        id=run_id,
        batch_run_id=batch.id,
        task_id="demo",
        task_path="/tasks/demo",
        status=status,
        pass_result=True if status == "passed" else (False if status == "failed" else None),
        started_at=NOW - timedelta(minutes=5),
        completed_at=completed_at,
        total_checks=len(checks or []) if with_report else 0,
        passed_checks=sum(1 for c in (checks or []) if c.get("pass") is True) if with_report else 0,
        failed_checks=sum(1 for c in (checks or []) if c.get("pass") is not True) if with_report else 0,
    )
    session.add(run)
    session.flush()
    if with_report:
        persist_check_report(session, run, checks or _checks())
    session.commit()
    return run


def _post(
    client: TestClient,
    run_id: str,
    test_id: str,
    action: str,
    reason: str | None = None,
) -> Any:
    return client.post(
        f"/v1/agent-task-runs/{run_id}/test-result-corrections",
        json={"test_id": test_id, "action": action, **({"reason": reason} if reason else {})},
    )


class TestHappyPath:
    def test_corrects_false_judge_failure_atomically(
        self, client: TestClient, session: Session
    ) -> None:
        run = _seed_run(session, checks=_checks(judge_model="orig/judge"))

        resp = _post(
            client, run.id, "fail-0", "set_pass",
            "Retention is present in the KPI table; judge missed it",
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["recorded_pass"] is False
        assert body["effective_pass"] is True
        assert body["run_status"] == "passed"
        assert body["passed_tests"] == 3
        assert body["corrected_tests"] == 1
        assert body["correction"]["corrected_via"] == "open_dev"
        assert body["correction"]["reason"].startswith("Retention is present")

        session.refresh(run)
        assert run.status == "passed"
        assert run.pass_result is True
        assert run.corrected_tests == 1
        batch = session.get(AgentTaskBatchRunDB, run.batch_run_id)
        assert batch is not None and batch.passed_tasks == 1

        # detail shows the EFFECTIVE projection: pass=True, recorded evidence intact
        detail = client.get(f"/v1/agent-task-runs/{run.id}").json()
        eff = next(c for c in detail["checks_json"] if c["id"] == "fail-0")
        assert eff["pass"] is True
        assert eff["recorded_pass"] is False
        # the stored Check Report itself still records the FAIL
        from apo.services.check_report_storage import load_check_report

        raw = load_check_report(session, run.id)
        assert raw is not None
        raw_fail = next(c for c in raw if c["id"] == "fail-0")
        assert raw_fail["pass"] is False
        assert "correction" not in raw_fail

    def test_detail_surfaces_effective_projection(
        self, client: TestClient, session: Session
    ) -> None:
        run = _seed_run(session)
        _post(client, run.id, "fail-0", "set_pass", "judge wrong about the table")

        detail = client.get(f"/v1/agent-task-runs/{run.id}").json()
        assert detail["corrected_tests"] == 1
        assert detail["status"] == "passed"
        assert detail["pass_result"] is True
        eff = next(c for c in detail["checks_json"] if c["id"] == "fail-0")
        assert eff["pass"] is True
        assert eff["recorded_pass"] is False
        assert eff["correction"]["reason"] == "judge wrong about the table"
        # open-dev actor has no user row; api-key actors resolve to email —
        # the label must never echo the raw user id as if it were a label.
        assert eff["correction"]["corrected_by_label"] is None

    def test_correcting_one_of_two_failures_keeps_run_failed(
        self, client: TestClient, session: Session
    ) -> None:
        run = _seed_run(session, checks=_checks(passing=1, failing=2))

        resp = _post(client, run.id, "fail-0", "set_pass", "first one is fine actually")
        assert resp.status_code == 200
        body = resp.json()
        assert body["run_status"] == "failed"
        assert body["passed_tests"] == 2
        assert body["failed_tests"] == 1
        assert body["corrected_tests"] == 1

    def test_fail_a_passing_run_flips_verdicts(
        self, client: TestClient, session: Session
    ) -> None:
        run = _seed_run(session, status="passed", checks=_checks(passing=3, failing=0))

        resp = _post(
            client, run.id, "pass-1", "set_fail",
            "The trace contains a failed payment call",
        )
        assert resp.status_code == 200
        assert resp.json()["run_status"] == "failed"
        session.refresh(run)
        assert run.status == "failed" and run.pass_result is False

    def test_clear_restores_recorded_result(
        self, client: TestClient, session: Session
    ) -> None:
        run = _seed_run(session)
        _post(client, run.id, "fail-0", "set_pass", "temporary pass")
        resp = _post(client, run.id, "fail-0", "clear")
        assert resp.status_code == 200
        body = resp.json()
        assert body["correction"] is None
        assert body["effective_pass"] is False
        assert body["corrected_tests"] == 0
        assert body["run_status"] == "failed"

    def test_original_judgment_stays_raw_after_correction(
        self, client: TestClient, session: Session
    ) -> None:
        run = _seed_run(session, checks=_checks(judge_model="orig/judge"))
        _post(client, run.id, "fail-0", "set_pass", "human says pass")

        judgments = client.get(f"/v1/agent-task-runs/{run.id}/judgments").json()
        original = next(j for j in judgments["judgments"] if j["trigger"] == "original")
        # synthesize_original_judgment derives from raw report, not effective scalars
        assert original["pass_result"] is False
        assert original["passed_checks"] == 2
        assert original["failed_checks"] == 1

    def test_idempotent_retry_does_not_append(
        self, client: TestClient, session: Session
    ) -> None:
        run = _seed_run(session)
        first = _post(client, run.id, "fail-0", "set_pass", "same reason text")
        second = _post(client, run.id, "fail-0", "set_pass", "  same reason text  ")
        assert first.status_code == 200 and second.status_code == 200
        rows = session.exec(select(AgentTaskTestResultCorrectionDB)).all()
        assert len(rows) == 1


class TestComparisonBoundary:
    def test_snapshot_created_before_correction_stays_unchanged(
        self, client: TestClient, session: Session
    ) -> None:
        run = _seed_run(session, checks=_checks())
        from apo.models.schemas import TaskViewConfig

        before = create_comparison(
            session, "p1", ["demo"], TaskViewConfig(), TaskViewConfig()
        )
        _post(client, run.id, "fail-0", "set_pass", "post-snapshot correction")

        after = client.get(
            f"/v1/projects/p1/task-view-comparisons/{before.id}/overview"
        )
        # snapshot JSON itself is frozen…
        assert after.status_code == 200
        cell = after.json()["snapshot"]["resolved"][0]
        assert cell["a_status"] == "failed"

    def test_later_comparison_freezes_effective_status(
        self, client: TestClient, session: Session
    ) -> None:
        _seed_run(session, checks=_checks())
        _post(client, "run-1", "fail-0", "set_pass", "before comparison")

        from apo.models.schemas import TaskViewConfig

        snapshot = create_comparison(
            session, "p1", ["demo"], TaskViewConfig(), TaskViewConfig()
        )
        cell = snapshot.resolved[0]
        assert cell.a_status == "passed"
        assert cell.a_pass_result is True


class TestAuthMatrix:
    def test_cross_project_caller_gets_opaque_404(
        self, make_api_key_client: Any, session: Session
    ) -> None:
        _seed_run(session)  # project p1
        outsider = make_api_key_client("u-outsider", "other-project", session)
        resp = _post(outsider, "run-1", "fail-0", "set_pass", "x" * 40)
        assert resp.status_code == 404

    def test_ingest_key_rejected(
        self, make_api_key_client: Any, session: Session
    ) -> None:
        _seed_run(session)
        ingest = make_api_key_client("u1", "p1", session, scope="ingest")
        resp = _post(ingest, "run-1", "fail-0", "set_pass", "x" * 40)
        assert resp.status_code == 403
        assert resp.json()["detail"]["kind"] == "full_scope_required"
        rows = session.exec(select(AgentTaskTestResultCorrectionDB)).all()
        assert rows == []

    def test_service_token_rejected(
        self, session: Session
    ) -> None:
        from fastapi import FastAPI
        from fastapi.testclient import TestClient as TC
        from starlette.middleware.base import BaseHTTPMiddleware
        from starlette.requests import Request as StarletteRequest
        from starlette.responses import Response as StarletteResponse

        from apo.api import app as root_app
        from apo.db import get_session

        _seed_run(session)

        class InjectServiceTokenMiddleware(BaseHTTPMiddleware):
            async def dispatch(
                self, request: StarletteRequest, call_next: Any
            ) -> StarletteResponse:
                request.state.auth_method = "service_token"
                request.state.project = "p1"
                request.state.service_task_run_id = "run-1"
                return await call_next(request)

        new_app = FastAPI()
        new_app.include_router(root_app.router)
        new_app.add_middleware(InjectServiceTokenMiddleware)
        new_app.dependency_overrides[get_session] = lambda: session
        tokened = TC(new_app)

        resp = _post(tokened, "run-1", "fail-0", "set_pass", "x" * 40)
        assert resp.status_code == 403
        assert resp.json()["detail"]["kind"] == "human_review_required"
        rows = session.exec(select(AgentTaskTestResultCorrectionDB)).all()
        assert rows == []


class TestActorLabels:
    def test_api_key_correction_resolves_creator_email(
        self, make_api_key_client: Any, session: Session
    ) -> None:
        _seed_run(session)
        keyed = make_api_key_client("u1", "p1", session)
        resp = _post(keyed, "run-1", "fail-0", "set_pass", "x" * 40)
        assert resp.status_code == 200
        assert resp.json()["correction"]["corrected_by_label"] == "u1@test.com"
        assert resp.json()["correction"]["corrected_via"] == "api_key"

        # the run detail path resolves the same label (bulk projection)
        detail = keyed.get("/v1/agent-task-runs/run-1").json()
        eff = next(c for c in detail["checks_json"] if c["id"] == "fail-0")
        assert eff["correction"]["corrected_by_label"] == "u1@test.com"


class TestErrorContract:
    def test_unknown_test_id(self, client: TestClient, session: Session) -> None:
        _seed_run(session)
        resp = _post(client, "run-1", "ghost", "set_pass", "x" * 40)
        assert resp.status_code == 404
        assert resp.json()["detail"]["kind"] == "test_result_not_found"

    def test_unknown_run(self, client: TestClient) -> None:
        resp = _post(client, "run-ghost", "any", "set_pass", "x" * 40)
        assert resp.status_code == 404

    def test_non_terminal_run(self, client: TestClient, session: Session) -> None:
        _seed_run(session, status="running", with_report=True, completed_at=None)
        resp = _post(client, "run-1", "pass-0", "set_pass", "x" * 40)
        assert resp.status_code == 409
        assert resp.json()["detail"]["kind"] == "run_not_correctable"

    def test_no_report_run(self, client: TestClient, session: Session) -> None:
        _seed_run(session, with_report=False)
        resp = _post(client, "run-1", "pass-0", "set_pass", "x" * 40)
        assert resp.status_code == 409
        assert resp.json()["detail"]["kind"] == "run_not_correctable"

    def test_bad_reason(self, client: TestClient, session: Session) -> None:
        _seed_run(session)
        resp = _post(client, "run-1", "fail-0", "set_pass", "no")
        assert resp.status_code == 422
        assert resp.json()["detail"]["kind"] == "reason_required"

    def test_clear_without_active(self, client: TestClient, session: Session) -> None:
        _seed_run(session)
        resp = _post(client, "run-1", "fail-0", "clear")
        assert resp.status_code == 409
        assert resp.json()["detail"]["kind"] == "no_active_correction"


class TestRetention:
    def test_old_batch_purge_removes_correction_rows(
        self, client: TestClient, session: Session
    ) -> None:
        old = datetime.now(timezone.utc) - timedelta(days=400)
        run = _seed_run(session, completed_at=old)
        batch = session.get(AgentTaskBatchRunDB, run.batch_run_id)
        assert batch is not None
        batch.created_at = old
        session.add(batch)
        session.commit()

        assert _post(client, run.id, "fail-0", "set_pass", "x" * 40).status_code == 200

        _delete_old_batch_runs(session, datetime.now(timezone.utc))
        rows = session.exec(select(AgentTaskTestResultCorrectionDB)).all()
        assert rows == []

    def test_project_deletion_removes_correction_rows(
        self, client: TestClient, session: Session
    ) -> None:
        run = _seed_run(session)
        assert _post(client, run.id, "fail-0", "set_pass", "x" * 40).status_code == 200

        delete_project_data(
            session, "p1", keep_project=False, keep_api_keys=False
        )
        rows = session.exec(select(AgentTaskTestResultCorrectionDB)).all()
        assert rows == []
