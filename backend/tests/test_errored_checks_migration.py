# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportReturnType=false, reportCallIssue=false

"""v48 migration backfill: the errored-checks bucket (issue #323).

Runs stored before v48 counted judge-errored checks as fails. The migration
recomputes the bucket from the stored evidence and moves those checks out of
``failed_checks``. Runs and judgments without errors are untouched.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timezone

import pytest
from _pytest.monkeypatch import MonkeyPatch
from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import apo.db as apo_db
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskCheckReportDB,
    AgentTaskJudgmentDB,
    AgentTaskRunDB,
    LoggedCallDB,
    OtlpSpanDB,
)


@pytest.fixture(name="engine")
def engine_fixture() -> Iterator[Engine]:
    test_engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    # create_all includes the new columns — the migration's column-add step is
    # an idempotent no-op here, so the test targets the backfill.
    SQLModel.metadata.create_all(test_engine)
    yield test_engine


def _seed_run(
    session: Session,
    *,
    run_id: str,
    status: str = "failed",
    pass_result: bool | None = False,
    total: int = 2,
    passed: int = 1,
    failed: int = 1,
    checks: list[dict[str, object]] | None = None,
) -> None:
    now = datetime.now(timezone.utc)
    session.add(
        AgentTaskRunDB(
            id=run_id,
            batch_run_id="batch-1",
            task_id=run_id,
            task_path="/t",
            status=status,
            pass_result=pass_result,
            started_at=now,
            completed_at=now,
            total_checks=total,
            passed_checks=passed,
            failed_checks=failed,
        )
    )
    if checks is not None:
        session.add(AgentTaskCheckReportDB(run_id=run_id, value_json=checks, created_at=now))


ERRORED_CHECK: dict[str, object] = {
    "id": "blacked-out",
    "pass": False,
    "outcome": "error",
    "reasoning": "judge failed: gateway timeout",
    "assertions": [{"id": "judge", "pass": False, "outcome": "error"}],
}


def test_backfill_moves_errored_checks_out_of_failed(
    engine: StaticPool, monkeypatch: MonkeyPatch
) -> None:
    with Session(engine) as session:
        session.add(
            AgentTaskBatchRunDB(
                id="batch-1",
                project="p1",
                status="completed",
                total_tasks=3,
                selection_type="task",
                created_at=datetime.now(timezone.utc),
            )
        )
        # Pre-v48 shape: the judge-errored check sits inside failed_checks.
        _seed_run(
            session,
            run_id="run-errored",
            checks=[
                {"id": "ok", "pass": True},
                ERRORED_CHECK,
            ],
        )
        # A genuine fail stays a fail; an all-pass run is skipped entirely.
        _seed_run(
            session,
            run_id="run-genuine",
            checks=[{"id": "nope", "pass": False}],
        )
        _seed_run(
            session,
            run_id="run-passed",
            status="passed",
            pass_result=True,
            total=1,
            passed=1,
            failed=0,
            checks=[{"id": "ok", "pass": True}],
        )
        # No report row — nothing to recompute, must not crash.
        _seed_run(session, run_id="run-no-report", checks=None)
        # A judgment with the same pre-v48 miscount.
        session.add(
            AgentTaskJudgmentDB(
                id="jdg_1",
                task_run_id="run-errored",
                project="p1",
                trigger="rejudge",
                samples=1,
                pass_result=False,
                total_checks=2,
                passed_checks=1,
                failed_checks=1,
                checks_json=[{"id": "ok", "pass": True}, ERRORED_CHECK],
            )
        )
        session.commit()

    monkeypatch.setattr(apo_db, "engine", engine)
    apo_db._migrate_to_v48()

    with Session(engine) as session:
        errored = session.get(AgentTaskRunDB, "run-errored")
        assert errored is not None
        assert errored.errored_checks == 1
        assert errored.failed_checks == 0
        assert errored.passed_checks == 1

        genuine = session.get(AgentTaskRunDB, "run-genuine")
        assert genuine is not None
        assert genuine.errored_checks == 0
        assert genuine.failed_checks == 1

        passed = session.get(AgentTaskRunDB, "run-passed")
        assert passed is not None
        assert passed.errored_checks == 0
        assert passed.passed_checks == 1

        no_report = session.get(AgentTaskRunDB, "run-no-report")
        assert no_report is not None
        assert no_report.failed_checks == 1

        judgment = session.get(AgentTaskJudgmentDB, "jdg_1")
        assert judgment is not None
        assert judgment.errored_checks == 1
        assert judgment.failed_checks == 0


def test_backfill_derives_outcome_from_legacy_assertions(
    engine: StaticPool, monkeypatch: MonkeyPatch
) -> None:
    """Reports recorded before the check-level outcome existed still backfill —
    the outcome is derived from the assertion breakdown."""
    with Session(engine) as session:
        session.add(
            AgentTaskBatchRunDB(
                id="batch-1",
                project="p1",
                status="completed",
                total_tasks=1,
                selection_type="task",
                created_at=datetime.now(timezone.utc),
            )
        )
        _seed_run(
            session,
            run_id="run-legacy",
            checks=[
                {
                    "id": "legacy",
                    "pass": False,
                    "assertions": [{"id": "judge", "pass": False, "outcome": "error"}],
                }
            ],
        )
        session.commit()

    monkeypatch.setattr(apo_db, "engine", engine)
    apo_db._migrate_to_v48()

    with Session(engine) as session:
        run = session.get(AgentTaskRunDB, "run-legacy")
        assert run is not None
        assert run.errored_checks == 1
        assert run.failed_checks == 0


def test_v47_and_v48_climb_without_later_columns(
    engine: StaticPool, monkeypatch: MonkeyPatch
) -> None:
    """A database upgrading through v47/v48 lacks the columns later rungs add
    (``errored_checks`` until v48 runs, ``no_verdict_reason`` until v50); the
    ORM loads in both backfills must not select them (issue #307)."""
    with Session(engine) as session:
        session.add(
            AgentTaskBatchRunDB(
                id="batch-1",
                project="p1",
                status="completed",
                total_tasks=1,
                selection_type="task",
                created_at=datetime.now(timezone.utc),
            )
        )
        _seed_run(
            session,
            run_id="run-errored",
            checks=[{"id": "ok", "pass": True}, ERRORED_CHECK],
        )
        session.commit()

    with engine.connect() as conn:
        # A trace link so v47's rollup backfill selects the run too.
        conn.exec_driver_sql("UPDATE agent_task_runs SET trace_run_id = 'trace-1'")
        for column in (
            "no_verdict_reason",
            "errored_checks",
            "total_reasoning_tokens",
            "max_call_reasoning_tokens",
            "max_call_reasoning_call_id",
            "max_call_latency_ms",
            "max_call_latency_call_id",
            "total_model_time_ms",
        ):
            conn.exec_driver_sql(f"ALTER TABLE agent_task_runs DROP COLUMN {column}")
        conn.commit()

    monkeypatch.setattr(apo_db, "engine", engine)
    apo_db._migrate_to_v47()
    apo_db._migrate_to_v48()

    with engine.connect() as conn:
        row = conn.exec_driver_sql(
            "SELECT failed_checks, errored_checks FROM agent_task_runs"
            " WHERE id = 'run-errored'"
        ).one()
    assert (row.failed_checks, row.errored_checks) == (0, 1)


def test_climb_v46_to_v50_loads_only_the_columns_it_reads(
    engine: StaticPool, monkeypatch: MonkeyPatch
) -> None:
    """The model classes declare columns a climbing database may not have.
    Drop ones no rung reads (``logged_calls.tool_name``,
    ``agent_task_judgments.stability_json``, ...): v47's logged-call load and
    v48's judgment load must select only what they use (issue #307)."""
    now = datetime(2026, 8, 1, tzinfo=timezone.utc)
    with Session(engine) as session:
        session.add(
            AgentTaskBatchRunDB(
                id="batch-1",
                project="p1",
                status="completed",
                total_tasks=1,
                selection_type="task",
                created_at=now,
            )
        )
        _seed_run(
            session,
            run_id="run-errored",
            checks=[{"id": "ok", "pass": True}, ERRORED_CHECK],
        )
        # g2's generation errored: reasoning skips it, latency keeps it; the
        # SPAN is not a generation at all.
        for call_id, latency, reasoning, observation_type in (
            ("g1", 1000.0, 50, "GENERATION"),
            ("g2", 4000.0, 900, "GENERATION"),
            ("t1", 99999.0, None, "SPAN"),
        ):
            session.add(
                LoggedCallDB(
                    id=call_id,
                    project="p1",
                    task_id="run-errored",
                    run_id="trace-1",
                    model="m",
                    observation_type=observation_type,
                    created_at=now,
                    latency_ms=latency,
                    cost=1,
                    raw_usage={"reasoning": reasoning} if reasoning else None,
                )
            )
        for span_id, status_code in (("g1", 1), ("g2", 2)):
            session.add(
                OtlpSpanDB(
                    project_id="p1",
                    trace_id="trace-1",
                    span_id=span_id,
                    span_name="gen",
                    status_code=status_code,
                    attributes={},
                    start_time=now,
                    end_time=now,
                )
            )
        session.add(
            AgentTaskJudgmentDB(
                id="jdg_1",
                task_run_id="run-errored",
                project="p1",
                trigger="rejudge",
                samples=1,
                pass_result=False,
                total_checks=2,
                passed_checks=1,
                failed_checks=1,
                checks_json=[{"id": "ok", "pass": True}, ERRORED_CHECK],
                created_at=now,
            )
        )
        session.commit()

    with engine.connect() as conn:
        conn.exec_driver_sql("UPDATE agent_task_runs SET trace_run_id = 'trace-1'")
        for column in (
            "no_verdict_reason",
            "errored_checks",
            "total_reasoning_tokens",
            "max_call_reasoning_tokens",
            "max_call_reasoning_call_id",
            "max_call_latency_ms",
            "max_call_latency_call_id",
            "total_model_time_ms",
        ):
            conn.exec_driver_sql(f"ALTER TABLE agent_task_runs DROP COLUMN {column}")
        conn.exec_driver_sql("ALTER TABLE agent_task_judgments DROP COLUMN errored_checks")
        # Model-declared columns no rung of the ladder reads.
        conn.exec_driver_sql("ALTER TABLE logged_calls DROP COLUMN tool_name")
        conn.exec_driver_sql("ALTER TABLE otlp_spans DROP COLUMN content_policy")
        conn.exec_driver_sql("ALTER TABLE agent_task_judgments DROP COLUMN stability_json")
        conn.exec_driver_sql("ALTER TABLE agent_task_check_reports DROP COLUMN created_at")
        conn.commit()

    monkeypatch.setattr(apo_db, "engine", engine)
    apo_db._migrate_to_v46()
    apo_db._migrate_to_v47()
    apo_db._migrate_to_v48()
    apo_db._migrate_to_v49()
    apo_db._migrate_to_v50()

    with engine.connect() as conn:
        run = conn.execute(
            text(
                "SELECT total_reasoning_tokens, max_call_reasoning_call_id,"
                " max_call_latency_ms, max_call_latency_call_id, total_model_time_ms,"
                " failed_checks, errored_checks, status, pass_result, no_verdict_reason"
                " FROM agent_task_runs WHERE id = 'run-errored'"
            )
        ).one()
        judgment = conn.execute(
            text(
                "SELECT failed_checks, errored_checks, pass_result"
                " FROM agent_task_judgments WHERE id = 'jdg_1'"
            )
        ).one()
    assert tuple(run) == (50, "g1", 4000.0, "g2", 5000.0, 0, 1, "error", None, "judge")
    assert tuple(judgment) == (0, 1, None)
