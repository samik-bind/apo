# pyright: reportAny=false
"""Authentication middleware ordering guarantees."""

import asyncio
import threading
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.pool import NullPool
from starlette.requests import Request
from starlette.responses import Response

from apo.auth import middleware
from apo.auth.api_key_tracker import ApiKeyUsageTracker
from apo.db import attach_sqlite_pragmas


@pytest.mark.anyio
async def test_api_key_usage_write_happens_after_route(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """API-key bookkeeping must not contend with the protected route's write."""
    events: list[str] = []

    monkeypatch.setattr(middleware, "_is_open_dev_bypass_allowed", lambda: False)
    monkeypatch.setattr(
        middleware,
        "_authenticate",
        lambda _request: {
            "auth_method": "api_key",
            "api_key_id": "key-1",
        },
    )
    monkeypatch.setattr(
        middleware.api_key_usage_tracker,
        "record_use",
        lambda _key_id, _engine: events.append("usage"),
    )

    async def call_next(_request: Request) -> Response:
        events.append("route")
        return Response("ok")

    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/v1/agent-task-batch-runs/caller",
            "raw_path": b"/v1/agent-task-batch-runs/caller",
            "query_string": b"",
            "headers": [],
            "scheme": "http",
            "server": ("testserver", 80),
            "client": ("127.0.0.1", 1234),
        }
    )

    await middleware.AuthMiddleware(object()).dispatch(request, call_next)
    middleware.drain_api_key_usage_writes()

    assert events == ["route", "usage"]


@pytest.mark.anyio
async def test_api_key_usage_write_does_not_block_the_event_loop(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The usage write queues on SQLite's write lock; the loop must not queue with it.

    A projection batch can hold the lock for seconds and busy_timeout lets the
    write wait 30 s. Waited on the event loop, that froze every request the
    process was serving, the dashboard's included.
    """
    usage_engine = create_engine(
        f"sqlite:///{tmp_path / 'usage.db'}",
        connect_args={"check_same_thread": False},
        poolclass=NullPool,
    )
    attach_sqlite_pragmas(usage_engine)
    with usage_engine.begin() as conn:
        conn.exec_driver_sql("CREATE TABLE api_keys (id TEXT PRIMARY KEY, last_used_at TEXT)")
        conn.exec_driver_sql("INSERT INTO api_keys (id) VALUES ('key-1')")

    monkeypatch.setattr(middleware, "engine", usage_engine)
    monkeypatch.setattr(middleware, "_is_open_dev_bypass_allowed", lambda: False)
    monkeypatch.setattr(
        middleware,
        "_authenticate",
        lambda _request: {"auth_method": "api_key", "api_key_id": "key-1"},
    )
    monkeypatch.setattr(middleware, "api_key_usage_tracker", ApiKeyUsageTracker())

    lock_held = threading.Event()
    hold_seconds = 1.0

    def hold_write_lock() -> None:
        with usage_engine.connect() as conn:
            conn.exec_driver_sql("BEGIN IMMEDIATE")
            lock_held.set()
            time.sleep(hold_seconds)
            conn.exec_driver_sql("COMMIT")

    writer = threading.Thread(target=hold_write_lock)
    writer.start()
    assert lock_held.wait(timeout=5)

    async def call_next(_request: Request) -> Response:
        return Response("ok")

    async def longest_loop_stall() -> float:
        worst = 0.0
        deadline = time.monotonic() + hold_seconds
        while time.monotonic() < deadline:
            before = time.monotonic()
            await asyncio.sleep(0.01)
            worst = max(worst, time.monotonic() - before - 0.01)
        return worst

    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/v1/agent-task-batch-runs",
            "raw_path": b"/v1/agent-task-batch-runs",
            "query_string": b"",
            "headers": [],
            "scheme": "http",
            "server": ("testserver", 80),
            "client": ("127.0.0.1", 1234),
        }
    )

    started = time.monotonic()
    stall_probe = asyncio.create_task(longest_loop_stall())
    await asyncio.sleep(0)
    await middleware.AuthMiddleware(object()).dispatch(request, call_next)
    response_seconds = time.monotonic() - started
    stall = await stall_probe
    writer.join()
    middleware.drain_api_key_usage_writes()

    assert stall < 0.25, f"event loop stalled {stall:.2f}s behind the write lock"
    assert response_seconds < 0.25, f"response waited {response_seconds:.2f}s for the write lock"
    with usage_engine.connect() as conn:
        assert conn.exec_driver_sql("SELECT last_used_at FROM api_keys").scalar_one() is not None
