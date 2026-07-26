# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownLambdaType=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUntypedFunctionDecorator=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportUnannotatedClassAttribute=false, reportImplicitOverride=false, reportPrivateUsage=false

"""SPEC-144: ExecutorProtocolClient — async httpx with bounded retry semantics."""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
from apo.executor.client import (
    ClaimedTaskAssignment,
    CredentialRejected,
    LeaseStale,
    ExecutorProtocolClient,
)


def _resp(status: int, body: "object" = None, *, headers: dict[str, str] | None = None) -> httpx.Response:
    import json

    return httpx.Response(
        status,
        content=json.dumps(body).encode() if body is not None else b"",
        headers={"x-apo-executor-protocol": "1", **(headers or {})},
        request=httpx.Request("POST", "http://x"),
    )


class _FakeTransport(httpx.AsyncBaseTransport):
    """Replays a queue of (status, body) responses, recording requests."""

    def __init__(self, responses: list[tuple[int, "object"]]) -> None:
        self._responses = list(responses)
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if not self._responses:
            raise AssertionError("no more canned responses")
        item = self._responses.pop(0)
        if isinstance(item, Exception):
            raise item
        status, body = item  # type: ignore[misc]
        return _resp(status, body)


def _client_with(transport: httpx.AsyncBaseTransport) -> ExecutorProtocolClient:
    http = httpx.AsyncClient(transport=transport, base_url="http://control-plane")
    return ExecutorProtocolClient(control_plane_url="http://control-plane", http_client=http)


def _assignment() -> ClaimedTaskAssignment:
    return ClaimedTaskAssignment(
        attempt_id="a1",
        task_run_id="r1",
        batch_run_id="b1",
        task_id="t1",
        task_path="tasks/t1",
        environment="default",
        timeout_seconds=600,
        project="p1",
        lease_generation=3,
        lease_expires_at=datetime.now(timezone.utc),
        attempt_jwt="jwt-token",
        task_revision_id="rev-1",
        content_sha256="a" * 64,
        bundle_sha256="b" * 64,
        bundle_size_bytes=123,
        bundle_url="/v1/executor-protocol/v1/attempts/a1/bundle",
        trace_endpoint="http://control-plane",
        trace_required=True,
        result_max_bytes=10 * 1024 * 1024,
        diagnostic_tail_bytes=64 * 1024,
    )


@pytest.mark.asyncio
async def test_enroll_returns_state() -> None:
    transport = _FakeTransport([(200, {
        "executor_id": "ex-1", "credential": "apo_ex_xyz",
        "heartbeat_interval_seconds": 20, "lease_ttl_seconds": 90,
    })])
    client = _client_with(transport)
    state = await client.enroll(token="apo_enroll_t", name="bundled-1", capabilities={
        "protocol_version": 1, "executor_version": "v", "driver_kinds": ["subprocess"],
        "os": "linux", "architecture": "x86_64", "runtimes": {}, "max_concurrency": 1,
    })
    assert state.executor_id == "ex-1"
    assert state.executor_credential == "apo_ex_xyz"


@pytest.mark.asyncio
async def test_claim_returns_none_on_204() -> None:
    transport = _FakeTransport([(204, None)])
    client = _client_with(transport)
    await client.set_credential("apo_ex_x")
    assignment = await client.claim(accepted_driver_kinds=["subprocess"])
    assert assignment is None


@pytest.mark.asyncio
async def test_claim_returns_assignment_and_sets_attempt_context() -> None:
    transport = _FakeTransport([(200, _assignment().model_dump(mode="json"))])
    client = _client_with(transport)
    await client.set_credential("apo_ex_x")
    assignment = await client.claim(accepted_driver_kinds=["subprocess"])
    assert isinstance(assignment, ClaimedTaskAssignment)
    assert assignment.attempt_id == "a1"
    assert assignment.attempt_jwt == "jwt-token"


@pytest.mark.asyncio
async def test_transient_5xx_is_retried_then_succeeds() -> None:
    transport = _FakeTransport([
        (503, {"detail": "transient"}),
        (200, {"status": "running"}),
    ])
    client = _client_with(transport)
    client._backoff = lambda attempt: 0.0  # no real delay in tests
    await client.set_credential("apo_ex_x")
    resp = await client.start_attempt(
        _assignment(),
        driver_kind="subprocess",
        runtime={},
    )
    assert resp["status"] == "running"


@pytest.mark.asyncio
async def test_401_credential_not_retried() -> None:
    transport = _FakeTransport([(401, {"detail": "bad credential"})])
    client = _client_with(transport)
    client._backoff = lambda attempt: 0.0
    await client.set_credential("apo_ex_x")
    with pytest.raises(CredentialRejected):
        await client.executor_heartbeat()


@pytest.mark.asyncio
async def test_409_lease_stale_not_retried() -> None:
    transport = _FakeTransport([(409, {"detail": {"kind": "lease_stale"}})])
    client = _client_with(transport)
    client._backoff = lambda attempt: 0.0
    await client.set_credential("apo_ex_x")
    with pytest.raises(LeaseStale):
        await client.heartbeat_attempt(_assignment(), phase="running")


@pytest.mark.asyncio
async def test_network_error_is_retried_then_raises() -> None:
    transport = _FakeTransport([
        httpx.ConnectError("boom"),
        httpx.ConnectError("boom"),
        httpx.ConnectError("boom"),
    ])
    client = _client_with(transport)
    client._backoff = lambda attempt: 0.0
    client._max_retries = 2
    await client.set_credential("apo_ex_x")
    with pytest.raises(httpx.HTTPError):
        await client.executor_heartbeat()


@pytest.mark.asyncio
async def test_submit_result_sends_completion() -> None:
    transport = _FakeTransport([(200, {"status": "succeeded"})])
    client = _client_with(transport)
    client._backoff = lambda attempt: 0.0
    await client.set_credential("apo_ex_x")
    resp = await client.submit_result(
        _assignment(),
        completion_id="c1", pass_result=True, checks=[{"name": "x", "pass": True}],
    )
    assert resp["status"] == "succeeded"


@pytest.mark.asyncio
async def test_download_bundle_streams_exact_authenticated_object(tmp_path: Path) -> None:
    payload = b"verified bundle bytes"
    seen_authorization: str | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal seen_authorization
        seen_authorization = request.headers.get("authorization")
        return httpx.Response(200, content=payload, request=request)

    assignment = _assignment().model_copy(
        update={
            "bundle_size_bytes": len(payload),
            "bundle_sha256": hashlib.sha256(payload).hexdigest(),
        }
    )
    client = _client_with(httpx.MockTransport(handler))
    destination = tmp_path / "cache" / "bundle.tar.gz"

    returned = await client.download_bundle(assignment, destination=destination)

    assert returned == destination
    assert destination.read_bytes() == payload
    assert destination.stat().st_mode & 0o777 == 0o600
    assert seen_authorization == "Bearer jwt-token"


@pytest.mark.asyncio
async def test_download_bundle_removes_partial_on_size_mismatch(tmp_path: Path) -> None:
    payload = b"too short"

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=payload, request=request)

    assignment = _assignment().model_copy(
        update={
            "bundle_size_bytes": len(payload) + 1,
            "bundle_sha256": hashlib.sha256(payload).hexdigest(),
        }
    )
    client = _client_with(httpx.MockTransport(handler))
    destination = tmp_path / "bundle.tar.gz"

    with pytest.raises(ValueError, match="size mismatch"):
        await client.download_bundle(assignment, destination=destination)

    assert not destination.exists()
