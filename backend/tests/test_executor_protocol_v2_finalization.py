# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false
# pyright: reportAttributeAccessIssue=false, reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false

"""SPEC-161 v2 finalization routes (result / failure) alias the shared path.

Covers the new ``/v1/executor-protocol/v2/attempts/{id}/result`` and
``/failure`` routes that the Connected Executor's ``submitResult`` targets.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.api import app
from apo.db import get_session
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ProjectDB,
    TaskExecutionAttemptDB,
    UserDB,
)


@pytest.fixture
def isolated_engine(monkeypatch):
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, create_engine

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    import apo.db as db_module

    monkeypatch.setattr(db_module, "engine", engine)
    return engine


def _seed_leased_attempt(engine, attempt_jwt_sub: str = "att-1") -> tuple[str, str, str]:
    """Seed a leased source-owned Attempt and return (project, attempt_id, jwt)."""
    from apo.services.executor_auth import create_attempt_jwt

    with Session(engine) as s:
        u = UserDB(email="o@t.com", name="O", password_hash="x", is_active=True)
        s.add(u); s.commit(); s.refresh(u)
        s.add(ProjectDB(id="p1", name="P", created_by=u.id)); s.commit()
        batch = AgentTaskBatchRunDB(
            id="bch-1", project="p1", selection_type="tasks", status="queued",
            execution_target_json={"kind": "source_owned"}, created_at=datetime.now(timezone.utc),
        )
        s.add(batch); s.flush()
        run = AgentTaskRunDB(
            id="run-1", batch_run_id="bch-1", task_id="t", task_path="p",
            sequence_index=0, status="pending",
        )
        s.add(run); s.flush()
        attempt = TaskExecutionAttemptDB(
            id="att-1", project="p1", batch_run_id="bch-1", task_run_id="run-1",
            sequence_index=0, target_kind="pool", assignment_kind="source_owned",
            executor_pool_id="pool-1", status="running", phase="running",
            queue_expires_at=datetime.now(timezone.utc) + timedelta(hours=24),
            queued_at=datetime.now(timezone.utc),
            claimed_at=datetime.now(timezone.utc),
            started_at=datetime.now(timezone.utc),
            heartbeat_at=datetime.now(timezone.utc),
            lease_generation=1,
            lease_expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
        )
        s.add(attempt); s.commit()
        jwt = create_attempt_jwt(attempt=attempt, lease_generation=1, expires_in_seconds=3600)
        return "p1", "att-1", jwt


def _client(engine) -> TestClient:
    def _sess():
        with Session(engine) as sx:
            yield sx
    app.dependency_overrides[get_session] = _sess
    return TestClient(app)


def test_v2_result_finalizes_attempt(isolated_engine):
    engine = isolated_engine
    _, attempt_id, jwt = _seed_leased_attempt(engine)
    client = _client(engine)
    try:
        resp = client.post(
            f"/v1/executor-protocol/v2/attempts/{attempt_id}/result",
            headers={"Authorization": f"Bearer {jwt}"},
            json={
                "completion_id": "comp-1",
                "pass_result": True,
                "adapter_name": "claude-code",
                "trace_run_id": "tr-1",
            },
        )
        assert resp.status_code == 200, resp.text
        with Session(engine) as s:
            att = s.get(TaskExecutionAttemptDB, attempt_id)
            assert att is not None
            assert att.status == "succeeded"
            assert att.completion_id == "comp-1"
    finally:
        app.dependency_overrides.clear()


def test_v2_failure_finalizes_attempt(isolated_engine):
    engine = isolated_engine
    _, attempt_id, jwt = _seed_leased_attempt(engine)
    client = _client(engine)
    try:
        resp = client.post(
            f"/v1/executor-protocol/v2/attempts/{attempt_id}/failure",
            headers={"Authorization": f"Bearer {jwt}"},
            json={
                "completion_id": "comp-2",
                "failure_kind": "task_runtime",
                "error_message": "boom",
            },
        )
        assert resp.status_code == 200, resp.text
        with Session(engine) as s:
            att = s.get(TaskExecutionAttemptDB, attempt_id)
            assert att is not None
            assert att.status == "failed"
            assert att.failure_kind == "task_runtime"
    finally:
        app.dependency_overrides.clear()


def test_v2_result_rejects_wrong_attempt_token(isolated_engine):
    engine = isolated_engine
    _seed_leased_attempt(engine)
    # A token for a *different* attempt id.
    from apo.services.executor_auth import create_attempt_jwt

    with Session(engine) as s:
        other_run = AgentTaskRunDB(
            id="run-2", batch_run_id="bch-1", task_id="t2", task_path="p2",
            sequence_index=1, status="pending",
        )
        s.add(other_run); s.flush()
        other = TaskExecutionAttemptDB(
            id="att-2", project="p1", batch_run_id="bch-1", task_run_id="run-2",
            sequence_index=1, target_kind="pool", assignment_kind="source_owned",
            executor_pool_id="pool-1", status="running",
            queue_expires_at=datetime.now(timezone.utc) + timedelta(hours=24),
            queued_at=datetime.now(timezone.utc), lease_generation=1,
            lease_expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
        )
        s.add(other); s.commit()
        bad_jwt = create_attempt_jwt(attempt=other, lease_generation=1, expires_in_seconds=3600)

    client = _client(engine)
    try:
        resp = client.post(
            "/v1/executor-protocol/v2/attempts/att-1/result",
            headers={"Authorization": f"Bearer {bad_jwt}"},
            json={"completion_id": "comp-x", "pass_result": True},
        )
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()
