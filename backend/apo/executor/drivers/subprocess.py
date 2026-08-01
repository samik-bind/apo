"""SubprocessExecutionDriver.

Launches the packaged Node runner in a new process session/group, concurrently
drains stdout/stderr into 64 KiB UTF-8-safe ring-buffer tails (never buffering
whole output), heartbeats during execution, enforces a wall timeout, and on
timeout/cancellation sends ``SIGTERM`` to the group then ``SIGKILL`` after the
grace period. The result comes ONLY from the result file — stdout JSON is
diagnostic and can never replace it. Every child is reaped.

This is trusted-host subprocess execution, not a sandbox.
"""

from __future__ import annotations

import asyncio
import json
import os
import pwd
import signal
from pathlib import Path
from typing import cast, final

from apo.executor.bounded_output import BoundedOutput
from apo.executor.drivers.base import DriverResult, Heartbeat

DEFAULT_TIMEOUT_SECONDS = 600
CANCELLATION_GRACE_SECONDS = 10
STDOUT_TAIL_BYTES = 64 * 1024
DEFAULT_MAX_RESULT_BYTES = 10 * 1024 * 1024  # 10 MiB result-file size cap
_RESULT_INVALID = "result_invalid"


@final
class SubprocessExecutionDriver:
    """Trusted subprocess driver: asyncio subprocess + bounded output + timeout."""

    def __init__(
        self,
        *,
        stdout_tail_bytes: int = STDOUT_TAIL_BYTES,
        heartbeat_interval_seconds: float = 5.0,
        max_result_bytes: int = DEFAULT_MAX_RESULT_BYTES,
        task_user: str | None = None,
    ) -> None:
        self._tail_bytes = stdout_tail_bytes
        self._heartbeat_interval = heartbeat_interval_seconds
        self._max_result_bytes = max_result_bytes
        self._task_user = task_user

    @property
    def kind(self) -> str:
        return "subprocess"

    async def execute(
        self,
        workspace: object,
        *,
        heartbeat: Heartbeat,
        cancel_event: asyncio.Event,
        runner_argv: list[str],
        task_env: dict[str, str],
        result_path: object,
        timeout_seconds: int,
    ) -> DriverResult:
        stdout_buf = BoundedOutput(max_bytes=self._tail_bytes)
        stderr_buf = BoundedOutput(max_bytes=self._tail_bytes)
        env = dict(task_env)
        cwd = str(workspace) if isinstance(workspace, Path) else None
        identity = self._task_identity()

        try:
            if identity is None:
                proc = await asyncio.create_subprocess_exec(
                    *runner_argv,
                    cwd=cwd,
                    env=env,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    start_new_session=True,
                )
            else:
                user_id, group_id = identity
                proc = await asyncio.create_subprocess_exec(
                    *runner_argv,
                    cwd=cwd,
                    env=env,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    start_new_session=True,
                    user=user_id,
                    group=group_id,
                )
        except FileNotFoundError as exc:
            return DriverResult(
                failure_kind="task_runtime", error_message=f"runner not found: {exc}",
                stdout_tail="", stderr_tail=str(exc),
            )

        assert proc.stdout is not None and proc.stderr is not None
        timed_out = False
        cancelled = False

        async def _drain(stream: asyncio.StreamReader, buf: BoundedOutput) -> None:
            while True:
                chunk = await stream.read(64 * 1024)
                if not chunk:
                    break
                buf.append(chunk)

        async def _heartbeat_loop() -> None:
            while proc.returncode is None and not cancel_event.is_set():
                try:
                    ok = await heartbeat("running")
                except Exception:
                    ok = True
                if not ok:
                    _ = cancel_event.set()
                    return
                try:
                    _ = await asyncio.wait_for(
                        cancel_event.wait(),
                        timeout=self._heartbeat_interval,
                    )
                except asyncio.TimeoutError:
                    pass

        drain_stdout = asyncio.create_task(_drain(proc.stdout, stdout_buf))
        drain_stderr = asyncio.create_task(_drain(proc.stderr, stderr_buf))
        hb_task = asyncio.create_task(_heartbeat_loop())
        wait_task: asyncio.Task[int | None] = asyncio.create_task(proc.wait())
        cancel_wait: asyncio.Task[bool] = asyncio.create_task(cancel_event.wait())

        try:
            done, _pending = await asyncio.wait(
                {wait_task, cancel_wait},
                timeout=timeout_seconds,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if wait_task not in done:
                # Process did not exit first: either cancellation or timeout.
                if cancel_wait in done:
                    cancelled = True
                else:
                    timed_out = True
                await self._terminate(proc)
        finally:
            _ = wait_task.cancel()
            _ = cancel_wait.cancel()
            # Ensure streams are drained so tails are complete.
            _ = await asyncio.gather(
                drain_stdout,
                drain_stderr,
                return_exceptions=True,
            )
            _ = hb_task.cancel()
            _ = await asyncio.gather(hb_task, return_exceptions=True)

        exit_code = proc.returncode
        task_result, result_failure = self._read_result(result_path)

        failure_kind: str | None = result_failure
        if timed_out:
            failure_kind = "timeout"
        elif cancelled and failure_kind is None:
            failure_kind = "cancelled"

        return DriverResult(
            task_result=task_result,
            exit_code=exit_code,
            timed_out=timed_out,
            cancelled=cancelled,
            failure_kind=failure_kind,
            error_message=None,
            stdout_tail=stdout_buf.tail(),
            stderr_tail=stderr_buf.tail(),
            driver_metadata={"driver": "subprocess", "pid": proc.pid},
        )

    async def _terminate(self, proc: asyncio.subprocess.Process) -> None:
        """SIGTERM the process group, wait the grace period, then SIGKILL."""
        if proc.returncode is not None:
            return
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            return
        try:
            _ = await asyncio.wait_for(
                proc.wait(),
                timeout=CANCELLATION_GRACE_SECONDS,
            )
            return
        except asyncio.TimeoutError:
            pass
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            return
        try:
            _ = await asyncio.wait_for(proc.wait(), timeout=5)
        except asyncio.TimeoutError:
            pass  # best-effort; the process will be reaped by the OS

    def _read_result(self, result_path: object) -> tuple[dict[str, object] | None, str | None]:
        """Read + validate the result file. Returns (result, failure_kind)."""
        if not isinstance(result_path, Path) or not result_path.exists():
            return None, _RESULT_INVALID
        try:
            raw = result_path.read_bytes()
        except OSError:
            return None, _RESULT_INVALID
        if len(raw) > self._max_result_bytes:
            return None, _RESULT_INVALID
        try:
            parsed = cast(object, json.loads(raw.decode("utf-8")))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None, _RESULT_INVALID
        if not isinstance(parsed, dict):
            return None, _RESULT_INVALID
        parsed_dict = cast(dict[object, object], parsed)
        result: dict[str, object] = {}
        for key, value in parsed_dict.items():
            if not isinstance(key, str):
                return None, _RESULT_INVALID
            result[key] = value
        return result, None

    def _task_identity(self) -> tuple[int, int] | None:
        """Return the configured Task user's uid and gid."""
        if self._task_user is None:
            return None
        try:
            account = pwd.getpwnam(self._task_user)
        except KeyError as exc:
            raise ValueError(
                f"configured task user does not exist: {self._task_user!r}"
            ) from exc
        return account.pw_uid, account.pw_gid


__all__ = [
    "CANCELLATION_GRACE_SECONDS",
    "DEFAULT_TIMEOUT_SECONDS",
    "SubprocessExecutionDriver",
]
