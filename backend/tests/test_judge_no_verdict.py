"""Issue #323: a run whose only non-passing checks are judge errors has no verdict.

The judge never answering is not the agent failing. Finalization, human
corrections, and judgments all derive the verdict through the same rule:
``failed_checks == 0`` and ``errored_checks > 0`` → status ``error``,
``pass_result`` None, and an ``error_message`` naming the cause.
"""

# pyright: reportAny=false, reportMissingParameterType=false, reportUnknownParameterType=false
# pyright: reportUnusedCallResult=false, reportAttributeAccessIssue=false
# pyright: reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB, ProjectDB, UserDB
from apo.services.agent_task_runner import finalize_task_run_with_result
from apo.services.check_report_storage import (
    judge_no_verdict_message,
    persist_check_report,
)
from apo.services.judgments import create_judgment, synthesize_original_judgment
from apo.services.test_result_corrections import (
    CorrectionActor,
    CorrectionError,
    correct_test_result,
)

NOW = datetime.now(timezone.utc)
ACTOR = CorrectionActor(user_id="u1", label="u1@test.com", via="session", api_key_id=None)

JUDGE_ERROR: dict[str, object] = {
    "id": "blacked-out",
    "pass": False,
    "outcome": "error",
    "reasoning": "judge failed: 504 gateway timeout",
    "assertions": [{"id": "judge", "pass": False, "outcome": "error"}],
}


def _passing(n: int) -> list[dict[str, object]]:
    return [{"id": f"ok-{i}", "pass": True, "reasoning": "ok"} for i in range(n)]


def _seed(session: Session, *, status: str = "running") -> tuple[AgentTaskBatchRunDB, AgentTaskRunDB]:
    if not session.get(UserDB, "u1"):
        session.add(UserDB(id="u1", email="u1@test.com", name="U1", password_hash="x"))
    if not session.get(ProjectDB, "p1"):
        session.add(ProjectDB(id="p1", name="P1", created_by="u1"))
    session.flush()
    batch = AgentTaskBatchRunDB(
        id="b1", project="p1", selection_type="task", status="running", created_at=NOW
    )
    run = AgentTaskRunDB(
        id="r1",
        batch_run_id="b1",
        task_id="demo",
        task_path="/tasks/demo",
        status=status,
        started_at=NOW,
    )
    session.add(batch)
    session.flush()
    session.add(run)
    session.commit()
    return batch, run


def _finalize(
    session: Session,
    run: AgentTaskRunDB,
    batch: AgentTaskBatchRunDB,
    checks: list[dict[str, object]],
) -> None:
    finalize_task_run_with_result(
        session,
        run,
        batch,
        adapter_name="fixture",
        pass_result=False,
        trace_run_id=None,
        checks=checks,
        transcript=None,
        deliverables=None,
    )
    session.commit()


class TestMessage:
    def test_names_cause_and_the_rest(self) -> None:
        assert judge_no_verdict_message(total_checks=12, failed_checks=0, errored_checks=1) == (
            "No verdict: 1 of 12 checks got no answer from the judge (judge error); "
            "the other 11 passed."
        )

    def test_all_errored(self) -> None:
        assert judge_no_verdict_message(total_checks=1, failed_checks=0, errored_checks=1) == (
            "No verdict: 1 of 1 check got no answer from the judge (judge error)."
        )

    def test_genuine_fail_keeps_verdict(self) -> None:
        assert judge_no_verdict_message(total_checks=3, failed_checks=1, errored_checks=1) is None

    def test_no_errored_check_keeps_verdict(self) -> None:
        assert judge_no_verdict_message(total_checks=3, failed_checks=0, errored_checks=0) is None


class TestFinalize:
    def test_only_judge_errors_is_no_verdict(self, session: Session) -> None:
        batch, run = _seed(session)
        _finalize(session, run, batch, [*_passing(11), JUDGE_ERROR])

        assert run.status == "error"
        assert run.pass_result is None
        assert run.errored_checks == 1
        assert run.failed_checks == 0
        assert run.error_message == (
            "No verdict: 1 of 12 checks got no answer from the judge (judge error); "
            "the other 11 passed."
        )

    def test_genuine_fail_beside_judge_error_is_failed(self, session: Session) -> None:
        batch, run = _seed(session)
        _finalize(
            session,
            run,
            batch,
            [JUDGE_ERROR, {"id": "bad", "pass": False, "reasoning": "missing table"}],
        )

        assert run.status == "failed"
        assert run.pass_result is False

    def test_unsupported_counts_as_genuine_non_pass(self, session: Session) -> None:
        batch, run = _seed(session)
        _finalize(
            session,
            run,
            batch,
            [JUDGE_ERROR, {"id": "no-trace", "pass": False, "outcome": "unsupported"}],
        )

        assert run.status == "failed"
        assert run.pass_result is False

    def test_executor_error_keeps_its_message(self, session: Session) -> None:
        batch, run = _seed(session)
        finalize_task_run_with_result(
            session,
            run,
            batch,
            adapter_name="fixture",
            pass_result=False,
            trace_run_id=None,
            checks=[JUDGE_ERROR],
            transcript=None,
            deliverables=None,
            errored=True,
            error_message="adapter crashed",
        )

        assert run.status == "error"
        assert run.error_message == "adapter crashed"


class TestCorrections:
    @pytest.fixture
    def no_verdict_run(self, session: Session) -> AgentTaskRunDB:
        batch, run = _seed(session)
        _finalize(session, run, batch, [*_passing(2), JUDGE_ERROR])
        assert run.status == "error"
        return run

    def test_set_pass_on_errored_check_makes_run_passed(
        self, session: Session, no_verdict_run: AgentTaskRunDB
    ) -> None:
        result = correct_test_result(
            session,
            task_run=no_verdict_run,
            project="p1",
            test_id="blacked-out",
            action="set_pass",
            reason="read the deliverable; it is there",
            actor=ACTOR,
        )

        assert result.run_status == "passed"
        assert result.run_pass_result is True
        session.refresh(no_verdict_run)
        assert no_verdict_run.status == "passed"
        assert no_verdict_run.error_message is None
        assert no_verdict_run.errored_checks == 0
        batch = session.get(AgentTaskBatchRunDB, "b1")
        assert batch is not None
        assert (batch.passed_tasks, batch.errored_tasks) == (1, 0)

    def test_set_fail_on_errored_check_makes_run_failed(
        self, session: Session, no_verdict_run: AgentTaskRunDB
    ) -> None:
        result = correct_test_result(
            session,
            task_run=no_verdict_run,
            project="p1",
            test_id="blacked-out",
            action="set_fail",
            reason="read the deliverable; it is missing",
            actor=ACTOR,
        )

        assert result.run_status == "failed"
        assert result.run_pass_result is False
        session.refresh(no_verdict_run)
        assert no_verdict_run.failed_checks == 1
        assert no_verdict_run.error_message is None

    def test_clear_restores_no_verdict(
        self, session: Session, no_verdict_run: AgentTaskRunDB
    ) -> None:
        correct_test_result(
            session,
            task_run=no_verdict_run,
            project="p1",
            test_id="blacked-out",
            action="set_pass",
            reason="read the deliverable; it is there",
            actor=ACTOR,
        )
        result = correct_test_result(
            session,
            task_run=no_verdict_run,
            project="p1",
            test_id="blacked-out",
            action="clear",
            reason=None,
            actor=ACTOR,
        )

        assert result.run_status == "error"
        assert result.run_pass_result is None
        session.refresh(no_verdict_run)
        assert no_verdict_run.error_message is not None
        assert no_verdict_run.error_message.startswith("No verdict:")
        batch = session.get(AgentTaskBatchRunDB, "b1")
        assert batch is not None
        assert batch.errored_tasks == 1

    def test_correcting_the_only_fail_to_pass_leaves_no_verdict(
        self, session: Session
    ) -> None:
        batch, run = _seed(session)
        _finalize(
            session,
            run,
            batch,
            [JUDGE_ERROR, {"id": "bad", "pass": False, "reasoning": "judge misread"}],
        )
        assert run.status == "failed"

        result = correct_test_result(
            session,
            task_run=run,
            project="p1",
            test_id="bad",
            action="set_pass",
            reason="the judge misread the table",
            actor=ACTOR,
        )

        assert result.run_status == "error"
        assert result.run_pass_result is None

    def test_executor_error_run_stays_uncorrectable(self, session: Session) -> None:
        batch, run = _seed(session)
        finalize_task_run_with_result(
            session,
            run,
            batch,
            adapter_name="fixture",
            pass_result=False,
            trace_run_id=None,
            checks=[{"id": "bad", "pass": False, "reasoning": "x"}],
            transcript=None,
            deliverables=None,
            errored=True,
            error_message="adapter crashed",
        )
        session.commit()

        with pytest.raises(CorrectionError) as exc:
            correct_test_result(
                session,
                task_run=run,
                project="p1",
                test_id="bad",
                action="set_pass",
                reason="it is fine really",
                actor=ACTOR,
            )
        assert exc.value.kind == "run_not_correctable"


class TestJudgments:
    def test_original_judgment_has_no_verdict(self, session: Session) -> None:
        batch, run = _seed(session)
        _finalize(session, run, batch, [*_passing(1), JUDGE_ERROR])

        original = synthesize_original_judgment(session, run)

        assert original.pass_result is None
        assert original.errored_checks == 1

    def test_rejudge_judgment_has_no_verdict(self, session: Session) -> None:
        _batch, run = _seed(session, status="passed")
        judgment = create_judgment(
            session,
            task_run=run,
            project="p1",
            label=None,
            judge_model=None,
            judge_base_url=None,
            task_definition_revision_id=None,
            samples=1,
            checks=[*_passing(1), JUDGE_ERROR],
            stability=None,
        )

        assert judgment.pass_result is None

    def test_rejudge_with_genuine_fail_is_false(self, session: Session) -> None:
        _batch, run = _seed(session, status="passed")
        judgment = create_judgment(
            session,
            task_run=run,
            project="p1",
            label=None,
            judge_model=None,
            judge_base_url=None,
            task_definition_revision_id=None,
            samples=1,
            checks=[JUDGE_ERROR, {"id": "bad", "pass": False}],
            stability=None,
        )

        assert judgment.pass_result is False

    def test_no_verdict_run_can_be_rejudged(self, client: TestClient, session: Session) -> None:
        batch, run = _seed(session)
        _finalize(session, run, batch, [*_passing(1), JUDGE_ERROR])

        response = client.post(
            f"/v1/agent-task-runs/{run.id}/judgments",
            json={"checks": [*_passing(1), {**JUDGE_ERROR, "pass": True, "outcome": None}]},
        )

        assert response.status_code == 201, response.text
        assert response.json()["pass_result"] is True

    def test_executor_error_run_cannot_be_rejudged(
        self, client: TestClient, session: Session
    ) -> None:
        _batch, run = _seed(session, status="error")

        response = client.post(
            f"/v1/agent-task-runs/{run.id}/judgments",
            json={"checks": _passing(1)},
        )

        assert response.status_code == 409


def test_persisted_run_scalars_drive_the_rule(session: Session) -> None:
    """persist_check_report's buckets are the rule's inputs: an ``unsupported``
    check lands in failed_checks, a judge error in errored_checks."""
    _batch, run = _seed(session)
    persist_check_report(
        session, run, [JUDGE_ERROR, {"id": "u", "pass": False, "outcome": "unsupported"}]
    )
    assert (run.failed_checks, run.errored_checks) == (1, 1)
