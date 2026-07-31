"""SPEC-161: Protocol v2 routes for source-owned Connected Executors.

Parallel to the v1 bundled-executor protocol. Shares enrollment, lease,
and finalization services but routes only source-owned assignments.

Key differences from v1:
- Claims select only assignment_kind="source_owned"
- Claims gate on catalog_digest match
- Claims check target_user_id against executor's enrolled_by_user_id
- Source attestation endpoint attaches an attested revision before /start
- /start requires task_revision_id for source_owned attempts
"""

# pyright: reportAny=false, reportCallInDefaultInitializer=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnusedCallResult=false

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlmodel import Session, col, select

from ..db import get_session
from ..models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ExecutorDB,
    ExecutorEnrollmentTokenDB,
    TaskExecutionAttemptDB,
    TaskRevisionDB,
)
from ..services.executor_auth import (
    ExecutorCapabilities,
    EnrollmentError,
    exchange_enrollment_token,
    resolve_executor_by_credential,
    validate_current_attempt_jwt,
)
from ..services.execution_leases import (
    CurrentAttemptLease,
    LeaseError,
    heartbeat_attempt,
    start_attempt,
)
from ..services.source_owned_executor import check_catalog_eligibility

router = APIRouter(prefix="/v1/executor-protocol/v2", tags=["executor-protocol-v2"])

PROTOCOL_VERSION = 2


# ---------------------------------------------------------------------------
# Auth dependencies
# ---------------------------------------------------------------------------


def _require_executor(request: Request, session: Session = Depends(get_session)) -> ExecutorDB:
    """Authenticate an executor credential from the Authorization header."""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={"kind": "executor_credential_invalid"})
    token = auth[7:].strip()
    executor = resolve_executor_by_credential(session, token)
    if executor is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={"kind": "executor_credential_invalid"})
    return executor


def _require_attempt_lease(
    request: Request,
    session: Session = Depends(get_session),
) -> CurrentAttemptLease:
    """Validate the Attempt JWT from the Authorization header."""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    token = auth[7:].strip()
    result = validate_current_attempt_jwt(session, token)
    if result is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Invalid attempt token")
    attempt, claims = result
    return CurrentAttemptLease(
        attempt_id=attempt.id,
        lease_generation=attempt.lease_generation,
        executor_id=attempt.executor_id or "",
    )


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class EnrollV2Request(BaseModel):
    token: str
    name: str
    capabilities: ExecutorCapabilities


class EnrollV2Response(BaseModel):
    executor_id: str
    credential: str
    heartbeat_interval_seconds: int
    lease_ttl_seconds: int


class HeartbeatV2Request(BaseModel):
    catalog_digest: str
    available_slots: int


class ClaimV2Request(BaseModel):
    catalog_digest: str
    available_slots: int


class SourceOwnedAssignment(BaseModel):
    assignment_kind: Literal["source_owned"] = "source_owned"
    attempt_id: str
    task_run_id: str
    batch_run_id: str
    task_id: str
    environment: str
    timeout_seconds: int
    project: str
    catalog_digest: str
    lease_generation: int
    lease_expires_at: str
    attempt_jwt: str
    trace_endpoint: str
    trace_required: Literal[True] = True
    result_max_bytes: int
    diagnostic_tail_bytes: int
    run_metadata: dict[str, object] | None = None


class SourceAttestationRequest(BaseModel):
    source_type: str = "connected_worktree"
    repository_url: str | None = None
    base_commit_sha: str | None = None
    dirty: bool = False
    content_sha256: str
    task_root_label: str | None = None
    file_count: int = 0
    uncompressed_size_bytes: int = 0


class SourceAttestationResponse(BaseModel):
    task_revision_id: str
    content_sha256: str


# ---------------------------------------------------------------------------
# Enrollment
# ---------------------------------------------------------------------------


@router.post("/enroll", response_model=EnrollV2Response)
async def enroll_v2(
    body: EnrollV2Request,
    response: Response,
    session: Session = Depends(get_session),
) -> EnrollV2Response:
    """Exchange a one-time bootstrap token for a persistent executor credential."""
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)
    try:
        executor, raw_credential, hb, lease_ttl = exchange_enrollment_token(
            session, raw_token=body.token, name=body.name, capabilities=body.capabilities,
        )
    except EnrollmentError as exc:
        raise HTTPException(
            status.HTTP_410_GONE if exc.kind in ("token_expired", "token_used") else status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"kind": exc.kind, "message": str(exc)},
        )

    # SPEC-161: copy the bootstrap token's created_by_user_id to enrolled_by_user_id
    token_row = session.exec(
        select(ExecutorEnrollmentTokenDB).where(
            col(ExecutorEnrollmentTokenDB.executor_pool_id) == executor.executor_pool_id,
            col(ExecutorEnrollmentTokenDB.used_at).is_not(None),
        )
    ).first()
    if token_row is not None and token_row.created_by_user_id:
        executor.enrolled_by_user_id = token_row.created_by_user_id
        session.add(executor)
        session.commit()

    return EnrollV2Response(
        executor_id=executor.id,
        credential=raw_credential,
        heartbeat_interval_seconds=hb,
        lease_ttl_seconds=lease_ttl,
    )


# ---------------------------------------------------------------------------
# Heartbeat
# ---------------------------------------------------------------------------


@router.post("/heartbeat")
async def heartbeat_v2(
    body: HeartbeatV2Request,
    response: Response,
    executor: ExecutorDB = Depends(_require_executor),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Heartbeat with catalog digest eligibility check.

    Persists the latest protocol-v2 catalog digest and reported available
    slots as observations (used for UI freshness). The persisted
    ``max_concurrency`` plus active leased/running Attempts remain the
    capacity authority — client-reported slots never grant capacity.
    """
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)
    eligibility = check_catalog_eligibility(
        session, executor.project or "", body.catalog_digest,
    )
    now = datetime.now(timezone.utc)
    executor.last_seen_at = now
    executor.reported_catalog_digest = body.catalog_digest
    # Reported slots are an observation bounded by configured max_concurrency.
    bounded_slots = max(0, min(body.available_slots, max(executor.max_concurrency, 0)))
    executor.reported_available_slots = bounded_slots
    session.add(executor)
    session.commit()
    return eligibility


# ---------------------------------------------------------------------------
# Claims
# ---------------------------------------------------------------------------


@router.post("/claims", response_model=SourceOwnedAssignment | None)
async def claims_v2(
    body: ClaimV2Request,
    request: Request,
    response: Response,
    executor: ExecutorDB = Depends(_require_executor),
    session: Session = Depends(get_session),
) -> SourceOwnedAssignment | None:
    """Claim a source-owned assignment. Returns 204 when no work exists."""
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)

    # Check catalog eligibility
    eligibility = check_catalog_eligibility(
        session, executor.project or "", body.catalog_digest,
    )
    if eligibility["status"] != "ready":
        response.status_code = status.HTTP_409_CONFLICT
        return None

    # Find a source-owned attempt for this executor's user
    pool_id = executor.executor_pool_id
    user_id = executor.enrolled_by_user_id

    candidate = session.exec(
        select(TaskExecutionAttemptDB).where(
            TaskExecutionAttemptDB.status == "queued",
            TaskExecutionAttemptDB.assignment_kind == "source_owned",
            TaskExecutionAttemptDB.executor_pool_id == pool_id,
            TaskExecutionAttemptDB.target_user_id == user_id,
        ).order_by(col(TaskExecutionAttemptDB.queued_at))
    ).first()

    if candidate is None:
        response.status_code = status.HTTP_204_NO_CONTENT
        response.headers["Retry-After"] = "5"
        return None

    from sqlalchemy import update

    now = datetime.now(timezone.utc)
    lease_expires = now  # Will be set properly by lease service
    from datetime import timedelta
    lease_expires = now + timedelta(seconds=300)

    stmt = (
        update(TaskExecutionAttemptDB)
        .where(
            col(TaskExecutionAttemptDB.id) == candidate.id,
            col(TaskExecutionAttemptDB.status) == "queued",
        )
        .values(
            status="leased",
            executor_id=executor.id,
            claimed_at=now,
            lease_generation=candidate.lease_generation + 1,
            lease_expires_at=lease_expires,
        )
    )
    result = session.execute(stmt)
    if getattr(result, "rowcount", 0) == 0:
        response.status_code = status.HTTP_204_NO_CONTENT
        response.headers["Retry-After"] = "5"
        return None

    session.commit()
    session.refresh(candidate)

    # Issue attempt JWT
    from ..services.executor_auth import create_attempt_jwt
    attempt_jwt = create_attempt_jwt(
        attempt=candidate,
        lease_generation=candidate.lease_generation,
        expires_in_seconds=7200,
    )

    # Look up task + batch
    task_run = session.get(AgentTaskRunDB, candidate.task_run_id)
    batch_run = session.get(AgentTaskBatchRunDB, candidate.batch_run_id)

    return SourceOwnedAssignment(
        attempt_id=candidate.id,
        task_run_id=candidate.task_run_id,
        batch_run_id=candidate.batch_run_id,
        task_id=task_run.task_id if task_run else "",
        environment=batch_run.environment if batch_run else "default",
        timeout_seconds=3600,
        project=candidate.project,
        catalog_digest=body.catalog_digest,
        lease_generation=candidate.lease_generation,
        lease_expires_at=candidate.lease_expires_at.isoformat() if candidate.lease_expires_at else "",
        attempt_jwt=attempt_jwt,
        trace_endpoint=request.url.scheme + "://" + request.url.netloc + "/api/public/otel/v1/traces",
        result_max_bytes=10_485_760,
        diagnostic_tail_bytes=10_000,
        run_metadata=batch_run.run_metadata if batch_run else None,
    )


# ---------------------------------------------------------------------------
# Source attestation
# ---------------------------------------------------------------------------


@router.post("/attempts/{attempt_id}/source-attestation", response_model=SourceAttestationResponse)
async def source_attestation(
    attempt_id: str,
    body: SourceAttestationRequest,
    lease: CurrentAttemptLease = Depends(_require_attempt_lease),
    session: Session = Depends(get_session),
) -> SourceAttestationResponse:
    """Attach an attested (non-bundled) Task Revision to the claimed Attempt."""
    if lease.attempt_id != attempt_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "attempt token not valid for this attempt")

    attempt = session.get(TaskExecutionAttemptDB, attempt_id)
    if attempt is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "attempt not found")

    if attempt.status not in ("leased",):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"kind": "attestation_closed", "message": "attempt is no longer leased"},
        )

    # Idempotent replay: if already attested with same digest, return existing
    if attempt.task_revision_id:
        existing_rev = session.get(TaskRevisionDB, attempt.task_revision_id)
        if existing_rev is not None and existing_rev.content_sha256 == body.content_sha256:
            return SourceAttestationResponse(
                task_revision_id=existing_rev.id,
                content_sha256=existing_rev.content_sha256,
            )
        if existing_rev is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail={"kind": "attestation_conflict", "message": "different attestation already attached"},
            )

    # Create attested revision
    revision = TaskRevisionDB(
        id=uuid4().hex[:16],
        project=attempt.project,
        batch_run_id=attempt.batch_run_id,
        materialization="attested",
        source_type=body.source_type,
        source_ref=body.repository_url,
        commit_sha=body.base_commit_sha,
        dirty=body.dirty,
        content_sha256=body.content_sha256,
        file_count=body.file_count,
        uncompressed_size_bytes=body.uncompressed_size_bytes,
        manifest_summary_json={"task_root_label": body.task_root_label or ""},
    )
    session.add(revision)
    session.flush()

    attempt.task_revision_id = revision.id
    session.add(attempt)
    session.commit()

    return SourceAttestationResponse(
        task_revision_id=revision.id,
        content_sha256=revision.content_sha256,
    )


# ---------------------------------------------------------------------------
# Shared attempt lifecycle (alias v1 routes)
# ---------------------------------------------------------------------------


class StartRequest(BaseModel):
    driver_kind: str = "source-owned-ts"
    runtime: dict[str, object] | None = None


@router.post("/attempts/{attempt_id}/start")
async def attempt_start_v2(
    attempt_id: str,
    body: StartRequest,
    response: Response,
    lease: CurrentAttemptLease = Depends(_require_attempt_lease),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Start a source-owned attempt. Requires attested revision."""
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)
    if lease.attempt_id != attempt_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "attempt token not valid for this attempt")

    attempt = session.get(TaskExecutionAttemptDB, attempt_id)
    if attempt is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "attempt not found")

    # SPEC-161: source-owned attempts require attestation before start
    if attempt.assignment_kind == "source_owned" and attempt.task_revision_id is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"kind": "source_attestation_required", "message": "submit source attestation before starting"},
        )

    try:
        runtime = {str(k): str(v) for k, v in (body.runtime or {}).items()}
        started = start_attempt(session, lease=lease, driver_kind=body.driver_kind, runtime=runtime)
    except LeaseError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"kind": "stale_generation", "message": str(exc)},
        )
    return {"attempt_id": started.id, "status": started.status, "phase": started.phase}


class AttemptHeartbeatRequest(BaseModel):
    phase: str | None = None


@router.post("/attempts/{attempt_id}/heartbeat")
async def attempt_heartbeat_v2(
    attempt_id: str,
    body: AttemptHeartbeatRequest,
    response: Response,
    lease: CurrentAttemptLease = Depends(_require_attempt_lease),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)
    if lease.attempt_id != attempt_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "attempt token not valid for this attempt")
    try:
        resp = heartbeat_attempt(session, lease=lease, phase=body.phase or "running")
    except LeaseError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"kind": "stale_generation", "message": str(exc)})
    return {"cancel_requested": resp.cancel_requested}


# ---------------------------------------------------------------------------
# Shared finalization (v2 aliases of the v1 result/failure routes)
# ---------------------------------------------------------------------------


class AttemptResultRequest(BaseModel):
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


class AttemptFailureRequest(BaseModel):
    completion_id: str
    failure_kind: str
    error_message: str | None = None
    exit_code: int | None = None
    stdout_tail: str | None = None
    stderr_tail: str | None = None


@router.post("/attempts/{attempt_id}/result")
async def attempt_result_v2(
    attempt_id: str,
    body: AttemptResultRequest,
    response: Response,
    lease: CurrentAttemptLease = Depends(_require_attempt_lease),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """SPEC-161 v2 result: alias of the shared finalization path."""
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)
    if lease.attempt_id != attempt_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "attempt token not valid for this attempt")
    from ..services.execution_finalization import (
        AttemptResultBody,
        CompletionConflict,
        finalize_attempt_result,
    )

    try:
        finalize_attempt_result(
            session,
            lease=lease,
            body=AttemptResultBody(
                completion_id=body.completion_id,
                pass_result=body.pass_result,
                adapter_name=body.adapter_name,
                trace_run_id=body.trace_run_id,
                checks=body.checks,
                transcript=body.transcript,
                deliverables=body.deliverables,
                exit_code=body.exit_code,
                stdout_tail=body.stdout_tail,
                stderr_tail=body.stderr_tail,
                error_message=body.error_message,
                run_configuration=None,
            ),
        )
    except CompletionConflict as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return {"ok": True, "attempt_id": attempt_id}


@router.post("/attempts/{attempt_id}/failure")
async def attempt_failure_v2(
    attempt_id: str,
    body: AttemptFailureRequest,
    response: Response,
    lease: CurrentAttemptLease = Depends(_require_attempt_lease),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """SPEC-161 v2 failure: alias of the shared finalization path."""
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)
    if lease.attempt_id != attempt_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "attempt token not valid for this attempt")
    from ..services.execution_finalization import (
        AttemptFailureBody,
        CompletionConflict,
        finalize_attempt_failure,
    )

    try:
        finalize_attempt_failure(
            session,
            lease=lease,
            body=AttemptFailureBody(
                completion_id=body.completion_id,
                failure_kind=body.failure_kind,
                error_message=body.error_message,
                exit_code=body.exit_code,
                stdout_tail=body.stdout_tail,
                stderr_tail=body.stderr_tail,
            ),
        )
    except CompletionConflict as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return {"ok": True, "attempt_id": attempt_id}
