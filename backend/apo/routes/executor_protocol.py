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

from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from jose import JWTError
from pydantic import BaseModel
from sqlmodel import Session

from apo.db import get_session
from apo.models.db import ExecutorDB, TaskExecutionAttemptDB
from apo.models.execution import ExecutorCapabilities
from apo.services.execution_finalization import (
    AttemptFailureBody,
    AttemptResultBody,
    CompletionConflict,
    FinalizationError,
    finalize_attempt_failure,
    finalize_attempt_result,
)
from apo.services.execution_leases import (
    ClaimedAttempt,
    CurrentAttemptLease,
    LeaseError,
    claim_next_attempt,
    heartbeat_attempt,
    request_cancellation,
    start_attempt,
)
from apo.services.executor_auth import (
    ATTEMPT_LEASE_SECONDS,
    EXECUTOR_HEARTBEAT_SECONDS,
    create_attempt_jwt,
    decode_attempt_jwt,
    exchange_enrollment_token,
    resolve_executor_by_credential,
)

router = APIRouter(prefix="/v1/executor-protocol/v1", tags=["executor-protocol"])
PROTOCOL_VERSION = 1
_LEASE_JWT_TTL_SECONDS = 2 * 60 * 60  # covers max task timeout + finalization grace


class EnrollRequest(BaseModel):
    token: str
    name: str
    capabilities: ExecutorCapabilities


class EnrollResponse(BaseModel):
    executor_id: str
    credential: str
    heartbeat_interval_seconds: int
    lease_ttl_seconds: int


class HeartbeatExecRequest(BaseModel):
    pass


class ClaimsRequest(BaseModel):
    available_slots: int = 1
    accepted_driver_kinds: list[str] = []


class ClaimAttemptResponse(BaseModel):
    attempt_id: str
    task_run_id: str
    batch_run_id: str
    project: str
    lease_generation: int
    lease_expires_at: datetime
    attempt_jwt: str


class StartRequest(BaseModel):
    driver_kind: str
    runtime: dict[str, str] = {}


class AttemptHeartbeatRequest(BaseModel):
    phase: str


class ResultRequest(BaseModel):
    completion_id: str
    pass_result: bool
    adapter_name: str | None = None
    trace_run_id: str | None = None
    checks: list[dict[str, object]] | None = None
    exit_code: int | None = None
    stdout_tail: str | None = None
    stderr_tail: str | None = None
    error_message: str | None = None


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
    response: Response,
    session: Session = Depends(get_session),
) -> EnrollResponse:
    """Exchange a one-time enrollment token for a persistent Executor credential."""
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)
    try:
        executor, raw_credential, hb, lease_ttl = exchange_enrollment_token(
            session, raw_token=body.token, name=body.name, capabilities=body.capabilities,
        )
    except Exception:
        raise HTTPException(status.HTTP_410_GONE, "enrollment token invalid or expired")
    return EnrollResponse(
        executor_id=executor.id,
        credential=raw_credential,
        heartbeat_interval_seconds=hb,
        lease_ttl_seconds=lease_ttl,
    )


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
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)
    return ClaimAttemptResponse(
        attempt_id=claimed.attempt.id,
        task_run_id=claimed.attempt.task_run_id,
        batch_run_id=claimed.attempt.batch_run_id,
        project=claimed.attempt.project,
        lease_generation=claimed.lease.lease_generation,
        lease_expires_at=claimed.attempt.lease_expires_at or datetime.now(timezone.utc),
        attempt_jwt=jwt,
    )


@router.get("/attempts/{attempt_id}/bundle")
async def download_bundle(
    attempt_id: str,
    response: Response,
    lease: CurrentAttemptLease = Depends(require_attempt_lease),
    session: Session = Depends(get_session),
) -> Response:
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)
    if lease.attempt_id != attempt_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "attempt token not valid for this attempt")
    # SPEC-144 serves the verified Bundle bytes through this scoped endpoint. For
    # SPEC-143 the endpoint exists, is generation-fenced, and returns 503 until a
    # Bundled Executor is proven.
    raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "bundle download not yet available")


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
                checks=body.checks, exit_code=body.exit_code,
                stdout_tail=body.stdout_tail, stderr_tail=body.stderr_tail,
                error_message=body.error_message,
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
