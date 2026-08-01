"""Execution Driver boundary.

A Driver owns the Executor-local launch mechanism for one assignment. The
initial driver is a trusted subprocess; future Docker/Kubernetes/managed
drivers implement the same interface and do not change Task Run finalization or
the wire protocol. The driver NEVER calls Control Plane finalization directly —
the Executor agent owns protocol sequencing.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Protocol, runtime_checkable

from pydantic import BaseModel


# A heartbeat callback: the driver calls it with a phase string; it returns
# True if the lease is still current (continue), False if stale/cancelled (stop).
Heartbeat = Callable[[str], Awaitable[bool]]


class DriverResult(BaseModel):
    """Bounded outcome of one assignment, independent of how it was launched."""

    task_result: dict[str, object] | None = None
    exit_code: int | None = None
    timed_out: bool = False
    cancelled: bool = False
    failure_kind: str | None = None
    error_message: str | None = None
    stdout_tail: str = ""
    stderr_tail: str = ""
    driver_metadata: dict[str, object] = {}


@runtime_checkable
class ExecutionDriver(Protocol):
    """The Executor-local launch boundary every driver implements."""

    @property
    def kind(self) -> str: ...

    async def execute(
        self,
        workspace: "object",
        *,
        heartbeat: Heartbeat,
        cancel_event: asyncio.Event,
        runner_argv: list[str],
        task_env: dict[str, str],
        result_path: "object",
        timeout_seconds: int,
    ) -> DriverResult: ...


__all__ = ["DriverResult", "ExecutionDriver", "Heartbeat"]
