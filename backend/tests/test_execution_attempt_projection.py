"""Public Batch detail exposes useful Attempt state without lease secrets."""

from datetime import datetime, timedelta, timezone

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    TaskExecutionAttemptDB,
)
from apo.services.agent_task_projection import to_batch_run_detail


def test_batch_detail_projects_safe_attempt_and_pool_state() -> None:
    now = datetime.now(timezone.utc)
    batch = AgentTaskBatchRunDB(
        id="batch-1",
        project="project-1",
        selection_type="task",
        status="queued",
        total_tasks=1,
        execution_target_json={"kind": "pool", "pool_id": "pool-1"},
        created_at=now,
    )
    task_run = AgentTaskRunDB(
        id="run-1",
        batch_run_id=batch.id,
        task_id="task-1",
        task_path="tasks/task-1",
        status="pending",
    )
    attempt = TaskExecutionAttemptDB(
        id="attempt-1",
        project=batch.project,
        batch_run_id=batch.id,
        task_run_id=task_run.id,
        task_revision_id="revision-1",
        sequence_index=0,
        target_kind="pool",
        executor_pool_id="pool-1",
        executor_id="executor-1",
        status="running",
        phase="running",
        queued_at=now - timedelta(minutes=2),
        queue_expires_at=now + timedelta(hours=1),
        claimed_at=now - timedelta(minutes=1),
        started_at=now - timedelta(seconds=30),
        heartbeat_at=now,
        lease_generation=7,
        executor_snapshot_json={"private_runtime": "must-not-leak"},
        completion_sha256="must-not-leak",
    )

    detail = to_batch_run_detail(
        batch,
        [task_run],
        attempts=[attempt],
        executor_names={"executor-1": "executor-east"},
        executor_pool_name="Private VPC",
    )

    assert detail.execution_target is not None
    assert detail.execution_target.pool_id == "pool-1"
    assert detail.executor_pool_name == "Private VPC"
    assert detail.attempts[0].executor_name == "executor-east"
    assert detail.attempts[0].phase == "running"
    public_attempt = detail.attempts[0].model_dump(mode="json")
    assert "lease_generation" not in public_attempt
    assert "lease_token_hash" not in public_attempt
    assert "attempt_jwt_jti" not in public_attempt
    assert "executor_snapshot_json" not in public_attempt
    assert "completion_sha256" not in public_attempt
