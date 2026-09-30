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
    caller_error_message,
    is_judge_no_verdict_run,
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


def _seed(
    session: Session,
    *,
    status: str = "running",
    run_id: str = "r1",
    batch_id: str = "b1",
) -> tuple[AgentTaskBatchRunDB, AgentTaskRunDB]:
    if not session.get(UserDB, "u1"):
        session.add(UserDB(id="u1", email="u1@test.com", name="U1", password_hash="x"))
    if not session.get(ProjectDB, "p1"):
        session.add(ProjectDB(id="p1", name="P1", created_by="u1"))
    session.flush()
    batch = AgentTaskBatchRunDB(
        id=batch_id, project="p1", selection_type="task", status="running", created_at=NOW
    )
    run = AgentTaskRunDB(
        id=run_id,
        batch_run_id=batch_id,
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
    *,
    errored: bool = False,
    error_message: str | None = None,
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
        errored=errored,
        error_message=error_message,
    )
    session.commit()


RULE_1_OF_3 = (
    "No verdict: 1 of 3 checks got no verdict from the judge "
    "(judge error or no judge configured); the other 2 passed."
)


class TestMessage:
    def test_names_cause_and_the_rest(self) -> None:
        assert judge_no_verdict_message(total_checks=12, failed_checks=0, errored_checks=1) == (
            "No verdict: 1 of 12 checks got no verdict from the judge "
            "(judge error or no judge configured); the other 11 passed."
        )

    def test_all_errored(self) -> None:
        assert judge_no_verdict_message(total_checks=1, failed_checks=0, errored_checks=1) == (
            "No verdict: 1 of 1 check got no verdict from the judge "
            "(judge error or no judge configured)."
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
        assert run.no_verdict_reason == "judge"
        assert run.errored_checks == 1
        assert run.failed_checks == 0
        assert run.error_message == (
            "No verdict: 1 of 12 checks got no verdict from the judge "
            "(judge error or no judge configured); the other 11 passed."
        )

    def test_verdict_clears_a_stale_reason(self, session: Session) -> None:
        """Whatever a row carried before, a run that gets a verdict has no
        no-verdict reason."""
        batch, run = _seed(session)
        run.no_verdict_reason = "judge"
        _finalize(session, run, batch, [JUDGE_ERROR, {"id": "bad", "pass": False}])

        assert run.status == "failed"
        assert run.no_verdict_reason is None

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
        assert run.no_verdict_reason is None

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

    def test_caller_message_is_kept_after_the_rule(self, session: Session) -> None:
        batch, run = _seed(session)
        _finalize(session, run, batch, [*_passing(2), JUDGE_ERROR], error_message="adapter note")

        assert run.status == "error"
        assert run.error_message == f"{RULE_1_OF_3}\nadapter note"
        assert is_judge_no_verdict_run(run)

    def test_generation_rule_takes_precedence(self, session: Session) -> None:
        """#149 is checked before the judge rule: a generation-dominated run
        keeps the generation message even when only judge errors failed."""
        batch, run = _seed(session)
        run.generation_execution_json = {
            "total": 4,
            "errored": 3,
            "error_finish_reasons": {"error": 3},
        }
        _finalize(session, run, batch, [*_passing(2), JUDGE_ERROR])

        assert run.status == "error"
        assert run.error_message is not None
        assert run.error_message.startswith("3 of 4 generations ended in error")
        assert run.no_verdict_reason == "generations"
        assert not is_judge_no_verdict_run(run)

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
        assert run.no_verdict_reason == "executor"


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
        assert no_verdict_run.no_verdict_reason is None
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

    def test_executor_error_with_judge_error_checks_is_uncorrectable(
        self, session: Session
    ) -> None:
        """An executor-errored run (#13) can carry judge-error-only counts —
        it is still not a judge no-verdict run: its message is the executor's."""
        batch, run = _seed(session)
        _finalize(
            session,
            run,
            batch,
            [*_passing(2), JUDGE_ERROR],
            errored=True,
            error_message="adapter crashed",
        )
        assert (run.failed_checks, run.errored_checks) == (0, 1)
        assert not is_judge_no_verdict_run(run)

        with pytest.raises(CorrectionError) as exc:
            correct_test_result(
                session,
                task_run=run,
                project="p1",
                test_id="blacked-out",
                action="set_pass",
                reason="it is fine really",
                actor=ACTOR,
            )
        assert exc.value.kind == "run_not_correctable"
        assert run.error_message == "adapter crashed"

    def test_corrections_never_erase_a_caller_message(self, session: Session) -> None:
        batch, run = _seed(session)
        _finalize(
            session,
            run,
            batch,
            [*_passing(1), JUDGE_ERROR, {"id": "bad", "pass": False, "reasoning": "x"}],
            error_message="adapter note",
        )
        assert (run.status, run.error_message) == ("failed", "adapter note")

        correct_test_result(
            session,
            task_run=run,
            project="p1",
            test_id="bad",
            action="set_pass",
            reason="the judge misread it",
            actor=ACTOR,
        )
        assert run.status == "error"
        assert run.error_message == f"{RULE_1_OF_3}\nadapter note"

        correct_test_result(
            session,
            task_run=run,
            project="p1",
            test_id="bad",
            action="clear",
            reason=None,
            actor=ACTOR,
        )
        assert (run.status, run.error_message) == ("failed", "adapter note")

    def test_counts_split_failed_and_errored(
        self, session: Session, no_verdict_run: AgentTaskRunDB
    ) -> None:
        batch, run = _seed(session, run_id="r2", batch_id="b2")
        _finalize(
            session,
            run,
            batch,
            [JUDGE_ERROR, {"id": "bad", "pass": False}, *_passing(1)],
        )
        result = correct_test_result(
            session,
            task_run=run,
            project="p1",
            test_id="ok-0",
            action="set_pass",
            reason="reaffirming the pass",
            actor=ACTOR,
        )
        assert (result.failed_tests, result.errored_tests) == (1, 1)
        assert result.failed_tests == run.failed_checks

    def test_idempotent_retry_persists_the_projection(
        self, session: Session, no_verdict_run: AgentTaskRunDB
    ) -> None:
        def correct() -> None:
            correct_test_result(
                session,
                task_run=no_verdict_run,
                project="p1",
                test_id="blacked-out",
                action="set_pass",
                reason="read the deliverable; it is there",
                actor=ACTOR,
            )

        correct()
        # Simulate drift, then retry: the retry re-derives and commits.
        no_verdict_run.corrected_tests = 0
        batch = session.get(AgentTaskBatchRunDB, "b1")
        assert batch is not None
        batch.passed_tasks = 0
        session.commit()

        correct()
        session.expire_all()

        run = session.get(AgentTaskRunDB, "r1")
        batch = session.get(AgentTaskBatchRunDB, "b1")
        assert run is not None and batch is not None
        assert run.status == "passed"
        assert run.corrected_tests == 1
        assert batch.passed_tasks == 1

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

    def test_executor_error_with_judge_error_checks_cannot_be_rejudged(
        self, client: TestClient, session: Session
    ) -> None:
        batch, run = _seed(session)
        _finalize(
            session,
            run,
            batch,
            [*_passing(1), JUDGE_ERROR],
            errored=True,
            error_message="adapter crashed",
        )

        response = client.post(
            f"/v1/agent-task-runs/{run.id}/judgments",
            json={"checks": _passing(2)},
        )

        assert response.status_code == 409

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


def test_gate_reads_the_structured_reason_not_the_message() -> None:
    """The gate keys on ``no_verdict_reason``: the rule's own message on an
    executor (#13) or #149 run is not a judge no-verdict."""
    run = AgentTaskRunDB(
        id="r9",
        batch_run_id="b9",
        task_id="t",
        task_path="/t",
        status="error",
        pass_result=None,
        total_checks=3,
        passed_checks=2,
        failed_checks=0,
        errored_checks=1,
        error_message=RULE_1_OF_3,
        no_verdict_reason="generations",
    )
    assert not is_judge_no_verdict_run(run)
    run.no_verdict_reason = "executor"
    assert not is_judge_no_verdict_run(run)
    run.no_verdict_reason = None
    assert not is_judge_no_verdict_run(run)
    run.no_verdict_reason = "judge"
    run.error_message = "anything — the message is display-only"
    assert is_judge_no_verdict_run(run)
    # A stored verdict wins over a stale reason.
    run.pass_result = False
    assert not is_judge_no_verdict_run(run)
    run.pass_result = None
    # The counts must still satisfy the rule.
    run.failed_checks = 1
    assert not is_judge_no_verdict_run(run)


# --- review-c probes, ported: each asserted a defect; these assert the fix ---


def test_executor_error_whose_message_is_the_rule_is_not_a_judge_no_verdict(
    session: Session,
) -> None:
    batch, run = _seed(session)
    _finalize(
        session, run, batch, [*_passing(2), JUDGE_ERROR], errored=True,
        error_message=RULE_1_OF_3 + "\nadapter crashed afterwards",
    )
    assert run.status == "error"
    assert run.no_verdict_reason == "executor"
    assert not is_judge_no_verdict_run(run)


def test_caller_message_keeps_its_leading_newlines(session: Session) -> None:
    batch, run = _seed(session)
    _finalize(session, run, batch, [*_passing(2), JUDGE_ERROR], error_message="\n\nindented note")
    assert caller_error_message(run) == "\n\nindented note"


def test_no_verdict_to_pass_to_clear_keeps_the_caller_message(session: Session) -> None:
    """A corrected PASS keeps the executor's note, so a later clear restores
    the no-verdict run with it — a correction never drops caller data."""
    batch, run = _seed(session)
    _finalize(session, run, batch, [*_passing(2), JUDGE_ERROR], error_message="adapter note")
    assert run.error_message == f"{RULE_1_OF_3}\nadapter note"
    correct_test_result(
        session, task_run=run, project="p1", test_id="blacked-out",
        action="set_pass", reason="human verified this is correct", actor=ACTOR,
    )
    assert (run.status, run.error_message) == ("passed", "adapter note")
    correct_test_result(
        session, task_run=run, project="p1", test_id="blacked-out",
        action="clear", reason=None, actor=ACTOR,
    )
    assert (run.status, run.no_verdict_reason) == ("error", "judge")
    assert run.error_message == f"{RULE_1_OF_3}\nadapter note"


def test_failed_to_pass_to_clear_keeps_the_caller_message(session: Session) -> None:
    batch, run = _seed(session)
    _finalize(
        session, run, batch,
        [*_passing(2), {"id": "bad", "pass": False, "reasoning": "x"}],
        error_message="adapter note",
    )
    assert (run.status, run.error_message) == ("failed", "adapter note")
    correct_test_result(
        session, task_run=run, project="p1", test_id="bad",
        action="set_pass", reason="human verified this is correct", actor=ACTOR,
    )
    assert (run.status, run.error_message) == ("passed", "adapter note")
    correct_test_result(
        session, task_run=run, project="p1", test_id="bad",
        action="clear", reason=None, actor=ACTOR,
    )
    assert (run.status, run.error_message) == ("failed", "adapter note")


def test_run_payloads_expose_the_reason(client: TestClient, session: Session) -> None:
    """Detail, list and batch payloads carry ``no_verdict_reason`` — the field
    the CLI, SDK and dashboard read instead of the message."""
    batch, run = _seed(session)
    _finalize(session, run, batch, [*_passing(2), JUDGE_ERROR])

    detail = client.get(f"/v1/agent-task-runs/{run.id}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["no_verdict_reason"] == "judge"

    listed = client.get("/v1/agent-task-runs", params={"project": "p1"})
    assert listed.status_code == 200, listed.text
    assert [r["no_verdict_reason"] for r in listed.json()] == ["judge"]

    batch_detail = client.get(f"/v1/agent-task-batch-runs/{batch.id}")
    assert batch_detail.status_code == 200, batch_detail.text
    assert batch_detail.json()["task_runs"][0]["no_verdict_reason"] == "judge"
