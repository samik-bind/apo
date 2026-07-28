# pyright: reportPrivateUsage=false

"""SPEC-143: Execution Attempt finalization (result / failure).

Owns the bounded result body, completion idempotency, exit code, and bounded
diagnostic tails. Delegates Task Run verdict/Checks/Deliverables/cost/Trace to
the shared :mod:`agent_task_run_service` finalizer so the new protocol and the
old subprocess path land terminal state identically.

Completion idempotency (§Start, heartbeat, result, failure): a result is
idempotent by ``(completion_id, canonical body digest)``. A replay with the
same ID and body is a no-op success; a replay with the same ID but a different
body raises a ``CompletionConflict`` (mapped to 409 by the route).
"""

from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass
from datetime import datetime, timezone

from sqlmodel import Session, select

from apo.db_helpers import _as_column
from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB, TaskExecutionAttemptDB
from apo.models.schemas import AgentTaskRunConfiguration
from apo.services.agent_task_run_service import finalize_task_run_with_result, update_batch_run_status
from apo.services.execution_leases import (
    CANCELLED,
    FAILED,
    SUCCEEDED,
    CurrentAttemptLease,
    LeaseError,
    _require_current,
)

# Bounded diagnostic tails (SPEC-143 §result/failure): 64 KiB each.
DIAGNOSTIC_TAIL_BYTES = 64 * 1024

_VALID_FAILURE_KINDS = frozenset(
    {
        "dependency_install",
        "bundle_invalid",
        "task_import",
        "task_runtime",
        "result_invalid",
        "timeout",
        "oom",
        "driver",
        "lease_expired",
        "executor_unavailable",
        "executor_shutdown",
        "cancelled",
        "internal",
    }
)


class CompletionConflict(Exception):
    """Same completion_id replayed with a different body (route maps to 409)."""


class FinalizationError(Exception):
    kind: str

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(f"[{kind}] {message}")
        self.kind = kind


@dataclass(frozen=True)
class AttemptResultBody:
    """Bounded result payload reported by an Executor."""

    completion_id: str
    pass_result: bool
    adapter_name: str | None = None
    trace_run_id: str | None = None
    checks: list[dict[str, object]] | None = None
    transcript: dict[str, object] | None = None
    deliverables: dict[str, object] | None = None
    exit_code: int | None = None
    stdout_tail: str | None = None
    stderr_tail: str | None = None
    error_message: str | None = None
    # SPEC-148: adapter-reported model/effort.
    run_configuration: AgentTaskRunConfiguration | None = None


@dataclass(frozen=True)
class AttemptFailureBody:
    completion_id: str
    failure_kind: str
    error_message: str | None = None
    exit_code: int | None = None
    stdout_tail: str | None = None
    stderr_tail: str | None = None


def _tail(text: str | None) -> str | None:
    if text is None:
        return None
    return text[-DIAGNOSTIC_TAIL_BYTES:]


def _body_digest(payload: object) -> str:
    import json

    return hashlib.sha256(
        json.dumps(
            payload,
            sort_keys=True,
            ensure_ascii=False,
            separators=(",", ":"),
            # SPEC-148: the result body can carry an ``AgentTaskRunConfiguration``
            # (an SQLModel). json can't serialize it directly, so fall back to its
            # dict form — this digest is only for completion-id idempotency.
            default=lambda o: o.model_dump() if hasattr(o, "model_dump") else str(o),
        ).encode()
    ).hexdigest()


def _check_completion_idempotency(
    session: Session,
    *,
    attempt: TaskExecutionAttemptDB,
    completion_id: str,
    digest: str,
    terminal_status: str,
) -> bool:
    """Return True if this completion is an idempotent replay (already done)."""
    existing = session.exec(
        select(TaskExecutionAttemptDB).where(
            _as_column(TaskExecutionAttemptDB.completion_id) == completion_id,
            _as_column(TaskExecutionAttemptDB.id) != attempt.id,
        )
    ).first()
    if existing is not None:
        raise CompletionConflict("completion_id already used by another attempt")
    if attempt.completion_id == completion_id and attempt.status == terminal_status:
        if attempt.completion_sha256 == digest:
            return True  # idempotent replay
        raise CompletionConflict("completion_id replayed with a different body")
    if attempt.completion_id is not None and attempt.completion_id != completion_id:
        raise CompletionConflict("attempt already finalized with a different completion_id")
    return False


def finalize_attempt_result(
    session: Session,
    *,
    lease: CurrentAttemptLease,
    body: AttemptResultBody,
) -> TaskExecutionAttemptDB:
    """Apply a bounded result: attempt succeeded, Task Run finalized via the
    shared finalizer, batch rolled up. Idempotent by (completion_id, digest)."""
    attempt = _require_current(session, lease)
    digest = _body_digest({"kind": "result", "body": asdict(body)})
    if _check_completion_idempotency(
        session,
        attempt=attempt,
        completion_id=body.completion_id,
        digest=digest,
        terminal_status=SUCCEEDED,
    ):
        return attempt
    if attempt.status != "running":
        raise LeaseError("state_mismatch", f"cannot finalize result from status {attempt.status!r}")

    now = datetime.now(timezone.utc)
    attempt.status = SUCCEEDED
    attempt.completion_id = body.completion_id
    attempt.completion_sha256 = digest
    attempt.exit_code = body.exit_code
    attempt.stdout_tail = _tail(body.stdout_tail)
    attempt.stderr_tail = _tail(body.stderr_tail)
    attempt.completed_at = now
    session.add(attempt)

    _finalize_task_run(
        session, attempt,
        pass_result=body.pass_result, adapter_name=body.adapter_name,
        trace_run_id=body.trace_run_id, checks=body.checks,
        transcript=body.transcript, deliverables=body.deliverables,
        error_message=body.error_message, errored=False,
        run_configuration=body.run_configuration,
    )
    session.commit()
    session.refresh(attempt)
    _emit_finalization_events(session, attempt)
    return attempt


def finalize_attempt_failure(
    session: Session,
    *,
    lease: CurrentAttemptLease,
    body: AttemptFailureBody,
) -> TaskExecutionAttemptDB:
    """Apply an operational failure: attempt failed, Task Run errored."""
    if body.failure_kind not in _VALID_FAILURE_KINDS:
        raise FinalizationError("bad_failure_kind", f"unknown failure kind {body.failure_kind!r}")
    attempt = _require_current(session, lease)
    terminal_status = CANCELLED if body.failure_kind == "cancelled" else FAILED
    digest = _body_digest({"kind": "failure", "body": asdict(body)})
    if _check_completion_idempotency(
        session,
        attempt=attempt,
        completion_id=body.completion_id,
        digest=digest,
        terminal_status=terminal_status,
    ):
        return attempt
    if attempt.status not in ("leased", "running"):
        raise LeaseError("state_mismatch", f"cannot finalize failure from status {attempt.status!r}")

    now = datetime.now(timezone.utc)
    attempt.status = terminal_status
    attempt.completion_id = body.completion_id
    attempt.completion_sha256 = digest
    attempt.failure_kind = body.failure_kind
    attempt.error_message = body.error_message
    attempt.exit_code = body.exit_code
    attempt.stdout_tail = _tail(body.stdout_tail)
    attempt.stderr_tail = _tail(body.stderr_tail)
    attempt.completed_at = now
    session.add(attempt)
    if terminal_status == CANCELLED:
        batch = session.get(AgentTaskBatchRunDB, attempt.batch_run_id)
        if batch is None:
            raise FinalizationError("not_found", "batch run not found")
        batch.cancelled_tasks += 1
        session.add(batch)

    _finalize_task_run(
        session, attempt, pass_result=False, adapter_name=None, trace_run_id=None,
        checks=None, transcript=None, deliverables=None,
        error_message=body.error_message or body.failure_kind, errored=True,
    )
    session.commit()
    session.refresh(attempt)
    _emit_finalization_events(session, attempt)
    return attempt


def _finalize_task_run(
    session: Session,
    attempt: TaskExecutionAttemptDB,
    *,
    pass_result: bool,
    adapter_name: str | None,
    trace_run_id: str | None,
    checks: list[dict[str, object]] | None,
    transcript: dict[str, object] | None,
    deliverables: dict[str, object] | None,
    error_message: str | None,
    errored: bool,
    run_configuration: AgentTaskRunConfiguration | None = None,
) -> None:
    task_run = session.get(AgentTaskRunDB, attempt.task_run_id)
    if task_run is None:
        raise FinalizationError("not_found", "task run not found")
    batch = session.get(AgentTaskBatchRunDB, attempt.batch_run_id)
    if batch is None:
        raise FinalizationError("not_found", "batch run not found")
    finalize_task_run_with_result(
        session, task_run, batch,
        adapter_name=adapter_name, pass_result=pass_result, trace_run_id=trace_run_id,
        checks=checks, transcript=transcript, deliverables=deliverables,
        errored=errored, error_message=error_message,
        run_configuration=run_configuration,
    )
    task_run.completed_at = datetime.now(timezone.utc)
    session.add(task_run)
    update_batch_run_status(session, batch)


def _emit_finalization_events(
    session: Session,
    attempt: TaskExecutionAttemptDB,
) -> None:
    """Publish the same lifecycle events as the former subprocess path."""
    from apo.services.run_events import emit_batch_run_event, emit_task_run_event

    task_run = session.get(AgentTaskRunDB, attempt.task_run_id)
    batch = session.get(AgentTaskBatchRunDB, attempt.batch_run_id)
    if task_run is None or batch is None:
        return
    emit_task_run_event(attempt.project, task_run)
    if batch.status in ("completed", "error"):
        task_runs = list(
            session.exec(
                select(AgentTaskRunDB).where(
                    _as_column(AgentTaskRunDB.batch_run_id) == batch.id
                )
            ).all()
        )
        emit_batch_run_event(attempt.project, batch, task_runs)


__all__ = [
    "AttemptFailureBody",
    "AttemptResultBody",
    "CompletionConflict",
    "DIAGNOSTIC_TAIL_BYTES",
    "FinalizationError",
    "finalize_attempt_failure",
    "finalize_attempt_result",
]
