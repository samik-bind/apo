# pyright: reportAny=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

"""Tests for SSE keepalive frames on quiet streams.

A task run emits nothing between its started and completed events, so the
run-events stream is silent for minutes. Idle-timeout intermediaries
(Cloudflare, tunnels, LBs) kill such connections, and the browser then
misses the terminal event entirely. ``sse_streaming_response`` writes a
comment frame during quiet intervals to keep bytes flowing — and must do so
without tearing down the underlying subscription (a naive ``wait_for``
would cancel the subscribe generator on the first quiet interval).
"""

import asyncio

from fastapi import Request

from apo.services.sse import KEEPALIVE_FRAME, sse_streaming_response

INITIAL_FRAME = "event: initial\ndata: {}\n\n"


def _request() -> Request:
    """A Request whose client never disconnects."""

    async def receive():
        await asyncio.sleep(3600)
        return {"type": "http.disconnect"}

    return Request({"type": "http", "method": "GET", "headers": []}, receive)


def test_quiet_stream_emits_keepalive_frames():
    """With no events at all, keepalive comment frames flow after the initial events."""

    async def run():
        async def silent():
            await asyncio.sleep(3600)
            yield "never"

        response = sse_streaming_response(
            _request(),
            lambda: silent(),
            [INITIAL_FRAME],
            keepalive_interval=0.05,
        )

        received: list[str] = []
        async def consume():
            async for chunk in response.body_iterator:
                received.append(str(chunk))
                if len(received) >= 3:
                    break

        await asyncio.wait_for(consume(), timeout=5)
        assert received[0] == INITIAL_FRAME
        assert received[1] == KEEPALIVE_FRAME
        assert received[2] == KEEPALIVE_FRAME

    asyncio.run(run())


def test_events_still_flow_after_quiet_interval():
    """A quiet interval must not tear down the subscription: events published
    after keepalives have been written still reach the client, and the stream
    ends cleanly when the subscription ends."""

    async def run():
        queue: asyncio.Queue[str | None] = asyncio.Queue()

        async def source():
            while True:
                item = await queue.get()
                if item is None:
                    return
                yield item

        response = sse_streaming_response(
            _request(),
            lambda: source(),
            [],
            keepalive_interval=0.05,
        )

        received: list[str] = []
        async def consume():
            async for chunk in response.body_iterator:
                received.append(str(chunk))

        consumer = asyncio.create_task(consume())
        # Let at least one keepalive interval elapse before any event exists.
        await asyncio.sleep(0.12)
        await queue.put("event: one\n\n")
        await queue.put("event: two\n\n")
        await queue.put(None)
        await asyncio.wait_for(consumer, timeout=5)

        events = [c for c in received if c != KEEPALIVE_FRAME]
        assert events == ["event: one\n\n", "event: two\n\n"]
        keepalives_before_first_event = received.index("event: one\n\n")
        assert keepalives_before_first_event >= 1

    asyncio.run(run())
