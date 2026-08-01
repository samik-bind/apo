# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownLambdaType=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUntypedFunctionDecorator=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false, reportMissingTypeArgument=false, reportArgumentType=false

"""Cancellation routes + pool/default APIs + v14 schedule migration."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from apo.db import LATEST_SCHEMA_VERSION, _SCHEMA_MIGRATIONS, _migrate_schedule_pool_schema
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ExecutorDB,
    ExecutorPoolDB,
    ProjectDB,
    TaskExecutionAttemptDB,
    TaskRevisionDB,
)
from sqlmodel import create_engine


def test_latest_schema_version_has_registered_migration() -> None:
    """A schema bump must ship with its migration registered, so the latest
    version is always reachable. Pinning the literal version broke on every
    bump — assert the invariant instead."""
    assert LATEST_SCHEMA_VERSION in _SCHEMA_MIGRATIONS


def test_v14_adds_schedule_pool_columns() -> None:
    eng = create_engine("sqlite://")
    with eng.begin() as conn:
        conn.exec_driver_sql("CREATE TABLE agent_task_schedules (id VARCHAR PRIMARY KEY)")
        _migrate_schedule_pool_schema(conn)
        cols = {r[1] for r in conn.exec_driver_sql("PRAGMA table_info(agent_task_schedules)").all()}
        assert "executor_pool_id" in cols
        assert "queue_ttl_seconds" in cols
        assert "disabled_reason" in cols
        idx = {r[1] for r in conn.exec_driver_sql("PRAGMA index_list(agent_task_schedules)").all()}
        assert "ix_agent_task_schedules_executor_pool_id" in idx


def test_v14_is_idempotent() -> None:
    eng = create_engine("sqlite://")
    with eng.begin() as conn:
        conn.exec_driver_sql("CREATE TABLE agent_task_schedules (id VARCHAR PRIMARY KEY)")
        _migrate_schedule_pool_schema(conn)
        _migrate_schedule_pool_schema(conn)


# ── cancellation routes ───────────────────────────────────────────────────


def _seed_batch_with_attempt(
    session, *, project_id: str = "proj-c", status: str = "queued"
) -> TaskExecutionAttemptDB:
    session.add(ProjectDB(id=project_id, name=project_id, created_at=datetime.now(timezone.utc)))
    session.flush()
    session.add(ExecutorPoolDB(
        id="pool-c", project=project_id, name="P", slug="p", kind="bundled",
        enabled=True, created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    ))
    session.flush()
    session.add(AgentTaskBatchRunDB(
        id="b-c", project=project_id, selection_type="single", status="queued",
        created_at=datetime.now(timezone.utc),
    ))
    session.flush()
    session.add(AgentTaskRunDB(
        id="r-c", batch_run_id="b-c", task_id="t", task_path="t", sequence_index=0,
        status="pending",
    ))
    session.flush()
    session.add(TaskRevisionDB(
        id="rev", project=project_id, batch_run_id="b-c", materialization="bundled",
        source_type="filesystem", content_sha256="c" * 64, file_count=1,
        uncompressed_size_bytes=1, manifest_summary_json={"fileCount": 1},
        created_at=datetime.now(timezone.utc),
    ))
    session.flush()
    att = TaskExecutionAttemptDB(
        id="a-c", project=project_id, batch_run_id="b-c", task_run_id="r-c",
        task_revision_id="rev", sequence_index=0, target_kind="pool",
        executor_pool_id="pool-c", status=status,
        queue_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        queued_at=datetime.now(timezone.utc),
    )
    session.add(att)
    session.commit()
    return att


def test_cancel_queued_attempt(client: object, session) -> None:
    _seed_batch_with_attempt(session, status="queued")
    r = client.post("/v1/agent-task-runs/r-c/cancel")  # type: ignore[attr-defined]
    assert r.status_code == 200
    att = session.get(TaskExecutionAttemptDB, "a-c")
    assert att is not None and att.status == "cancelled"


def test_cancel_batch_cancels_all_attempts(client: object, session) -> None:
    _seed_batch_with_attempt(session, status="queued")
    r = client.post("/v1/agent-task-batch-runs/b-c/cancel")  # type: ignore[attr-defined]
    assert r.status_code == 200
    assert r.json()["cancelled"] == 1
    att = session.get(TaskExecutionAttemptDB, "a-c")
    assert att is not None and att.status == "cancelled"


def test_cancel_is_idempotent(client: object, session) -> None:
    _seed_batch_with_attempt(session, status="queued")
    client.post("/v1/agent-task-runs/r-c/cancel")  # type: ignore[attr-defined]
    r = client.post("/v1/agent-task-runs/r-c/cancel")  # type: ignore[attr-defined]
    assert r.status_code == 200


# ── pool/default APIs ─────────────────────────────────────────────────────


def test_list_executor_pools_returns_health(client: object, session) -> None:
    session.add(ProjectDB(id="p-l", name="p-l", created_at=datetime.now(timezone.utc)))
    session.flush()
    session.add(ExecutorPoolDB(
        id="pool-l", project="p-l", name="List", slug="list", kind="bundled",
        enabled=True, created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    ))
    session.commit()
    r = client.get("/v1/projects/p-l/executor-pools")  # type: ignore[attr-defined]
    assert r.status_code == 200, r.text
    pools = r.json()["pools"]
    assert len(pools) == 1
    assert pools[0]["id"] == "pool-l"
    assert pools[0]["health"] in ("online", "offline", "disabled")


def test_set_default_executor_pool(client: object, session) -> None:
    session.add(ProjectDB(id="p-d", name="p-d", created_at=datetime.now(timezone.utc)))
    session.flush()
    session.add(ExecutorPoolDB(
        id="pool-d", project="p-d", name="Default", slug="default", kind="bundled",
        enabled=True, created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    ))
    session.commit()
    r = client.put("/v1/projects/p-d/default-executor-pool", json={"pool_id": "pool-d"})  # type: ignore[attr-defined]
    assert r.status_code == 200, r.text
    assert r.json()["default_executor_pool_id"] == "pool-d"
