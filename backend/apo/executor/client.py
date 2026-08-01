"""SPEC-144: ExecutorProtocolClient — typed async client for the SPEC-143 protocol.

Uses a long-lived ``httpx.AsyncClient`` with explicit timeouts. Retries
transient network errors and 5xx with capped exponential backoff + jitter, but
NEVER retries authentication failures (401), stale-lease (409 lease_stale), or
terminal completion conflicts (409 completion_conflict). The credential/JWT are
sent only as Bearer headers and never logged.
"""

from __future__ import annotations

import asyncio
import json
import math
import random
from datetime import datetime
from pathlib import Path
from typing import cast, final

import httpx
from pydantic import BaseModel

from apo.executor.state import ExecutorState

_DEFAULT_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=30.0, pool=5.0)
_MAX_RETRIES = 4


class CredentialRejected(Exception):
    """The Control Plane rejected the executor credential (401)."""


class LeaseStale(Exception):
    """The current attempt lease is stale / state-mismatched (409 lease_stale)."""


class CompletionConflict(Exception):
    """A completion_id replayed with a different body (409 completion_conflict)."""


class ClaimedTaskAssignment(BaseModel):
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
    trace_required: bool
    result_max_bytes: int
    diagnostic_tail_bytes: int
    run_metadata: dict[str, object] | None = None


@final
class ExecutorProtocolClient:
    def __init__(
        self,
        *,
        control_plane_url: str,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = control_plane_url.rstrip("/")
        self._http = http_client or httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT)
        self._owns_http = http_client is None
        self._credential: str | None = None
        self._max_retries = _MAX_RETRIES

    def _backoff(self, attempt: int) -> float:
        # Capped exponential backoff with jitter: 0.5s, 1s, 2s, 4s (+jitter).
        exponential = 0.5 * math.pow(2.0, float(attempt))
        return min(8.0, exponential) + random.uniform(0, 0.25)

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def set_credential(self, credential: str) -> None:
        self._credential = credential

    # ── protocol methods ──────────────────────────────────────────────────

    async def enroll(
        self, *, token: str, name: str, capabilities: dict[str, object]
    ) -> ExecutorState:
        body = await self._post(
            "/v1/executor-protocol/v1/enroll",
            {"token": token, "name": name, "capabilities": capabilities},
            auth_token=token,
            retryable=True,
        )
        assert body is not None
        return ExecutorState(
            executor_id=str(body["executor_id"]),
            executor_credential=str(body["credential"]),
            control_plane_url=self._base_url,
        )

    async def executor_heartbeat(self) -> None:
        _ = await self._post(
            "/v1/executor-protocol/v1/heartbeat",
            {},
            auth_credential=True,
            retryable=True,
            expect_204=True,
        )

    async def claim(self, *, accepted_driver_kinds: list[str]) -> ClaimedTaskAssignment | None:
        body = await self._post(
            "/v1/executor-protocol/v1/claims",
            {"available_slots": 1, "accepted_driver_kinds": accepted_driver_kinds},
            auth_credential=True,
            retryable=True,
            allow_204=True,
        )
        if body is None:
            return None
        return ClaimedTaskAssignment.model_validate(body)

    async def start_attempt(
        self,
        assignment: ClaimedTaskAssignment,
        *,
        driver_kind: str,
        runtime: dict[str, str],
    ) -> dict[str, object]:
        # /start is idempotent per generation; transient 5xx is safe to retry
        # (a 409 lease_stale still raises immediately and is not retried).
        return await self._attempt_post(
            assignment,
            "/start", {"driver_kind": driver_kind, "runtime": runtime}, retryable=True
        )

    async def heartbeat_attempt(
        self,
        assignment: ClaimedTaskAssignment,
        *,
        phase: str,
    ) -> dict[str, object]:
        return await self._attempt_post(
            assignment,
            "/heartbeat", {"phase": phase}, retryable=True
        )

    async def submit_result(
        self, assignment: ClaimedTaskAssignment, *, completion_id: str, pass_result: bool,
        adapter_name: str | None = None, trace_run_id: str | None = None,
        checks: list[dict[str, object]] | None = None, exit_code: int | None = None,
        transcript: dict[str, object] | None = None,
        deliverables: dict[str, object] | None = None,
        stdout_tail: str | None = None, stderr_tail: str | None = None,
        error_message: str | None = None,
        run_configuration: dict[str, object] | None = None,
    ) -> dict[str, object]:
        return await self._attempt_post(
            assignment,
            "/result",
            {
                "completion_id": completion_id, "pass_result": pass_result,
                "adapter_name": adapter_name, "trace_run_id": trace_run_id,
                "checks": checks, "transcript": transcript,
                "deliverables": deliverables, "exit_code": exit_code,
                "stdout_tail": stdout_tail, "stderr_tail": stderr_tail,
                "error_message": error_message,
                # adapter-reported model/effort.
                "run_configuration": run_configuration,
            },
            # completion_id idempotency makes a 5xx replay safe (no-op on repeat).
            retryable=True,
        )

    async def submit_failure(
        self, assignment: ClaimedTaskAssignment, *, completion_id: str, failure_kind: str,
        error_message: str | None = None, exit_code: int | None = None,
        stdout_tail: str | None = None, stderr_tail: str | None = None,
    ) -> dict[str, object]:
        return await self._attempt_post(
            assignment,
            "/failure",
            {
                "completion_id": completion_id, "failure_kind": failure_kind,
                "error_message": error_message, "exit_code": exit_code,
                "stdout_tail": stdout_tail, "stderr_tail": stderr_tail,
            },
            retryable=True,
        )

    async def download_bundle(
        self,
        assignment: ClaimedTaskAssignment,
        *,
        destination: Path,
    ) -> Path:
        """Stream one exact bounded Bundle into a supervisor-owned file."""
        import hashlib

        path = destination
        path.parent.mkdir(parents=True, exist_ok=True)
        path.parent.chmod(0o700)
        url = f"{self._base_url}{assignment.bundle_url}"
        digest = hashlib.sha256()
        received = 0
        try:
            async with self._http.stream(
                "GET",
                url,
                headers=self._attempt_header(assignment),
                timeout=_DEFAULT_TIMEOUT,
            ) as resp:
                if resp.status_code == 401:
                    raise CredentialRejected(_detail(resp))
                if resp.status_code == 409:
                    raise LeaseStale(_detail(resp))
                _ = resp.raise_for_status()
                with open(path, "wb") as fh:
                    async for chunk in resp.aiter_bytes(1024 * 1024):
                        received += len(chunk)
                        if received > assignment.bundle_size_bytes:
                            raise ValueError("bundle exceeds declared size")
                        _ = fh.write(chunk)
                        digest.update(chunk)
            if received != assignment.bundle_size_bytes:
                raise ValueError("bundle size mismatch")
            if digest.hexdigest() != assignment.bundle_sha256:
                raise ValueError("bundle sha256 mismatch")
            path.chmod(0o600)
            return path
        except BaseException:
            path.unlink(missing_ok=True)
            raise

    # ── request plumbing ──────────────────────────────────────────────────

    def _attempt_header(
        self,
        assignment: ClaimedTaskAssignment,
    ) -> dict[str, str]:
        return {"Authorization": f"Bearer {assignment.attempt_jwt}"}

    async def _attempt_post(
        self,
        assignment: ClaimedTaskAssignment,
        suffix: str,
        body: dict[str, object],
        *,
        retryable: bool,
    ) -> dict[str, object]:
        url = (
            f"/v1/executor-protocol/v1/attempts/"
            f"{assignment.attempt_id}{suffix}"
        )
        result = await self._post(
            url,
            body,
            auth_token=assignment.attempt_jwt,
            retryable=retryable,
        )
        return result or {}

    async def _post(
        self,
        path: str,
        body: dict[str, object],
        *,
        auth_token: str | None = None,
        auth_credential: bool = False,
        retryable: bool,
        expect_204: bool = False,
        allow_204: bool = False,
    ) -> dict[str, object] | None:
        headers: dict[str, str] = {}
        token = self._credential if auth_credential else auth_token
        if token:
            headers["Authorization"] = f"Bearer {token}"
        url = f"{self._base_url}{path}"

        last_exc: Exception | None = None
        for attempt in range(self._max_retries + 1):
            try:
                resp = await self._http.post(url, json=body, headers=headers)
            except httpx.HTTPError as exc:
                last_exc = exc
                if not retryable or attempt >= self._max_retries:
                    raise
                await asyncio.sleep(self._backoff(attempt))
                continue

            if resp.status_code == 204:
                if expect_204 or allow_204:
                    return None
                return None
            if resp.status_code == 401:
                raise CredentialRejected(_detail(resp))
            if resp.status_code == 409:
                kind = _conflict_kind(resp)
                if kind == "lease_stale":
                    raise LeaseStale(_detail(resp))
                if kind == "completion_conflict":
                    raise CompletionConflict(_detail(resp))
                raise LeaseStale(_detail(resp))
            if 500 <= resp.status_code < 600:
                if not retryable or attempt >= self._max_retries:
                    _ = resp.raise_for_status()
                await asyncio.sleep(self._backoff(attempt))
                continue
            _ = resp.raise_for_status()
            return _decode_json_object(resp.content)
        if last_exc is not None:
            raise last_exc
        raise RuntimeError("request exhausted retries without resolution")


def _detail(resp: httpx.Response) -> str:
    decoded = _decode_json_object(resp.content)
    return str(decoded) if decoded is not None else resp.text


def _conflict_kind(resp: httpx.Response) -> str | None:
    data = _decode_json_object(resp.content)
    if data is None:
        return None
    detail = data.get("detail")
    if isinstance(detail, dict):
        detail_dict = cast(dict[object, object], detail)
        kind = detail_dict.get("kind")
        return str(kind) if kind is not None else None
    if isinstance(detail, str):
        return detail
    return None


def _decode_json_object(content: bytes) -> dict[str, object] | None:
    if not content:
        return None
    try:
        decoded = cast(object, json.loads(content.decode("utf-8")))
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(decoded, dict):
        return None
    source = cast(dict[object, object], decoded)
    result: dict[str, object] = {}
    for key, value in source.items():
        if not isinstance(key, str):
            return None
        result[key] = value
    return result


__all__ = [
    "ClaimedTaskAssignment",
    "CompletionConflict",
    "CredentialRejected",
    "ExecutorProtocolClient",
    "LeaseStale",
]
