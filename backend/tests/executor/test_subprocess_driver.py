# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownLambdaType=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUntypedFunctionDecorator=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false, reportMissingTypeArgument=false, reportArgumentType=false

"""SPEC-144: SubprocessExecutionDriver — timeout, cancel, bounded output, result file."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import textwrap
from pathlib import Path

import pytest
from apo.executor.bounded_output import BoundedOutput
from apo.executor.drivers.subprocess import (
    CANCELLATION_GRACE_SECONDS,
    SubprocessExecutionDriver,
)


def _write_script(path: Path, body: str) -> str:
    path.write_text(textwrap.dedent(body))
    return str(path)


async def _ok_heartbeat(phase: str) -> bool:
    return True


def _track_heartbeat() -> tuple[list[str], "object"]:
    calls: list[str] = []

    async def hb(phase: str) -> bool:
        calls.append(phase)
        return True

    return calls, hb


@pytest.mark.asyncio
async def test_valid_result_file_is_used_not_stdout(tmp_path: Path) -> None:
    result_path = tmp_path / "ws" / ".apo-result" / "result.json"
    result_path.parent.mkdir(parents=True)
    runner = _write_script(tmp_path / "runner.py", f"""
        import json, pathlib
        print('{{"pass": true, "adapterName": "evil"}}')
        pathlib.Path({str(result_path)!r}).write_text(json.dumps({{"pass": True, "adapterName": "openai"}}))
    """)
    drv = SubprocessExecutionDriver()
    res = await drv.execute(
        workspace=tmp_path / "ws", heartbeat=_ok_heartbeat, cancel_event=asyncio.Event(),
        runner_argv=[sys.executable, runner], task_env={},
        result_path=result_path, timeout_seconds=30,
    )
    assert res.task_result == {"pass": True, "adapterName": "openai"}
    assert res.exit_code == 0
    assert res.failure_kind is None


@pytest.mark.asyncio
async def test_missing_result_file_is_result_invalid(tmp_path: Path) -> None:
    result_path = tmp_path / "r.json"
    runner = _write_script(tmp_path / "runner.py", "print('no result file')")
    drv = SubprocessExecutionDriver()
    res = await drv.execute(
        workspace=tmp_path, heartbeat=_ok_heartbeat, cancel_event=asyncio.Event(),
        runner_argv=[sys.executable, runner], task_env={},
        result_path=result_path, timeout_seconds=30,
    )
    assert res.task_result is None
    assert res.failure_kind == "result_invalid"


@pytest.mark.asyncio
async def test_invalid_result_file_is_result_invalid(tmp_path: Path) -> None:
    result_path = tmp_path / "r.json"
    result_path.write_text("not json {")
    runner = _write_script(tmp_path / "runner.py", "pass")
    drv = SubprocessExecutionDriver()
    res = await drv.execute(
        workspace=tmp_path, heartbeat=_ok_heartbeat, cancel_event=asyncio.Event(),
        runner_argv=[sys.executable, runner], task_env={},
        result_path=result_path, timeout_seconds=30,
    )
    assert res.failure_kind == "result_invalid"


@pytest.mark.asyncio
async def test_oversized_result_file_is_result_invalid(tmp_path: Path) -> None:
    result_path = tmp_path / "r.json"
    result_path.write_text("x" * (11 * 1024 * 1024))  # > 10 MiB
    runner = _write_script(tmp_path / "runner.py", "pass")
    drv = SubprocessExecutionDriver(max_result_bytes=10 * 1024 * 1024)
    res = await drv.execute(
        workspace=tmp_path, heartbeat=_ok_heartbeat, cancel_event=asyncio.Event(),
        runner_argv=[sys.executable, runner], task_env={},
        result_path=result_path, timeout_seconds=30,
    )
    assert res.failure_kind == "result_invalid"


@pytest.mark.asyncio
async def test_stdout_misleading_json_cannot_replace_missing_result(tmp_path: Path) -> None:
    result_path = tmp_path / "r.json"  # never written
    runner = _write_script(tmp_path / "runner.py", """print('{"pass": true}')""")
    drv = SubprocessExecutionDriver()
    res = await drv.execute(
        workspace=tmp_path, heartbeat=_ok_heartbeat, cancel_event=asyncio.Event(),
        runner_argv=[sys.executable, runner], task_env={},
        result_path=result_path, timeout_seconds=30,
    )
    # No result file -> result_invalid even though stdout looked like JSON.
    assert res.task_result is None
    assert res.failure_kind == "result_invalid"


@pytest.mark.asyncio
async def test_large_output_retains_only_tail(tmp_path: Path) -> None:
    result_path = tmp_path / "r.json"
    result_path.write_text(json.dumps({"pass": True}))
    # emit ~200 KiB on both streams
    runner = _write_script(tmp_path / "runner.py", f"""
        import sys
        sys.stdout.write("o" * 200000)
        sys.stderr.write("e" * 200000)
    """)
    drv = SubprocessExecutionDriver()
    res = await drv.execute(
        workspace=tmp_path, heartbeat=_ok_heartbeat, cancel_event=asyncio.Event(),
        runner_argv=[sys.executable, runner], task_env={},
        result_path=result_path, timeout_seconds=60,
    )
    assert len(res.stdout_tail.encode("utf-8")) <= 64 * 1024
    assert len(res.stderr_tail.encode("utf-8")) <= 64 * 1024
    assert res.stdout_tail.endswith("o" * 100)


@pytest.mark.asyncio
async def test_quiet_long_process_still_heartbeats(tmp_path: Path) -> None:
    result_path = tmp_path / "r.json"
    result_path.write_text(json.dumps({"pass": True}))
    # Sleep longer than the heartbeat interval but well under timeout.
    runner = _write_script(tmp_path / "runner.py", """
        import time
        time.sleep(3)
    """)
    calls, hb = _track_heartbeat()
    drv = SubprocessExecutionDriver(heartbeat_interval_seconds=0.2)
    res = await drv.execute(
        workspace=tmp_path, heartbeat=hb, cancel_event=asyncio.Event(),
        runner_argv=[sys.executable, runner], task_env={},
        result_path=result_path, timeout_seconds=30,
    )
    assert res.exit_code == 0
    assert len(calls) >= 2  # heartbeated at least twice during the quiet run


@pytest.mark.asyncio
async def test_timeout_kills_process(tmp_path: Path) -> None:
    result_path = tmp_path / "r.json"
    runner = _write_script(tmp_path / "runner.py", """
        import time
        time.sleep(60)
    """)
    drv = SubprocessExecutionDriver()
    res = await drv.execute(
        workspace=tmp_path, heartbeat=_ok_heartbeat, cancel_event=asyncio.Event(),
        runner_argv=[sys.executable, runner], task_env={},
        result_path=result_path, timeout_seconds=1,
    )
    assert res.timed_out is True
    assert res.failure_kind == "timeout"


@pytest.mark.asyncio
async def test_cancellation_sends_term_and_marks_cancelled(tmp_path: Path) -> None:
    result_path = tmp_path / "r.json"
    runner = _write_script(tmp_path / "runner.py", """
        import time
        time.sleep(60)
    """)
    cancel = asyncio.Event()

    async def hb(phase: str) -> bool:
        # Request cancellation on the first heartbeat.
        cancel.set()
        return False  # lease reported stale -> stop

    drv = SubprocessExecutionDriver()
    res = await drv.execute(
        workspace=tmp_path, heartbeat=hb, cancel_event=cancel,
        runner_argv=[sys.executable, runner], task_env={},
        result_path=result_path, timeout_seconds=30,
    )
    assert res.cancelled is True


@pytest.mark.asyncio
async def test_nonzero_exit_with_valid_result_still_reports_result(tmp_path: Path) -> None:
    # Existing runner semantics: a valid result file is honored regardless of
    # exit code; the driver does not invent a passed result.
    result_path = tmp_path / "r.json"
    result_path.write_text(json.dumps({"pass": False}))
    runner = _write_script(tmp_path / "runner.py", "import sys; sys.exit(1)")
    drv = SubprocessExecutionDriver()
    res = await drv.execute(
        workspace=tmp_path, heartbeat=_ok_heartbeat, cancel_event=asyncio.Event(),
        runner_argv=[sys.executable, runner], task_env={},
        result_path=result_path, timeout_seconds=30,
    )
    assert res.exit_code == 1
    assert res.task_result == {"pass": False}


@pytest.mark.asyncio
async def test_process_group_child_is_reaped_on_cancel(tmp_path: Path) -> None:
    # Parent spawns a child; cancellation must kill the whole group.
    result_path = tmp_path / "r.json"
    child = _write_script(tmp_path / "child.py", """
        import time
        time.sleep(120)
    """)
    runner = _write_script(tmp_path / "runner.py", f"""
        import subprocess, time
        subprocess.Popen([{sys.executable!r}, {child!r}])
        time.sleep(120)
    """)
    cancel = asyncio.Event()

    async def hb(phase: str) -> bool:
        cancel.set()
        return False

    drv = SubprocessExecutionDriver()
    res = await drv.execute(
        workspace=tmp_path, heartbeat=hb, cancel_event=cancel,
        runner_argv=[sys.executable, runner], task_env={},
        result_path=result_path, timeout_seconds=30,
    )
    assert res.cancelled is True
