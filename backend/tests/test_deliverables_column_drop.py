# pyright: reportAny=false, reportDeprecated=false, reportImplicitStringConcatenation=false, reportMissingParameterType=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

"""SPEC-180 phase 4b: upgrade from a v25 database backfills, then drops the
legacy deliverables_json / checks_json columns."""

from __future__ import annotations

import json

from sqlalchemy import create_engine, text


def test_upgrade_from_v25_backfills_then_drops_columns(monkeypatch) -> None:
    from apo.db import _run_migrations, engine, LATEST_SCHEMA_VERSION
    from sqlmodel import SQLModel, Session

    assert LATEST_SCHEMA_VERSION >= 28

    test_engine = create_engine("sqlite://")
    monkeypatch.setattr("apo.db.engine", test_engine)
    SQLModel.metadata.create_all(test_engine)

    from datetime import datetime, timezone

    from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB

    with test_engine.begin() as conn:
        # Recreate the two legacy columns a v25 database still carries.
        conn.exec_driver_sql(
            "ALTER TABLE agent_task_runs ADD COLUMN checks_json JSON"
        )
        conn.exec_driver_sql(
            "ALTER TABLE agent_task_runs ADD COLUMN deliverables_json JSON"
        )
        # Stamp as v25: everything from v26 on must apply in order.
        conn.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)"
        )
        for v in range(1, 26):
            conn.execute(text("INSERT INTO schema_migrations VALUES (:v)"), {"v": v})

    now = datetime.now(timezone.utc)
    with Session(test_engine) as s:
        s.add(AgentTaskBatchRunDB(
            id="b1", project="p1", created_at=now, status="completed",
            total_tasks=1, task_root="/t", environment="default",
            selection_type="task",
        ))
        s.flush()
        s.add(AgentTaskRunDB(
            id="run-drop-1", batch_run_id="b1", task_id="t", task_path="p",
            status="passed", pass_result=True, started_at=now, completed_at=now,
        ))
        s.commit()
        s.execute(text(
            "UPDATE agent_task_runs SET deliverables_json = :dj "
            "WHERE id = 'run-drop-1'"
        ), {"dj": json.dumps({"report": {"answer": 42}})})
        s.commit()

    _run_migrations()

    with Session(test_engine) as session:
        rows = session.execute(text(
            "SELECT name, inline_value_json FROM agent_task_deliverables"
        )).all()
        assert rows == [("report", '{"value": {"answer": 42}}')] or (
            rows[0][0] == "report" and "answer" in rows[0][1]
        )
        cols = session.execute(text(
            "SELECT name FROM pragma_table_info('agent_task_runs')"
        )).all()
        names = {c[0] for c in cols}
        assert "deliverables_json" not in names
        assert "checks_json" not in names
    _ = engine
