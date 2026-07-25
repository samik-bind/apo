"""SPEC-143/145: execution queue — Batch + Task Run + Attempt creation.

SPEC-145 adds ``create_caller_batch_run``: the caller Executor is ephemeral and
atomically creates and claims one Task Run without enrolling a persistent
Executor identity. It materializes an attested Task Revision (SPEC-142), creates
a ``target_kind="caller"`` Attempt already leased at generation 1, and mints the
Attempt JWT the CLI uses for /start, heartbeat, and result.

No production pooled entry point uses this yet (SPEC-146 wires pooled Batches).
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlmodel import Session

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ProjectDB,
    TaskExecutionAttemptDB,
)
from apo.models.execution import (
    CallerIdentity,
    CallerSourceAttestation,
    CallerTaskDescriptor,
)
from apo.services.executor_auth import (
    ATTEMPT_LEASE_SECONDS,
    DEFAULT_QUEUE_TTL_SECONDS,
    create_attempt_jwt,
)
from apo.services.task_revisions import create_attested_task_revision

_CALLER_LEASE_JWT_TTL_SECONDS = 2 * 60 * 60  # covers max task timeout + finalization grace


class CallerExecutionError(ValueError):
    """Raised on invalid caller create-and-claim input."""


@dataclass(frozen=True)
class CallerClaimResult:
    batch: AgentTaskBatchRunDB
    task_run: AgentTaskRunDB
    attempt: TaskExecutionAttemptDB
    attempt_jwt: str


def create_caller_batch_run(
    session: Session,
    *,
    project_id: str,
    task: CallerTaskDescriptor,
    environment: str,
    run_metadata: dict[str, object] | None,
    attestation: CallerSourceAttestation,
    caller_identity: CallerIdentity,
) -> CallerClaimResult:
    """Atomically create one Batch + Task Run + attested Revision + leased caller
    Attempt, and mint the Attempt JWT. Supports exactly one Task.

    The caller owns execution; the backend marks the Task Run ``running`` only
    when the CLI later calls ``/start`` (the Attempt is created ``leased``).
    """
    _validate_caller_identity(caller_identity)
    project = session.get(ProjectDB, project_id)
    if project is None:
        raise CallerExecutionError(f"project not found: {project_id!r}")

    now = datetime.now(timezone.utc)
    batch_id = "bch_" + secrets.token_hex(12)
    run_id = "run_" + secrets.token_hex(12)

    batch = AgentTaskBatchRunDB(
        id=batch_id,
        project=project_id,
        selection_type="caller-task",
        task_root=None,
        grep=None,
        environment=environment,
        run_metadata=run_metadata or {},
        status="queued",
        execution_target_json={"kind": "caller"},
        created_at=now,
    )
    session.add(batch)
    session.flush()

    task_run = AgentTaskRunDB(
        id=run_id,
        batch_run_id=batch_id,
        task_id=task.task_id,
        task_path=task.task_path,
        sequence_index=0,
        status="pending",
    )
    session.add(task_run)
    session.flush()

    revision = create_attested_task_revision(
        session, project_id=project_id, batch_run_id=batch_id, attestation=attestation,
    )
    session.flush()

    attempt = TaskExecutionAttemptDB(
        project=project_id,
        batch_run_id=batch_id,
        task_run_id=run_id,
        task_revision_id=revision.id,
        sequence_index=0,
        target_kind="caller",
        executor_pool_id=None,
        executor_id=None,
        status="leased",
        lease_generation=1,
        lease_expires_at=now + timedelta(seconds=ATTEMPT_LEASE_SECONDS),
        queue_expires_at=now + timedelta(seconds=DEFAULT_QUEUE_TTL_SECONDS),
        queued_at=now,
        claimed_at=now,
        heartbeat_at=now,
        executor_snapshot_json=_caller_snapshot(caller_identity),
    )
    session.add(attempt)
    session.commit()
    session.refresh(batch)
    session.refresh(task_run)
    session.refresh(attempt)

    jwt = create_attempt_jwt(
        attempt=attempt, lease_generation=1, expires_in_seconds=_CALLER_LEASE_JWT_TTL_SECONDS,
    )
    return CallerClaimResult(batch=batch, task_run=task_run, attempt=attempt, attempt_jwt=jwt)


def _caller_snapshot(identity: CallerIdentity) -> dict[str, object]:
    return {
        "client": identity.client,
        "client_version": identity.client_version,
        "hostname_hash": identity.hostname_hash,
        "ci_provider": identity.ci_provider,
        "ci_job_id": identity.ci_job_id,
        "git_branch": identity.git_branch,
        "os": identity.os,
        "architecture": identity.architecture,
    }


_MAX_IDENTITY_FIELD_BYTES = 255
_MAX_IDENTITY_TOTAL_BYTES = 4 * 1024


def _validate_caller_identity(identity: CallerIdentity) -> None:
    fields = {
        "client": identity.client, "client_version": identity.client_version,
        "hostname_hash": identity.hostname_hash, "ci_provider": identity.ci_provider,
        "ci_job_id": identity.ci_job_id, "git_branch": identity.git_branch,
        "os": identity.os, "architecture": identity.architecture,
    }
    total = 0
    for name, value in fields.items():
        if value is None:
            continue
        b = len(str(value).encode("utf-8"))
        if b > _MAX_IDENTITY_FIELD_BYTES:
            raise CallerExecutionError(f"caller_identity.{name} exceeds 255-byte limit")
        total += b
    if total > _MAX_IDENTITY_TOTAL_BYTES:
        raise CallerExecutionError("caller_identity exceeds 4 KiB total limit")


__all__ = ["CallerClaimResult", "CallerExecutionError", "create_caller_batch_run"]
