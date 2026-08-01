# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownLambdaType=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUntypedFunctionDecorator=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportUnusedFunction=false, reportUnannotatedClassAttribute=false, reportUnusedParameter=false

"""BundledExecutorAgent lifecycle against a fake client + stub driver."""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest
from apo.executor.agent import BundledExecutorAgent
from apo.executor.client import (
    ClaimedTaskAssignment,
    LeaseStale,
)
from apo.executor.config import ExecutorConfig
from apo.executor.drivers.base import DriverResult
from apo.executor.state import ExecutorState
from apo.execution.execution_bundle import (
    BundleEntry,
    verify_bundle_file,
    write_bundle,
)


@pytest.fixture(autouse=True)
def _run_dependency_install_inline(monkeypatch: pytest.MonkeyPatch) -> None:
    """Avoid the restricted test sandbox's thread-creation limitation."""

    async def inline(function: Any, /, *args: Any, **kwargs: Any) -> Any:
        return function(*args, **kwargs)

    monkeypatch.setattr(asyncio, "to_thread", inline)


class _FakeClient:
    def __init__(self) -> None:
        self.heartbeat_calls = 0
        self.start_calls = 0
        self.result_calls: list[dict[str, Any]] = []
        self.failure_calls: list[dict[str, Any]] = []
        self.claim_responses: list[ClaimedTaskAssignment | None] = []
        self._credential: str | None = None
        self.enrolled = False
        self.bundle_bytes = b""

    async def set_credential(self, credential: str) -> None:
        self._credential = credential

    async def enroll(self, *, token: str, name: str, capabilities: dict[str, Any]) -> ExecutorState:
        self.enrolled = True
        return ExecutorState(
            executor_id="ex-1", executor_credential="apo_ex_enrolled",
            control_plane_url="http://cp",
        )

    async def executor_heartbeat(self) -> None:
        self.heartbeat_calls += 1

    async def claim(self, *, accepted_driver_kinds: list[str]) -> ClaimedTaskAssignment | None:
        if not self.claim_responses:
            return None
        return self.claim_responses.pop(0)

    async def download_bundle(
        self,
        assignment: ClaimedTaskAssignment,
        *,
        destination: Path,
    ) -> Path:
        _ = assignment
        _ = destination.write_bytes(self.bundle_bytes)
        return destination

    async def start_attempt(
        self,
        assignment: ClaimedTaskAssignment,
        *,
        driver_kind: str,
        runtime: dict[str, str],
    ) -> dict[str, Any]:
        _ = assignment, driver_kind, runtime
        self.start_calls += 1
        return {"status": "running"}

    async def heartbeat_attempt(
        self,
        assignment: ClaimedTaskAssignment,
        *,
        phase: str,
    ) -> dict[str, Any]:
        _ = assignment, phase
        return {"cancel_requested": False}

    async def submit_result(
        self,
        assignment: ClaimedTaskAssignment,
        **kwargs: Any,
    ) -> dict[str, Any]:
        _ = assignment
        self.result_calls.append(kwargs)
        return {"status": "succeeded"}

    async def submit_failure(
        self,
        assignment: ClaimedTaskAssignment,
        **kwargs: Any,
    ) -> dict[str, Any]:
        _ = assignment
        self.failure_calls.append(kwargs)
        return {"status": "failed"}

    async def aclose(self) -> None:
        pass


class _StubDriver:
    kind = "subprocess"

    def __init__(self, result: DriverResult) -> None:
        self._result = result

    async def execute(self, workspace: Any, *, heartbeat: Any, cancel_event: Any,
                      runner_argv: list[str], task_env: dict[str, str],
                      result_path: Any, timeout_seconds: int) -> DriverResult:
        return self._result


def _config(tmp_path: Path, **overrides: Any) -> ExecutorConfig:
    base = dict(
        control_plane_url="http://backend:8000", name="bundled-1",
        state_dir=str(tmp_path / "state"), max_concurrency=1, driver="subprocess",
        task_user=None, env_allowlist=["MY_VAR"], enrollment_token="apo_enroll_x",
        workspace_root=str(tmp_path / "ws"), task_timeout_seconds=600,
    )
    base.update(overrides)
    return ExecutorConfig(**base)


def _assignment(client: _FakeClient, tmp_path: Path) -> ClaimedTaskAssignment:
    bundle_path = tmp_path / "fixture.tar.gz"
    bundle_size, bundle_sha = write_bundle(
        [
            BundleEntry(
                path="task/task.ts",
                mode_class="regular",
                content=b"export default {};\n",
            )
        ],
        bundle_path,
    )
    verified = verify_bundle_file(
        bundle_path,
        expected_bundle_sha256=bundle_sha,
    )
    client.bundle_bytes = bundle_path.read_bytes()
    return ClaimedTaskAssignment(
        attempt_id="a1", task_run_id="r1", batch_run_id="b1", project="p1",
        task_id="t1", task_path="task", environment="default",
        timeout_seconds=600,
        lease_generation=1, lease_expires_at=datetime.now(timezone.utc),
        attempt_jwt="jwt-1",
        task_revision_id="rev-1",
        content_sha256=verified.content_sha256,
        bundle_sha256=bundle_sha,
        bundle_size_bytes=bundle_size,
        bundle_url="/v1/executor-protocol/v1/attempts/a1/bundle",
        trace_endpoint="http://backend:8000",
        trace_required=True,
        result_max_bytes=10 * 1024 * 1024,
        diagnostic_tail_bytes=64 * 1024,
    )


@pytest.mark.asyncio
async def test_enroll_persists_state_and_purges_token(tmp_path: Path) -> None:
    client = _FakeClient()
    client.claim_responses = []  # nothing to claim -> run exits after one poll
    token_file = tmp_path / "bootstrap-token"
    token_file.write_text("apo_enroll_x\n", encoding="utf-8")
    agent = BundledExecutorAgent(
        _config(tmp_path, enrollment_token_file=str(token_file)),
        client=client,
        driver=_StubDriver(DriverResult()),
    )
    os.environ["APO_EXECUTOR_ENROLLMENT_TOKEN"] = "apo_enroll_x"
    task = asyncio.create_task(agent.run())
    # Let it enroll + poll once, then stop.
    await asyncio.sleep(0.1)
    agent.request_shutdown()
    await asyncio.wait_for(task, timeout=5)
    assert client.enrolled
    assert (tmp_path / "state" / "state.json").exists()
    assert "APO_EXECUTOR_ENROLLMENT_TOKEN" not in os.environ
    assert not token_file.exists()


@pytest.mark.asyncio
async def test_assignment_submits_result_from_driver(tmp_path: Path) -> None:
    client = _FakeClient()
    client.claim_responses = [_assignment(client, tmp_path)]
    driver_result = DriverResult(
        task_result={"pass": True, "adapterName": "openai"}, exit_code=0,
    )
    agent = BundledExecutorAgent(_config(tmp_path), client=client, driver=_StubDriver(driver_result))
    task = asyncio.create_task(agent.run())
    await asyncio.sleep(0.2)
    agent.request_shutdown()
    await asyncio.wait_for(task, timeout=5)
    assert client.start_calls == 1
    assert len(client.result_calls) == 1
    assert client.result_calls[0]["pass_result"] is True
    assert client.failure_calls == []


@pytest.mark.asyncio
async def test_assignment_submits_failure_when_no_result(tmp_path: Path) -> None:
    client = _FakeClient()
    client.claim_responses = [_assignment(client, tmp_path)]
    driver_result = DriverResult(failure_kind="result_invalid", exit_code=0)
    agent = BundledExecutorAgent(_config(tmp_path), client=client, driver=_StubDriver(driver_result))
    task = asyncio.create_task(agent.run())
    await asyncio.sleep(0.2)
    agent.request_shutdown()
    await asyncio.wait_for(task, timeout=5)
    assert client.result_calls == []
    assert len(client.failure_calls) == 1
    assert client.failure_calls[0]["failure_kind"] == "result_invalid"


@pytest.mark.asyncio
async def test_stale_lease_suppresses_result_submission(tmp_path: Path) -> None:
    client = _FakeClient()

    async def start_attempt(
        assignment: ClaimedTaskAssignment,
        *,
        driver_kind: str,
        runtime: dict[str, str],
    ) -> dict[str, Any]:
        _ = assignment, driver_kind, runtime
        raise LeaseStale("stale")

    client.start_attempt = start_attempt  # type: ignore[assignment]
    client.claim_responses = [_assignment(client, tmp_path)]
    agent = BundledExecutorAgent(_config(tmp_path), client=client, driver=_StubDriver(DriverResult()))
    task = asyncio.create_task(agent.run())
    await asyncio.sleep(0.2)
    agent.request_shutdown()
    await asyncio.wait_for(task, timeout=5)
    # No result or failure submitted because the lease was stale at /start.
    assert client.result_calls == []
    assert client.failure_calls == []


@pytest.mark.asyncio
async def test_task_env_excludes_executor_secret_and_includes_attempt_jwt(tmp_path: Path) -> None:
    os.environ["AUTH_SECRET"] = "topsecret"
    os.environ["MY_VAR"] = "allowed"
    os.environ["DATABASE_URL"] = "postgres://x"
    captured: dict[str, str] = {}

    class _CapturingDriver:
        kind = "subprocess"

        async def execute(self, workspace: Any, *, heartbeat: Any, cancel_event: Any,
                          runner_argv: list[str], task_env: dict[str, str],
                          result_path: Any, timeout_seconds: int) -> DriverResult:
            captured.update(task_env)
            return DriverResult(task_result={"pass": True})

    client = _FakeClient()
    client.claim_responses = [_assignment(client, tmp_path)]
    agent = BundledExecutorAgent(_config(tmp_path), client=client, driver=_CapturingDriver())
    task = asyncio.create_task(agent.run())
    await asyncio.sleep(0.2)
    agent.request_shutdown()
    await asyncio.wait_for(task, timeout=5)
    assert "AUTH_SECRET" not in captured
    assert "DATABASE_URL" not in captured
    assert captured["APO_AUTH_TOKEN"] == "jwt-1"
    assert captured["AGENT_TASK_RUN_ID"] == "r1"
    assert captured["AGENT_TASK_PROJECT"] == "p1"
    assert captured["AGENT_TASK_ENVIRONMENT"] == "default"
    assert captured["AGENT_TASK_DIR"].endswith("/task")
    assert captured["AGENT_TASK_RESULT_PATH"].endswith("/.apo-result/result.json")
    assert captured["MY_VAR"] == "allowed"
    os.environ.pop("AUTH_SECRET", None)
    os.environ.pop("MY_VAR", None)
    os.environ.pop("DATABASE_URL", None)


@pytest.mark.asyncio
async def test_corrupt_bundle_fails_before_start(tmp_path: Path) -> None:
    client = _FakeClient()
    assignment = _assignment(client, tmp_path)
    client.bundle_bytes = b"not a valid bundle"
    client.claim_responses = [assignment]
    agent = BundledExecutorAgent(
        _config(tmp_path),
        client=client,
        driver=_StubDriver(DriverResult(task_result={"pass": True})),
    )

    task = asyncio.create_task(agent.run())
    await asyncio.sleep(0.2)
    agent.request_shutdown()
    await asyncio.wait_for(task, timeout=5)

    assert client.start_calls == 0
    assert client.result_calls == []
    assert len(client.failure_calls) == 1
    assert client.failure_calls[0]["failure_kind"] == "bundle_invalid"
