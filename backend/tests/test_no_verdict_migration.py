# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false

"""v49 migration: the run-level no-verdict rule on pre-#323 rows.

v48 moved judge-errored checks into ``errored_checks`` but left the verdict;
v49 turns runs whose only non-passing checks are judge errors into no-verdict
runs exactly as finalization now would, and re-rolls their batches.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timezone

import pytest
from _pytest.monkeypatch import MonkeyPatch
from sqlalchemy.engine import Engine
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import apo.db as apo_db
from apo.models.db import AgentTaskBatchRunDB, AgentTaskJudgmentDB, AgentTaskRunDB
from apo.services.check_report_storage import is_judge_no_verdict_run


@pytest.fixture(name="engine")
def engine_fixture() -> Iterator[Engine]:
    test_engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(test_engine)
    yield test_engine


def _run(
    run_id: str,
    *,
    failed: int,
    errored: int,
    error_message: str | None = None,
    generation_execution: dict[str, object] | None = None,
) -> AgentTaskRunDB:
    now = datetime.now(timezone.utc)
    return AgentTaskRunDB(
        id=run_id,
        batch_run_id="batch-1",
        task_id=run_id,
        task_path="/t",
        status="failed",
        pass_result=False,
        started_at=now,
        completed_at=now,
        total_checks=3,
        passed_checks=3 - failed - errored,
        failed_checks=failed,
        errored_checks=errored,
        error_message=error_message,
        generation_execution_json=generation_execution,
    )


def test_v49_applies_the_no_verdict_rule(engine: Engine, monkeypatch: MonkeyPatch) -> None:
    assert apo_db.LATEST_SCHEMA_VERSION == 49
    assert apo_db._SCHEMA_MIGRATIONS[49] is apo_db._migrate_to_v49
    with Session(engine) as session:
        session.add(
            AgentTaskBatchRunDB(
                id="batch-1",
                project="p1",
                status="completed",
                total_tasks=3,
                failed_tasks=3,
                selection_type="task",
                created_at=datetime.now(timezone.utc),
            )
        )
        session.flush()
        session.add(_run("run-outage", failed=0, errored=1, error_message="adapter note"))
        session.add(_run("run-genuine", failed=1, errored=1))
        session.add(
            _run(
                "run-generations",
                failed=0,
                errored=1,
                generation_execution={"total": 4, "errored": 3, "error_finish_reasons": {}},
            )
        )
        session.add(
            AgentTaskJudgmentDB(
                id="jdg_1",
                task_run_id="run-outage",
                project="p1",
                trigger="rejudge",
                samples=1,
                pass_result=False,
                total_checks=3,
                passed_checks=2,
                failed_checks=0,
                errored_checks=1,
            )
        )
        session.commit()

    monkeypatch.setattr(apo_db, "engine", engine)
    apo_db._migrate_to_v49()
    apo_db._migrate_to_v49()  # idempotent

    with Session(engine) as session:
        outage = session.get(AgentTaskRunDB, "run-outage")
        assert outage is not None
        assert outage.status == "error"
        assert outage.pass_result is None
        assert outage.error_message == (
            "No verdict: 1 of 3 checks got no verdict from the judge "
            "(judge error or no judge configured); the other 2 passed.\nadapter note"
        )
        # Correctable / re-judgeable like a freshly finalized one.
        assert is_judge_no_verdict_run(outage)

        genuine = session.get(AgentTaskRunDB, "run-genuine")
        assert genuine is not None
        assert (genuine.status, genuine.pass_result) == ("failed", False)

        generations = session.get(AgentTaskRunDB, "run-generations")
        assert generations is not None
        assert generations.status == "failed"

        batch = session.get(AgentTaskBatchRunDB, "batch-1")
        assert batch is not None
        assert (batch.failed_tasks, batch.errored_tasks) == (2, 1)

        judgment = session.get(AgentTaskJudgmentDB, "jdg_1")
        assert judgment is not None
        assert judgment.pass_result is None
