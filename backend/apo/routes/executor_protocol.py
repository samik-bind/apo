# pyright: reportCallInDefaultInitializer=false

"""SPEC-143: Executor Control Plane HTTP protocol.

All endpoints under ``/v1/executor-protocol/v1``. The protocol authenticates
itself (one-time enrollment token, long-lived ``apo_ex_`` credential, or a
``task_execution_attempt`` JWT) inside each handler via Depends — the path is
public to the user/api-key auth middleware so the two credential models stay
isolated. Every response carries ``X-Apo-Executor-Protocol: 1``.

This is a foundation spec: the routes are registered and Project scoped, but no
production run entry point queues through them until SPEC-144 ships a proven
Executor.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import StreamingResponse
from jose import JWTError
from pydantic import BaseModel, Field
from sqlmodel import Session

from apo.auth.rate_limit import LoginRateLimiter
from apo.db import get_session
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ExecutorDB,
    TaskExecutionAttemptDB,
    TaskRevisionDB,
)
from apo.models.schemas import AgentTaskRunConfiguration
from apo.models.execution import EXECUTOR_PROTOCOL_VERSION, ExecutorCapabilities
from apo.services.execution_finalization import (
    AttemptFailureBody,
    AttemptResultBody,
    CompletionConflict,
    FinalizationError,
    finalize_attempt_failure,
    finalize_attempt_result,
)
from apo.services.execution_leases import (
    CurrentAttemptLease,
    LeaseError,
    claim_next_attempt,
    heartbeat_attempt,
    start_attempt,
)
from apo.services.executor_auth import (
    EnrollmentError,
    create_attempt_jwt,
    decode_attempt_jwt,
    exchange_enrollment_token,
    resolve_executor_by_credential,
)
from apo.services.artifact_stores.registry import get_store

router = APIRouter(prefix="/v1/executor-protocol/v1", tags=["executor-protocol"])
PROTOCOL_VERSION = EXECUTOR_PROTOCOL_VERSION
_LEASE_JWT_TTL_SECONDS = 2 * 60 * 60  # covers max task timeout + finalization grace
_enrollment_rate_limiter = LoginRateLimiter(max_attempts=20, window_seconds=60)


class EnrollRequest(BaseModel):
    token: str
    name: str
    capabilities: ExecutorCapabilities


class EnrollResponse(BaseModel):
    executor_id: str
    credential: str
    heartbeat_interval_seconds: int
    lease_ttl_seconds: int


class ClaimsRequest(BaseModel):
    available_slots: int = 1
    accepted_driver_kinds: list[str] = Field(default_factory=list)


class ClaimAttemptResponse(BaseModel):
    attempt_id: str
    task_run_id: str
    batch_run_id: str
    task_id: str
    task_path: str
    environment: str
    timeout_seconds: int
    project: str
    lease_generation: int
    lease_expires_at: datetime
    attempt_jwt: str
    task_revision_id: str
    content_sha256: str
    bundle_sha256: str
    bundle_size_bytes: int
    bundle_url: str
    trace_endpoint: str
    trace_required: bool = True
    result_max_bytes: int = 10 * 1024 * 1024
    diagnostic_tail_bytes: int = 64 * 1024
    run_metadata: dict[str, object] | None = None


class StartRequest(BaseModel):
    driver_kind: str
    runtime: dict[str, str] = Field(default_factory=dict)


class AttemptHeartbeatRequest(BaseModel):
    phase: str


class ResultRequest(BaseModel):
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
    # SPEC-148: the adapter's resolved model/effort for this attempt.
    run_configuration: AgentTaskRunConfiguration | None = None


class FailureRequest(BaseModel):
    completion_id: str
    failure_kind: str
    error_message: str | None = None
    exit_code: int | None = None
    stdout_tail: str | None = None
    stderr_tail: str | None = None


# ── auth dependencies ─────────────────────────────────────────────────────


def _bearer_token(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer credential")
    return auth.split(" ", 1)[1].strip()


def require_executor(request: Request, session: Session = Depends(get_session)) -> ExecutorDB:
    """Resolve an enabled, non-revoked Executor from its apo_ex_ credential."""
    token = _bearer_token(request)
    executor = resolve_executor_by_credential(session, token)
    if executor is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid executor credential")
    return executor


def require_attempt_lease(
    request: Request, session: Session = Depends(get_session)
) -> CurrentAttemptLease:
    """Decode the task_execution_attempt JWT and verify it against live DB state."""
    token = _bearer_token(request)
    try:
        claims = decode_attempt_jwt(token)
    except JWTError as exc:  # pragma: no cover - decode_attempt_jwt already guards
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid attempt token") from exc
    if claims is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid attempt token")
    attempt_id = str(claims.get("attempt_id"))
    raw_gen = claims.get("lease_generation")
    if not isinstance(raw_gen, int):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid attempt token")
    raw_executor = claims.get("executor_id")
    # Caller Attempts have no persistent Executor (executor_id is None); preserve
    # None rather than stringifying it so the own-only check matches the row.
    lease = CurrentAttemptLease(
        attempt_id=attempt_id,
        lease_generation=raw_gen,
        executor_id=str(raw_executor) if raw_executor is not None else "",
    )
    attempt = session.get(TaskExecutionAttemptDB, attempt_id)
    if attempt is None or attempt.lease_generation != lease.lease_generation:
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"kind": "lease_stale"})
    return lease


# ── endpoints ─────────────────────────────────────────────────────────────


@router.post("/enroll", response_model=EnrollResponse)
async def enroll(
    body: EnrollRequest,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
) -> EnrollResponse:
    """Exchange a one-time enrollment token for a persistent Executor credential."""
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)
    _enforce_enrollment_rate_limit(request)
    try:
        executor, raw_credential, hb, lease_ttl = exchange_enrollment_token(
            session, raw_token=body.token, name=body.name, capabilities=body.capabilities,
        )
    except EnrollmentError as exc:
        if exc.kind == "token_used":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail={"kind": exc.kind, "message": "enrollment token was already used"},
            )
        if exc.kind == "protocol_mismatch":
            raise HTTPException(
                status.HTTP_426_UPGRADE_REQUIRED,
                detail={
                    "kind": exc.kind,
                    "message": "upgrade the Executor to protocol version 1",
                    "supported_protocol": PROTOCOL_VERSION,
                },
                headers={"X-Apo-Executor-Protocol": str(PROTOCOL_VERSION)},
            )
        if exc.kind == "capability_invalid":
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail={
                    "kind": exc.kind,
                    "message": str(exc),
                },
            )
        raise HTTPException(
            status.HTTP_410_GONE,
            detail={
                "kind": exc.kind,
                "message": (
                    "enrollment token expired"
                    if exc.kind == "token_expired"
                    else "enrollment token is invalid"
                ),
            },
        )
    return EnrollResponse(
        executor_id=executor.id,
        credential=raw_credential,
        heartbeat_interval_seconds=hb,
        lease_ttl_seconds=lease_ttl,
    )


def _enforce_enrollment_rate_limit(request: Request) -> None:
    client_ip = request.client.host if request.client is not None else "unknown"
    if not _enrollment_rate_limiter.is_allowed(client_ip):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "too many enrollment attempts",
            headers={
                "Retry-After": str(
                    _enrollment_rate_limiter.get_retry_after(client_ip)
                )
            },
        )
    _enrollment_rate_limiter.record_attempt(client_ip)


@router.post("/heartbeat", status_code=status.HTTP_204_NO_CONTENT)
async def executor_heartbeat(
    response: Response,
    executor: ExecutorDB = Depends(require_executor),
    session: Session = Depends(get_session),
) -> None:
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)
    executor.last_seen_at = datetime.now(timezone.utc)
    session.add(executor)
    session.commit()


@router.post("/claims", response_model=ClaimAttemptResponse | None)
async def claims(
    body: ClaimsRequest,
    request: Request,
    response: Response,
    executor: ExecutorDB = Depends(require_executor),
    session: Session = Depends(get_session),
) -> ClaimAttemptResponse | None:
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)
    claimed = claim_next_attempt(
        session, executor=executor, accepted_driver_kinds=frozenset(body.accepted_driver_kinds),
    )
    if claimed is None:
        response.status_code = status.HTTP_204_NO_CONTENT
        response.headers["Retry-After"] = "2"
        return None
    jwt = create_attempt_jwt(
        attempt=claimed.attempt,
        lease_generation=claimed.lease.lease_generation,
        expires_in_seconds=_LEASE_JWT_TTL_SECONDS,
    )
    task_run = session.get(AgentTaskRunDB, claimed.attempt.task_run_id)
    batch = session.get(AgentTaskBatchRunDB, claimed.attempt.batch_run_id)
    revision = session.get(TaskRevisionDB, claimed.attempt.task_revision_id)
    if (
        task_run is None
        or batch is None
        or revision is None
        or revision.materialization != "bundled"
        or revision.bundle_sha256 is None
        or revision.bundle_size_bytes is None
        or revision.bundle_storage_key is None
    ):
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "claimed attempt has no runnable bundled revision",
        )
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)
    return ClaimAttemptResponse(
        attempt_id=claimed.attempt.id,
        task_run_id=claimed.attempt.task_run_id,
        batch_run_id=claimed.attempt.batch_run_id,
        task_id=task_run.task_id,
        task_path=task_run.task_path,
        environment=batch.environment,
        timeout_seconds=600,
        project=claimed.attempt.project,
        lease_generation=claimed.lease.lease_generation,
        lease_expires_at=claimed.attempt.lease_expires_at or datetime.now(timezone.utc),
        attempt_jwt=jwt,
        task_revision_id=revision.id,
        content_sha256=revision.content_sha256,
        bundle_sha256=revision.bundle_sha256,
        bundle_size_bytes=revision.bundle_size_bytes,
        bundle_url=(
            f"/v1/executor-protocol/v1/attempts/{claimed.attempt.id}/bundle"
        ),
        trace_endpoint=str(request.base_url).rstrip("/"),
        run_metadata=batch.run_metadata,
    )


@router.get("/attempts/{attempt_id}/bundle")
async def download_bundle(
    attempt_id: str,
    lease: CurrentAttemptLease = Depends(require_attempt_lease),
    session: Session = Depends(get_session),
) -> StreamingResponse:
    if lease.attempt_id != attempt_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "attempt token not valid for this attempt")
    attempt = session.get(TaskExecutionAttemptDB, attempt_id)
    if attempt is None or attempt.status not in ("leased", "running"):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"kind": "lease_stale"},
        )
    revision = session.get(TaskRevisionDB, attempt.task_revision_id)
    if (
        revision is None
        or revision.materialization != "bundled"
        or revision.bundle_storage_key is None
        or revision.bundle_storage_backend is None
        or revision.bundle_sha256 is None
        or revision.bundle_size_bytes is None
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "bundle not found")
    store = get_store(revision.bundle_storage_backend)
    stat_result = await store.stat(revision.bundle_storage_key)
    if stat_result is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "bundle object is unavailable",
        )
    return StreamingResponse(
        store.open(revision.bundle_storage_key),
        media_type="application/gzip",
        headers={
            "X-Apo-Executor-Protocol": str(PROTOCOL_VERSION),
            "Content-Length": str(revision.bundle_size_bytes),
            "X-Apo-Bundle-Sha256": revision.bundle_sha256,
            "X-Apo-Content-Sha256": revision.content_sha256,
        },
    )


@router.post("/attempts/{attempt_id}/start")
async def attempt_start(
    attempt_id: str,
    body: StartRequest,
    response: Response,
    lease: CurrentAttemptLease = Depends(require_attempt_lease),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)
    if lease.attempt_id != attempt_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "attempt token not valid for this attempt")
    try:
        started = start_attempt(session, lease=lease, driver_kind=body.driver_kind, runtime=body.runtime)
    except LeaseError as exc:
        raise _lease_error_to_http(exc)
    return {"attempt_id": started.id, "status": started.status, "phase": started.phase}


@router.post("/attempts/{attempt_id}/heartbeat")
async def attempt_heartbeat(
    attempt_id: str,
    body: AttemptHeartbeatRequest,
    response: Response,
    lease: CurrentAttemptLease = Depends(require_attempt_lease),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)
    if lease.attempt_id != attempt_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "attempt token not valid for this attempt")
    try:
        resp = heartbeat_attempt(session, lease=lease, phase=body.phase)
    except LeaseError as exc:
        raise _lease_error_to_http(exc)
    return {"cancel_requested": resp.cancel_requested}


@router.post("/attempts/{attempt_id}/result")
async def attempt_result(
    attempt_id: str,
    body: ResultRequest,
    response: Response,
    lease: CurrentAttemptLease = Depends(require_attempt_lease),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)
    if lease.attempt_id != attempt_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "attempt token not valid for this attempt")
    try:
        attempt = finalize_attempt_result(
            session, lease=lease,
            body=AttemptResultBody(
                completion_id=body.completion_id, pass_result=body.pass_result,
                adapter_name=body.adapter_name, trace_run_id=body.trace_run_id,
                checks=body.checks, transcript=body.transcript,
                deliverables=body.deliverables, exit_code=body.exit_code,
                stdout_tail=body.stdout_tail, stderr_tail=body.stderr_tail,
                error_message=body.error_message,
                run_configuration=body.run_configuration,
            ),
        )
    except CompletionConflict as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"kind": "completion_conflict", "msg": str(exc)})
    except LeaseError as exc:
        raise _lease_error_to_http(exc)
    return {"attempt_id": attempt.id, "status": attempt.status}


@router.post("/attempts/{attempt_id}/failure")
async def attempt_failure(
    attempt_id: str,
    body: FailureRequest,
    response: Response,
    lease: CurrentAttemptLease = Depends(require_attempt_lease),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)
    if lease.attempt_id != attempt_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "attempt token not valid for this attempt")
    try:
        attempt = finalize_attempt_failure(
            session, lease=lease,
            body=AttemptFailureBody(
                completion_id=body.completion_id, failure_kind=body.failure_kind,
                error_message=body.error_message, exit_code=body.exit_code,
                stdout_tail=body.stdout_tail, stderr_tail=body.stderr_tail,
            ),
        )
    except CompletionConflict as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"kind": "completion_conflict", "msg": str(exc)},
        )
    except FinalizationError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    except LeaseError as exc:
        raise _lease_error_to_http(exc)
    return {"attempt_id": attempt.id, "status": attempt.status}


def _lease_error_to_http(exc: LeaseError) -> HTTPException:
    if exc.kind in ("stale_generation", "state_mismatch"):
        return HTTPException(status.HTTP_409_CONFLICT, detail={"kind": "lease_stale", "msg": str(exc)})
    if exc.kind == "not_found":
        return HTTPException(status.HTTP_404_NOT_FOUND, str(exc))
    return HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))


__all__ = ["PROTOCOL_VERSION", "router"]
