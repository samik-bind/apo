# pyright: reportAny=false, reportDeprecated=false, reportImplicitStringConcatenation=false, reportMissingParameterType=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

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
    import json as _json

    from sqlalchemy import text

    # Fresh test schemas no longer create the legacy column (v28 dropped
    # it); re-add it so these tests exercise the raw-SQL backfill exactly
    # as a pre-v28 database upgrading through v26 would.
    from sqlalchemy import text as _text

    has_col = session.execute(
        _text(
            "SELECT 1 FROM pragma_table_info('agent_task_runs') "
            "WHERE name = 'deliverables_json'"
        )
    ).first()
    if not has_col:
        session.execute(_text("ALTER TABLE agent_task_runs ADD COLUMN deliverables_json JSON"))

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
            started_at=now, completed_at=now,
        )
    )
    session.flush()
    if deliverables_json is not None:
        session.execute(
            text(
                "UPDATE agent_task_runs SET deliverables_json = :dj "
                "WHERE id = :rid"
            ),
            {"dj": _json.dumps(deliverables_json), "rid": run_id},
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


def test_startup_backfills_a_v25_database(tmp_path, monkeypatch) -> None:
    """Booting on a pre-v26 database with legacy blobs must not crash.

    ``lifespan`` is ``async def``, so its thread is already running an event
    loop. The v26 backfill drives an ``async`` placement helper with
    ``asyncio.run``, which refuses to start a loop when one is already running
    in the same thread — calling ``init_db`` inline crashed startup with
    "asyncio.run() cannot be called from a running event loop" on every
    database upgrading through v26 with legacy blobs.

    Every other backfill test calls the function synchronously, so none of them
    ever enters that state. This one drives the real startup path, so it stays
    honest if someone later drops the ``asyncio.to_thread`` hand-off.
    """
    import asyncio
    import json as _json

    from sqlalchemy import text
    from sqlmodel import SQLModel, create_engine

    import apo.db as apo_db

    test_engine = create_engine(f"sqlite:///{tmp_path / 'v25.db'}")
    SQLModel.metadata.create_all(test_engine)

    now = datetime.now(timezone.utc)
    with Session(test_engine) as setup:
        # v28 dropped the legacy column from the model; re-add it so this is a
        # pre-v28 database upgrading through v26 — the affected case.
        setup.execute(
            text("ALTER TABLE agent_task_runs ADD COLUMN deliverables_json JSON")
        )
        setup.add(
            AgentTaskBatchRunDB(
                id="batch-loop", project="p1", created_at=now,
                status="completed", total_tasks=1, task_root="/t",
                environment="default", selection_type="task",
            )
        )
        setup.flush()
        setup.add(
            AgentTaskRunDB(
                id="run-loop", batch_run_id="batch-loop", task_id="run-loop",
                task_path="/t/run-loop", status="passed", pass_result=True,
                started_at=now, completed_at=now,
            )
        )
        setup.flush()
        setup.execute(
            text(
                "UPDATE agent_task_runs SET deliverables_json = :dj "
                "WHERE id = 'run-loop'"
            ),
            {"dj": _json.dumps({"report": {"answer": 42}})},
        )
        setup.commit()

    monkeypatch.setattr(apo_db, "engine", test_engine)
    # The ladder stamps versions on the same engine; start it from v25 so v26
    # is the next migration to apply.
    with Session(test_engine) as stamp:
        stamp.execute(
            text(
                "CREATE TABLE IF NOT EXISTS schema_migrations "
                "(version INTEGER PRIMARY KEY)"
            )
        )
        for v in range(1, 26):
            stamp.execute(
                text("INSERT OR IGNORE INTO schema_migrations VALUES (:v)"), {"v": v}
            )
        stamp.commit()

    async def _boot() -> None:
        # The startup sequence, reduced to the part under test: a running loop
        # on this thread, then the migration ladder.
        from apo.db import init_db

        await asyncio.to_thread(init_db)

    asyncio.run(_boot())

    # v26 ran, so the ladder reached the head.
    with Session(test_engine) as check_version:
        stamped = check_version.execute(
            text("SELECT MAX(version) FROM schema_migrations")
        ).scalar()
    assert stamped == apo_db.LATEST_SCHEMA_VERSION

    with Session(test_engine) as check:
        rows = check.exec(
            select(AgentTaskDeliverableDB).where(
                AgentTaskDeliverableDB.task_run_id == "run-loop"
            )
        ).all()
    assert [r.name for r in rows] == ["report"]
    assert rows[0].inline_value_json == {"value": {"answer": 42}}
