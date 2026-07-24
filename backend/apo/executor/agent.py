"""SPEC-144: Bundled Executor agent — the connect lifecycle.

Owns protocol sequencing: load persisted state or enroll, heartbeat + claim
loop, and the per-assignment flow (bundle download/verify/extract -> /start ->
filtered env -> driver -> result/failure -> workspace cleanup). The driver
never calls the Control Plane; this agent does. Default concurrency is one; each
Attempt has independent workspace, heartbeat, and cancellation state.

This is the trusted-host Bundled Executor, not a sandbox.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

from apo.executor.bounded_output import BoundedOutput  # noqa: F401  (public re-export)
from apo.executor.client import (
    ClaimedTaskAssignment,
    CompletionConflict,
    CredentialRejected,
    ExecutorProtocolClient,
    LeaseStale,
)
from apo.executor.config import ExecutorConfig
from apo.executor.drivers.base import DriverResult
from apo.executor.drivers.subprocess import SubprocessExecutionDriver
from apo.executor.state import ExecutorState, load_state, save_state
from apo.executor.workspace import cleanup_workspace, make_workspace, result_path

if TYPE_CHECKING:
    from apo.executor.drivers.base import ExecutionDriver

logger = logging.getLogger(__name__)


class BundledExecutorAgent:
    def __init__(
        self,
        config: ExecutorConfig,
        *,
        client: ExecutorProtocolClient,
        driver: "ExecutionDriver | None" = None,
        bundle_cache_dir: Path | None = None,
    ) -> None:
        self._config = config
        self._client = client
        self._driver: "ExecutionDriver" = driver or SubprocessExecutionDriver()
        self._bundle_cache = bundle_cache_dir or Path(config.state_dir) / "bundle-cache"
        self._stop = asyncio.Event()
        self._state: ExecutorState | None = None
        self._active: set[asyncio.Task[None]] = set()

    def request_shutdown(self) -> None:
        self._stop.set()

    async def run(self) -> None:
        """Main lifecycle: resolve identity, then heartbeat + claim until shutdown."""
        await self._resolve_identity()
        if self._state is None:
            return  # revoked/unrecoverable before claiming

        heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        try:
            while not self._stop.is_set():
                if self._has_capacity():
                    try:
                        assignment = await self._client.claim(
                            accepted_driver_kinds=[self._driver.kind]
                        )
                    except CredentialRejected:
                        logger.warning("executor credential rejected; stopping")
                        break
                    if assignment is not None:
                        task = asyncio.create_task(self._run_assignment(assignment))
                        self._active.add(task)
                        task.add_done_callback(self._active.discard)
                # Back off briefly between claim polls (the server also signals Retry-After).
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    pass
        finally:
            heartbeat_task.cancel()
            await asyncio.gather(heartbeat_task, return_exceptions=True)
            if self._active:
                await asyncio.gather(*self._active, return_exceptions=True)
            await self._client.aclose()

    def _has_capacity(self) -> bool:
        return len(self._active) < self._config.max_concurrency

    async def _resolve_identity(self) -> None:
        state_path = Path(self._config.state_dir) / "state.json"
        self._state = load_state(state_path)
        if self._state is not None:
            await self._client.set_credential(self._state.executor_credential)
            return
        token = self._config.enrollment_token
        if not token:
            logger.error("no persisted state and no enrollment token; cannot start")
            return
        capabilities = {
            "protocol_version": 1,
            "executor_version": "apo-bundled-1",
            "driver_kinds": [self._driver.kind],
            "os": os.uname().sysname,
            "architecture": os.uname().machine,
            "runtimes": {"node": "22"},
            "max_concurrency": self._config.max_concurrency,
        }
        self._state = await self._client.enroll(
            token=token, name=self._config.name, capabilities=capabilities
        )
        await self._client.set_credential(self._state.executor_credential)
        # Persist state, then purge the one-time token from the environment.
        save_state(state_path, self._state)
        os.environ.pop("APO_EXECUTOR_ENROLLMENT_TOKEN", None)

    async def _heartbeat_loop(self) -> None:
        interval = 20  # EXECUTOR_HEARTBEAT_SECONDS
        while not self._stop.is_set():
            try:
                await self._client.executor_heartbeat()
            except CredentialRejected:
                logger.warning("executor credential rejected during heartbeat; stopping")
                self._stop.set()
                return
            except Exception:
                pass  # transient; retry next interval
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=interval)
            except asyncio.TimeoutError:
                pass

    async def _run_assignment(self, assignment: ClaimedTaskAssignment) -> None:
        """The 12-step assignment flow. Workspace is always cleaned up."""
        workspace = make_workspace(Path(self._config.workspace_root), assignment.attempt_id)
        cancel = asyncio.Event()
        completion_id = f"{assignment.attempt_id}-{assignment.lease_generation}"

        async def heartbeat(phase: str) -> bool:
            try:
                await self._client.heartbeat_attempt(phase=phase)
                return True
            except LeaseStale:
                cancel.set()
                return False
            except Exception:
                return True  # transient: keep running, do not abandon on a blip

        try:
            # /start before any customer-controlled code (bundle install/imports).
            try:
                await self._client.start_attempt(
                    driver_kind=self._driver.kind, runtime={"node": "22"}
                )
            except LeaseStale:
                return  # lease gone before we began; nothing to submit

            task_env = self._build_task_env(assignment)
            rpath = result_path(workspace)
            runner_argv = self._runner_argv()

            driver_result: DriverResult = await self._driver.execute(
                workspace,
                heartbeat=heartbeat,
                cancel_event=cancel,
                runner_argv=runner_argv,
                task_env=task_env,
                result_path=rpath,
                timeout_seconds=self._config.task_timeout_seconds,
            )
            await self._submit(assignment, completion_id, driver_result)
        except LeaseStale:
            return  # heartbeat reported stale; do not submit a normal result
        except Exception as exc:
            logger.exception("assignment %s failed unexpectedly", assignment.attempt_id)
            try:
                await self._client.submit_failure(
                    completion_id=completion_id, failure_kind="internal",
                    error_message=str(exc),
                )
            except Exception:
                pass
        finally:
            cleanup_workspace(workspace)

    def _build_task_env(self, assignment: ClaimedTaskAssignment) -> dict[str, str]:
        """Filtered child env: process essentials + allowlisted providers + task-scoped values."""
        deny = {
            "AUTH_SECRET", "DATABASE_URL", "POSTGRES_PASSWORD", "ADMIN_API_KEY",
            "API_KEY_SALT", "GITHUB_CLIENT_SECRET", "GITHUB_TOKEN_ENCRYPTION_KEY",
            "APO_EXECUTOR_ENROLLMENT_TOKEN",
        }
        essentials = {"PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "USER", "SHELL"}
        env: dict[str, str] = {}
        for key in essentials:
            val = os.environ.get(key)
            if val is not None:
                env[key] = val
        for key in self._config.env_allowlist:
            if key in deny:
                continue
            val = os.environ.get(key)
            if val is not None:
                env[key] = val
        env.update({
            "AGENT_TASK_RUN_ID": assignment.task_run_id,
            "AGENT_TASK_TRACE_PROJECT": assignment.project,
            "AGENT_TASK_TRACE_REQUIRED": "true",
            "APO_AUTH_TOKEN": assignment.attempt_jwt,
            "AGENT_TASK_RESULT_PATH": str(Path(self._config.workspace_root) / "result"),
        })
        return env

    def _runner_argv(self) -> list[str]:
        """Resolve the packaged Node runner argv (mirrors agent_task_runtime)."""
        runtime_dir = os.environ.get("AGENT_TASK_RUNTIME_DIR", "/app/agent-task-runtime")
        runner = Path(runtime_dir) / "runner.mjs"
        node = os.environ.get("APO_EXECUTOR_NODE_BIN", "node")
        return [node, "--experimental-strip-types", str(runner)]

    async def _submit(
        self, assignment: ClaimedTaskAssignment, completion_id: str, result: DriverResult
    ) -> None:
        if result.cancelled:
            return  # do not submit a normal result on cancellation
        if result.task_result is not None:
            tr = result.task_result
            try:
                await self._client.submit_result(
                    completion_id=completion_id,
                    pass_result=bool(tr.get("pass")),
                    adapter_name=_opt_str(tr, "adapterName"),
                    trace_run_id=_opt_str(tr, "traceRunId"),
                    checks=_opt_list(tr, "checks"),
                    exit_code=result.exit_code,
                    stdout_tail=result.stdout_tail,
                    stderr_tail=result.stderr_tail,
                )
                return
            except CompletionConflict:
                return  # already finalized with this completion id
        kind = result.failure_kind or "task_runtime"
        if result.timed_out:
            kind = "timeout"
        try:
            _ = await self._client.submit_failure(
                completion_id=completion_id, failure_kind=kind,
                error_message=result.error_message, exit_code=result.exit_code,
                stdout_tail=result.stdout_tail, stderr_tail=result.stderr_tail,
            )
        except Exception:
            pass


def _opt_str(d: dict[str, object], key: str) -> str | None:
    v = d.get(key)
    return str(v) if isinstance(v, str) else None


def _opt_list(d: dict[str, object], key: str) -> list[dict[str, object]] | None:
    v = d.get(key)
    return v if isinstance(v, list) else None


__all__ = ["BundledExecutorAgent"]
