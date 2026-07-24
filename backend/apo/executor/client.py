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
import random
from datetime import datetime
from typing import Any

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
    project: str
    lease_generation: int
    lease_expires_at: datetime
    attempt_jwt: str


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
        self._attempt_id: str | None = None
        self._attempt_jwt: str | None = None
        self._attempt_generation: int = 0
        self._max_retries = _MAX_RETRIES

    def _backoff(self, attempt: int) -> float:
        # Capped exponential backoff with jitter: 0.5s, 1s, 2s, 4s (+jitter).
        return min(8.0, 0.5 * (2 ** attempt)) + random.uniform(0, 0.25)

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def set_credential(self, credential: str) -> None:
        self._credential = credential

    async def _set_attempt(self, attempt_id: str, jwt: str, generation: int) -> None:
        self._attempt_id = attempt_id
        self._attempt_jwt = jwt
        self._attempt_generation = generation

    # ── protocol methods ──────────────────────────────────────────────────

    async def enroll(
        self, *, token: str, name: str, capabilities: dict[str, Any]
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
        await self._post(
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
        assignment = ClaimedTaskAssignment.model_validate(body)
        self._attempt_id = assignment.attempt_id
        self._attempt_jwt = assignment.attempt_jwt
        self._attempt_generation = assignment.lease_generation
        return assignment

    async def start_attempt(self, *, driver_kind: str, runtime: dict[str, str]) -> dict[str, Any]:
        # /start is idempotent per generation; transient 5xx is safe to retry
        # (a 409 lease_stale still raises immediately and is not retried).
        return await self._attempt_post(
            "/start", {"driver_kind": driver_kind, "runtime": runtime}, retryable=True
        )

    async def heartbeat_attempt(self, *, phase: str) -> dict[str, Any]:
        return await self._attempt_post(
            "/heartbeat", {"phase": phase}, retryable=True
        )

    async def submit_result(
        self, *, completion_id: str, pass_result: bool,
        adapter_name: str | None = None, trace_run_id: str | None = None,
        checks: list[dict[str, Any]] | None = None, exit_code: int | None = None,
        stdout_tail: str | None = None, stderr_tail: str | None = None,
        error_message: str | None = None,
    ) -> dict[str, Any]:
        return await self._attempt_post(
            "/result",
            {
                "completion_id": completion_id, "pass_result": pass_result,
                "adapter_name": adapter_name, "trace_run_id": trace_run_id,
                "checks": checks, "exit_code": exit_code,
                "stdout_tail": stdout_tail, "stderr_tail": stderr_tail,
                "error_message": error_message,
            },
            # completion_id idempotency makes a 5xx replay safe (no-op on repeat).
            retryable=True,
        )

    async def submit_failure(
        self, *, completion_id: str, failure_kind: str,
        error_message: str | None = None, exit_code: int | None = None,
        stdout_tail: str | None = None, stderr_tail: str | None = None,
    ) -> dict[str, Any]:
        return await self._attempt_post(
            "/failure",
            {
                "completion_id": completion_id, "failure_kind": failure_kind,
                "error_message": error_message, "exit_code": exit_code,
                "stdout_tail": stdout_tail, "stderr_tail": stderr_tail,
            },
            retryable=True,
        )

    async def download_bundle(self, *, destination: "Any", expected_sha256: str | None = None) -> "Any":
        import hashlib
        from pathlib import Path

        path = Path(destination)
        path.parent.mkdir(parents=True, exist_ok=True)
        url = f"{self._base_url}/v1/executor-protocol/v1/attempts/{self._attempt_id}/bundle"
        digest = hashlib.sha256()
        async with self._http.stream(
            "GET", url, headers=self._attempt_header(), timeout=_DEFAULT_TIMEOUT
        ) as resp:
            resp.raise_for_status()
            with open(path, "wb") as fh:
                async for chunk in resp.aiter_bytes(1024 * 1024):
                    fh.write(chunk)
                    digest.update(chunk)
        if expected_sha256 is not None and digest.hexdigest() != expected_sha256:
            raise ValueError("bundle sha256 mismatch")
        return path

    # ── request plumbing ──────────────────────────────────────────────────

    def _attempt_header(self) -> dict[str, str]:
        if not self._attempt_jwt:
            raise RuntimeError("no current attempt JWT")
        return {"Authorization": f"Bearer {self._attempt_jwt}"}

    async def _attempt_post(
        self, suffix: str, body: dict[str, Any], *, retryable: bool
    ) -> dict[str, Any]:
        if not self._attempt_id:
            raise RuntimeError("no current attempt")
        url = f"/v1/executor-protocol/v1/attempts/{self._attempt_id}{suffix}"
        result = await self._post(
            url, body, auth_token=self._attempt_jwt or "", retryable=retryable
        )
        return result or {}

    async def _post(
        self,
        path: str,
        body: dict[str, Any],
        *,
        auth_token: str | None = None,
        auth_credential: bool = False,
        retryable: bool,
        expect_204: bool = False,
        allow_204: bool = False,
    ) -> dict[str, Any] | None:
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
                    resp.raise_for_status()
                await asyncio.sleep(self._backoff(attempt))
                continue
            resp.raise_for_status()
            try:
                return json.loads(resp.content.decode("utf-8")) if resp.content else None
            except (ValueError, json.JSONDecodeError):
                return None
        if last_exc is not None:
            raise last_exc
        raise RuntimeError("request exhausted retries without resolution")


def _detail(resp: httpx.Response) -> str:
    try:
        return str(resp.json())
    except Exception:
        return resp.text


def _conflict_kind(resp: httpx.Response) -> str | None:
    try:
        data = resp.json()
        if isinstance(data, dict):
            detail = data.get("detail")
            if isinstance(detail, dict):
                return str(detail.get("kind"))
            if isinstance(detail, str):
                return detail
    except Exception:
        pass
    return None


__all__ = [
    "ClaimedTaskAssignment",
    "CompletionConflict",
    "CredentialRejected",
    "ExecutorProtocolClient",
    "LeaseStale",
]
