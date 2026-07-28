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
import json
import logging
import os
import pwd
from pathlib import Path
from typing import TYPE_CHECKING, cast, final

from apo.executor.client import (
    ClaimedTaskAssignment,
    CompletionConflict,
    CredentialRejected,
    ExecutorProtocolClient,
    LeaseStale,
)
from apo.executor.config import ExecutorConfig
from apo.executor.drivers.base import DriverResult, Heartbeat
from apo.executor.drivers.subprocess import SubprocessExecutionDriver
from apo.executor.state import ExecutorState, load_state, save_state
from apo.executor.workspace import cleanup_workspace, make_workspace, result_path
from apo.executor.workspace import prepare_workspace_for_user
from apo.execution.execution_bundle import (
    BundleError,
    extract_verified_bundle,
    verify_bundle_file,
)
from apo.services.task_dependency_installer import (
    TaskDependencyInstallError,
    install_task_dependencies,
)

if TYPE_CHECKING:
    from apo.executor.drivers.base import ExecutionDriver

logger = logging.getLogger(__name__)


@final
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
        self._driver: "ExecutionDriver" = driver or SubprocessExecutionDriver(
            task_user=config.task_user
        )
        self._bundle_cache = bundle_cache_dir or Path(config.state_dir) / "bundle-cache"
        self._stop = asyncio.Event()
        self._state: ExecutorState | None = None
        self._active: set[asyncio.Task[None]] = set()

    def request_shutdown(self) -> None:
        _ = self._stop.set()

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
                    _ = await asyncio.wait_for(self._stop.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    pass
        finally:
            _ = heartbeat_task.cancel()
            _ = await asyncio.gather(heartbeat_task, return_exceptions=True)
            if self._active:
                _ = await asyncio.gather(*self._active, return_exceptions=True)
            await self._client.aclose()

    def _has_capacity(self) -> bool:
        return len(self._active) < self._config.max_concurrency

    async def _resolve_identity(self) -> None:
        state_path = Path(self._config.state_dir) / "state.json"
        self._state = load_state(state_path)
        if self._state is not None:
            self._delete_bootstrap_token()
            await self._client.set_credential(self._state.executor_credential)
            return
        token = self._config.enrollment_token
        if not token:
            logger.error("no persisted state and no enrollment token; cannot start")
            return
        capabilities: dict[str, object] = {
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
        _ = os.environ.pop("APO_EXECUTOR_ENROLLMENT_TOKEN", None)
        self._delete_bootstrap_token()

    def _delete_bootstrap_token(self) -> None:
        if self._config.enrollment_token_file is not None:
            Path(self._config.enrollment_token_file).unlink(missing_ok=True)

    async def _heartbeat_loop(self) -> None:
        interval = 20  # EXECUTOR_HEARTBEAT_SECONDS
        while not self._stop.is_set():
            try:
                await self._client.executor_heartbeat()
            except CredentialRejected:
                logger.warning("executor credential rejected during heartbeat; stopping")
                _ = self._stop.set()
                return
            except Exception:
                pass  # transient; retry next interval
            try:
                _ = await asyncio.wait_for(self._stop.wait(), timeout=interval)
            except asyncio.TimeoutError:
                pass

    async def _run_assignment(self, assignment: ClaimedTaskAssignment) -> None:
        """The 12-step assignment flow. Workspace is always cleaned up."""
        workspace = make_workspace(Path(self._config.workspace_root), assignment.attempt_id)
        cancel = asyncio.Event()
        completion_id = f"{assignment.attempt_id}-{assignment.lease_generation}"

        async def heartbeat(phase: str) -> bool:
            try:
                response = await self._client.heartbeat_attempt(
                    assignment,
                    phase=phase,
                )
                if response.get("cancel_requested") is True:
                    cancel.set()
                    return False
                return True
            except LeaseStale:
                cancel.set()
                return False
            except Exception:
                return True  # transient: keep running, do not abandon on a blip

        try:
            try:
                await self._prepare_bundle(assignment, workspace)
            except (BundleError, ValueError) as exc:
                _ = await self._client.submit_failure(
                    assignment,
                    completion_id=completion_id,
                    failure_kind="bundle_invalid",
                    error_message=str(exc),
                )
                return

            task_dir = workspace / assignment.task_path
            if not task_dir.is_dir():
                _ = await self._client.submit_failure(
                    assignment,
                    completion_id=completion_id,
                    failure_kind="task_import",
                    error_message=(
                        f"Task directory is absent from the verified bundle: "
                        f"{assignment.task_path}"
                    ),
                )
                return

            rpath = result_path(workspace)
            prepare_workspace_for_user(workspace, self._config.task_user)

            # /start before any customer-controlled code (bundle install/imports).
            try:
                _ = await self._client.start_attempt(
                    assignment,
                    driver_kind=self._driver.kind, runtime={"node": "22"}
                )
            except LeaseStale:
                return  # lease gone before we began; nothing to submit

            task_env = self._build_task_env(
                assignment,
                task_dir=task_dir,
                result_file=rpath,
            )
            try:
                await self._install_dependencies(
                    workspace,
                    task_env=task_env,
                    heartbeat=heartbeat,
                    cancel=cancel,
                )
            except TaskDependencyInstallError as exc:
                _ = await self._client.submit_failure(
                    assignment,
                    completion_id=completion_id,
                    failure_kind="dependency_install",
                    error_message=str(exc),
                )
                return

            runner_argv = self._runner_argv()

            driver_result: DriverResult = await self._driver.execute(
                workspace,
                heartbeat=heartbeat,
                cancel_event=cancel,
                runner_argv=runner_argv,
                task_env=task_env,
                result_path=rpath,
                timeout_seconds=min(
                    self._config.task_timeout_seconds,
                    assignment.timeout_seconds,
                ),
            )
            await self._submit(assignment, completion_id, driver_result)
        except LeaseStale:
            return  # heartbeat reported stale; do not submit a normal result
        except Exception as exc:
            logger.exception("assignment %s failed unexpectedly", assignment.attempt_id)
            try:
                _ = await self._client.submit_failure(
                    assignment,
                    completion_id=completion_id, failure_kind="internal",
                    error_message=str(exc),
                )
            except Exception:
                pass
        finally:
            cleanup_workspace(workspace)

    async def _prepare_bundle(
        self,
        assignment: ClaimedTaskAssignment,
        workspace: Path,
    ) -> None:
        """Download, verify, cache, and extract the exact claimed Revision."""
        self._bundle_cache.mkdir(parents=True, exist_ok=True)
        self._bundle_cache.chmod(0o700)
        cached = self._bundle_cache / f"{assignment.bundle_sha256}.tar.gz"

        verified = None
        if cached.is_file():
            try:
                verified = verify_bundle_file(
                    cached,
                    expected_bundle_sha256=assignment.bundle_sha256,
                )
                if verified.content_sha256 != assignment.content_sha256:
                    raise BundleError(
                        "digest",
                        "bundle manifest does not match claimed revision digest",
                    )
            except (BundleError, OSError):
                cached.unlink(missing_ok=True)
                verified = None

        if verified is None:
            temporary = self._bundle_cache / (
                f".{assignment.attempt_id}-{assignment.lease_generation}.part"
            )
            _ = await self._client.download_bundle(
                assignment,
                destination=temporary,
            )
            verified = verify_bundle_file(
                temporary,
                expected_bundle_sha256=assignment.bundle_sha256,
            )
            if verified.content_sha256 != assignment.content_sha256:
                temporary.unlink(missing_ok=True)
                raise BundleError(
                    "digest",
                    "bundle manifest does not match claimed revision digest",
                )
            _ = temporary.replace(cached)
            cached.chmod(0o600)
            verified = verify_bundle_file(
                cached,
                expected_bundle_sha256=assignment.bundle_sha256,
            )

        extract_verified_bundle(verified, workspace)

    async def _install_dependencies(
        self,
        workspace: Path,
        *,
        task_env: dict[str, str],
        heartbeat: Heartbeat,
        cancel: asyncio.Event,
    ) -> None:
        install = asyncio.create_task(
            asyncio.to_thread(
                install_task_dependencies,
                workspace,
                env=task_env,
                task_user=self._config.task_user,
            )
        )
        while not install.done():
            done, _pending = await asyncio.wait({install}, timeout=5)
            if install in done:
                break
            if not await heartbeat("preparing"):
                cancel.set()
        await install

    def _build_task_env(
        self,
        assignment: ClaimedTaskAssignment,
        *,
        task_dir: Path,
        result_file: Path,
    ) -> dict[str, str]:
        """Filtered child env: process essentials + allowlisted providers + task-scoped values."""
        deny = {
            "AUTH_SECRET", "DATABASE_URL", "POSTGRES_PASSWORD", "ADMIN_API_KEY",
            "API_KEY_SALT", "GITHUB_CLIENT_SECRET", "GITHUB_TOKEN_ENCRYPTION_KEY",
            "APO_EXECUTOR_ENROLLMENT_TOKEN",
        }
        essentials = {"PATH", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP"}
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
        env.update(self._task_identity_env())
        env.update({
            "AGENT_TASK_RUN_ID": assignment.task_run_id,
            "AGENT_TASK_DIR": str(task_dir),
            "AGENT_TASK_PROJECT": assignment.project,
            "AGENT_TASK_TRACE_PROJECT": assignment.project,
            "AGENT_TASK_ENVIRONMENT": assignment.environment,
            "AGENT_TASK_TRACE_ENDPOINT": assignment.trace_endpoint,
            "AGENT_TASK_TRACE_REQUIRED": (
                "true" if assignment.trace_required else "false"
            ),
            "APO_AUTH_TOKEN": assignment.attempt_jwt,
            "AGENT_TASK_RESULT_PATH": str(result_file),
        })
        if assignment.run_metadata is not None:
            env["AGENT_TASK_RUN_METADATA"] = json.dumps(
                assignment.run_metadata,
                separators=(",", ":"),
            )
        return env

    def _task_identity_env(self) -> dict[str, str]:
        if self._config.task_user is None:
            return {
                key: value
                for key in ("HOME", "USER", "LOGNAME", "SHELL")
                if (value := os.environ.get(key)) is not None
            }
        try:
            account = pwd.getpwnam(self._config.task_user)
        except KeyError as exc:
            raise ValueError(
                f"configured task user does not exist: {self._config.task_user!r}"
            ) from exc
        return {
            "HOME": account.pw_dir,
            "USER": account.pw_name,
            "LOGNAME": account.pw_name,
            "SHELL": account.pw_shell or "/bin/sh",
        }

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
            try:
                _ = await self._client.submit_failure(
                    assignment,
                    completion_id=completion_id,
                    failure_kind="cancelled",
                    error_message="Execution cancelled by Control Plane",
                    exit_code=result.exit_code,
                    stdout_tail=result.stdout_tail,
                    stderr_tail=result.stderr_tail,
                )
            except Exception as exc:
                logger.warning(
                    "failed to submit cancelled failure for assignment %s: %s",
                    assignment.attempt_id, exc,
                )
            return
        if result.task_result is not None:
            tr = result.task_result
            try:
                _ = await self._client.submit_result(
                    assignment,
                    completion_id=completion_id,
                    pass_result=bool(tr.get("pass")),
                    adapter_name=_opt_str(tr, "adapterName"),
                    trace_run_id=_opt_str(tr, "traceRunId"),
                    checks=_opt_list(tr, "checks"),
                    deliverables=_opt_dict(tr, "deliverables"),
                    exit_code=result.exit_code,
                    stdout_tail=result.stdout_tail,
                    stderr_tail=result.stderr_tail,
                    run_configuration=_opt_run_configuration(tr.get("runConfiguration")),
                )
                return
            except CompletionConflict:
                return  # already finalized with this completion id
        kind = result.failure_kind or "task_runtime"
        if result.timed_out:
            kind = "timeout"
        try:
            _ = await self._client.submit_failure(
                assignment,
                completion_id=completion_id, failure_kind=kind,
                error_message=result.error_message, exit_code=result.exit_code,
                stdout_tail=result.stdout_tail, stderr_tail=result.stderr_tail,
            )
        except Exception as exc:
            # Never lose the diagnostic: if the Control Plane rejects the
            # failure report (e.g. an unknown failure_kind -> 400), log the
            # stderr tail so the cause is traceable instead of vanishing.
            logger.error(
                "failed to submit %s failure for assignment %s (stderr tail): %s",
                kind, assignment.attempt_id, result.stderr_tail,
            )
            logger.debug("failure submission error detail", exc_info=exc)


def _opt_str(d: dict[str, object], key: str) -> str | None:
    v = d.get(key)
    return str(v) if isinstance(v, str) else None


def _opt_run_configuration(value: object) -> dict[str, object] | None:
    """SPEC-148: parse the runner's runConfiguration JSON into a request body.

    Returns ``None`` when absent/malformed; the finalizer validates and
    normalizes before persisting.
    """
    if not isinstance(value, dict):
        return None
    model = value.get("model")
    if not isinstance(model, str):
        return None
    effort = value.get("effort")
    out: dict[str, object] = {"model": model}
    if isinstance(effort, str):
        out["effort"] = effort
    return out


def _opt_list(d: dict[str, object], key: str) -> list[dict[str, object]] | None:
    value = d.get(key)
    if not isinstance(value, list):
        return None
    result: list[dict[str, object]] = []
    for item in cast(list[object], value):
        normalized = _string_keyed_dict(item)
        if normalized is None:
            return None
        result.append(normalized)
    return result


def _opt_dict(d: dict[str, object], key: str) -> dict[str, object] | None:
    return _string_keyed_dict(d.get(key))


def _string_keyed_dict(value: object) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None
    source = cast(dict[object, object], value)
    result: dict[str, object] = {}
    for key, item in source.items():
        if not isinstance(key, str):
            return None
        result[key] = item
    return result


__all__ = ["BundledExecutorAgent"]
