# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false

"""SPEC-179 phase 4a: backfill legacy deliverables_json columns into rows."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlmodel import Session, select

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskDeliverableDB,
    AgentTaskRunDB,
)


def _seed_run(
    session: Session, run_id: str, deliverables_json: dict[str, object] | None
) -> None:
    now = datetime.now(timezone.utc)
    session.add(
        AgentTaskBatchRunDB(
            id=f"batch-{run_id}", project="p1", created_at=now,
            status="completed", total_tasks=1, task_root="/t",
            environment="default", selection_type="task",
        )
    )
    session.flush()
    session.add(
        AgentTaskRunDB(
            id=run_id, batch_run_id=f"batch-{run_id}", task_id=run_id,
            task_path=f"/t/{run_id}", status="passed", pass_result=True,
            started_at=now, completed_at=now, deliverables_json=deliverables_json,
        )
    )
    session.commit()


def test_backfill_converts_column_blob_into_rows(session: Session) -> None:
    from apo.services.agent_task_deliverables import (
        backfill_deliverable_rows_from_column,
    )

    _seed_run(
        session,
        "run-bf-1",
        {"report": {"answer": 42}, "stats": {"n": 3}},
    )

    created = backfill_deliverable_rows_from_column(session)
    assert created == 2

    rows = session.exec(
        select(AgentTaskDeliverableDB).where(
            AgentTaskDeliverableDB.task_run_id == "run-bf-1"
        )
    ).all()
    by_name = {r.name: r for r in rows}
    assert set(by_name) == {"report", "stats"}
    assert by_name["report"].kind == "json"
    assert by_name["report"].status == "ready"
    assert by_name["report"].project == "p1"
    assert by_name["report"].inline_value_json == {"value": {"answer": 42}}
    # The legacy column is intentionally left intact for the phase-4b drop.
    fresh = session.exec(
        select(AgentTaskRunDB).where(AgentTaskRunDB.id == "run-bf-1")
    ).first()
    assert fresh is not None
    assert fresh.deliverables_json == {"report": {"answer": 42}, "stats": {"n": 3}}


def test_backfill_is_idempotent_and_skips_runs_with_rows(
    session: Session,
) -> None:
    from apo.services.agent_task_deliverables import (
        backfill_deliverable_rows_from_column,
    )

    _seed_run(session, "run-bf-2", {"only": {"v": 1}})
    assert backfill_deliverable_rows_from_column(session) == 1
    # Second pass: rows exist, nothing to do.
    assert backfill_deliverable_rows_from_column(session) == 0

    # A run whose column is NULL is never touched.
    _seed_run(session, "run-bf-3", None)
    assert backfill_deliverable_rows_from_column(session) == 0


def test_backfill_skips_invalid_legacy_names(session: Session) -> None:
    from apo.services.agent_task_deliverables import (
        backfill_deliverable_rows_from_column,
    )

    _seed_run(session, "run-bf-4", {"ok": {"v": 1}, "": {"v": 2}})
    created = backfill_deliverable_rows_from_column(session)
    assert created == 1
    rows = session.exec(
        select(AgentTaskDeliverableDB).where(
            AgentTaskDeliverableDB.task_run_id == "run-bf-4"
        )
    ).all()
    assert [r.name for r in rows] == ["ok"]
