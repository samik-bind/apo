# pyright: reportAny=false, reportArgumentType=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnusedVariable=false
"""Issue #177: OTLP ingest must not block the event loop.

`receive_otlp_traces` decodes the (optionally gzipped, up to 10 MB) OTLP
payload and persists every span with blocking SQLModel calls. When that ran
directly on the single uvicorn worker's event loop, one busy exporter froze
``/attempts/{id}/heartbeat`` and every other request for the whole ingest —
and a liveness stall is unrecoverable for the lease protocol (see #176).
This pins the same off-loop contract #174 established for /result
finalization: the sync ingest runs in a worker thread while the loop keeps
scheduling.
"""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from typing import Any

from fastapi import BackgroundTasks, Response
from sqlmodel import Session

import apo.routes.otlp_traces as otlp_traces
from apo.routes.otlp_traces import receive_otlp_traces

# One full sync stretch. A blocked loop stalls the ticker by this much per
# stretch; an unblocked one keeps beating every ~50 ms.
SYNC_WORK_SECONDS = 1.0


class _FakeRequest:
    """The slice of ``Request`` the route touches, with auth state preset."""

    def __init__(self, body: bytes) -> None:
        self._body: bytes = body
        self.headers: dict[str, str] = {"content-type": "application/json"}
        self.state: SimpleNamespace = SimpleNamespace(
            project="p1", auth_method=None, service_task_run_id=None
        )
        # No admission controller attribute → the byte-budget path is skipped.
        self.app: SimpleNamespace = SimpleNamespace(state=SimpleNamespace())

    async def body(self) -> bytes:
        return self._body


async def test_otlp_ingest_runs_off_the_event_loop(
    session: Session, monkeypatch: Any
) -> None:
    calls: list[str] = []

    class _SlowReceiver:
        def ingest(self, **kwargs: object) -> Any:
            assert "payload" in kwargs and "session" in kwargs
            time.sleep(SYNC_WORK_SECONDS)  # the heavy decode + span SQL
            calls.append("ingest")
            return SimpleNamespace(
                accepted=1, rejected=0, errors=[], batch_id="batch-1"
            )

    monkeypatch.setattr(otlp_traces, "OtlpReceiver", _SlowReceiver)

    beats: list[float] = []

    async def heartbeat_like_ticker() -> None:
        for _ in range(60):
            beats.append(time.monotonic())
            await asyncio.sleep(0.05)

    ticker = asyncio.create_task(heartbeat_like_ticker())
    # Let the ticker start beating before the sync stretch begins, so beats
    # actually overlap the ingest either way.
    await asyncio.sleep(0.2)
    response = await receive_otlp_traces(
        _FakeRequest(b"{}"),
        Response(),
        BackgroundTasks(),
        session,
        None,  # auth dependency (bypassed when called directly)
    )
    await ticker

    assert calls == ["ingest"]
    assert response.headers["X-Otlp-Mode"] == "async"
    gaps = [b - a for a, b in zip(beats, beats[1:])]
    assert max(gaps) < SYNC_WORK_SECONDS, (
        f"event loop stalled during OTLP ingest: worst beat gap {max(gaps):.2f}s"
    )
