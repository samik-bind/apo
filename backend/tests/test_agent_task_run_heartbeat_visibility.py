"""Issue #176 diagnosability: `runs show` must surface the lease heartbeat.

`heartbeat_at` was only reachable through `batch show --json` →
`attempts[]`, so a run whose beat stream had died was silently stale for up
to a full lease TTL before anyone could know. The run detail route now
carries the run's attempt heartbeat so `runs show` (CLI) and the dashboard
can render "no beat for N seconds" while the run is still alive.
"""

# pyright: reportAny=false, reportExplicitAny=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ProjectDB,
    TaskExecutionAttemptDB,
    UserDB,
)

NOW = datetime.now(timezone.utc)


def _seed_run_with_attempt(
    session: Session,
    *,
    run_id: str = "run-hb-1",
    with_attempt: bool = True,
) -> str:
    if not session.get(UserDB, "u1"):
        session.add(UserDB(id="u1", email="u1@test.com", name="U1", password_hash="x"))
    if not session.get(ProjectDB, "p1"):
        session.add(ProjectDB(id="p1", name="P1", created_by="u1"))
    session.flush()
    batch = AgentTaskBatchRunDB(
        id=f"batch-{run_id}",
        project="p1",
        selection_type="task",
        status="running",
        created_at=NOW,
    )
    session.add(batch)
    session.flush()
    run = AgentTaskRunDB(
        id=run_id,
        batch_run_id=batch.id,
        task_id="demo",
        task_path="/tasks/demo",
        status="running",
        started_at=NOW,
    )
    session.add(run)
    if with_attempt:
        session.add(
            TaskExecutionAttemptDB(
                project="p1",
                batch_run_id=batch.id,
                task_run_id=run_id,
                sequence_index=0,
                target_kind="caller",
                status="running",
                heartbeat_at=NOW - timedelta(seconds=30),
                queue_expires_at=NOW + timedelta(seconds=60),
            )
        )
    session.commit()
    return run_id


class TestRunDetailHeartbeat:
    def test_detail_includes_the_attempt_heartbeat(
        self, client: TestClient, session: Session
    ) -> None:
        run_id = _seed_run_with_attempt(session, with_attempt=True)

        response = client.get(f"/v1/agent-task-runs/{run_id}")

        assert response.status_code == 200
        body: dict[str, Any] = response.json()
        assert body["heartbeat_at"] is not None
        # The beat actually recorded on the attempt, not "now".
        assert datetime.fromisoformat(body["heartbeat_at"]).timestamp() == (
            (NOW - timedelta(seconds=30)).timestamp()
        )

    def test_detail_heartbeat_is_null_without_an_attempt(
        self, client: TestClient, session: Session
    ) -> None:
        run_id = _seed_run_with_attempt(session, run_id="run-hb-2", with_attempt=False)

        response = client.get(f"/v1/agent-task-runs/{run_id}")

        assert response.status_code == 200
        body: dict[str, Any] = response.json()
        assert body["heartbeat_at"] is None
