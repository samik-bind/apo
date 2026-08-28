"""In-memory event broadcaster for trace streaming via SSE.

Thin wrapper around the generic Broadcaster that adds trace-specific event
types and convenience methods. The SSE plumbing (queues, locks, listener
management, disconnect cleanup) lives once in Broadcaster.

Channels are keyed by
``(project_id, trace_id)`` — public OTel trace IDs are client-generated and
can collide across Projects, so the trace ID alone is never a channel key.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import datetime, timezone

from .broadcaster import Broadcaster
from .sse import format_sse_event

# (project_id, trace_id) — the Project-qualified live channel identity.
TraceChannelKey = tuple[str, str]


class TraceEvent:
    """Represents a single trace streaming event.

    Attributes:
        event_type: Type of trace event
        trace_id: ID of the trace (run_id)
        data: Event-specific payload
        timestamp: When the event occurred (UTC)
    """

    def __init__(
        self,
        event_type: str,
        trace_id: str,
        data: dict[str, object],
        timestamp: datetime | None = None,
    ):
        self.event_type: str = event_type
        self.trace_id: str = trace_id
        self.data: dict[str, object] = data
        self.timestamp: datetime = timestamp or datetime.now(timezone.utc)

    def to_sse_format(self) -> str:
        """Convert event to SSE format string."""
        return format_sse_event(
            self.event_type,
            self.data,
            ("trace_id", self.trace_id),
            self.timestamp,
        )


class TraceBroadcaster:
    """Broadcasts trace events to connected SSE clients.

    Wraps a generic ``Broadcaster[TraceChannelKey]``, delegating
    subscribe/publish/cleanup to it and adding only trace-event formatting
    and convenience methods. Every channel is Project-qualified: an event
    published for ``(A, trace)`` never reaches a subscriber of
    ``(B, trace)`` even when both Projects share the public trace ID.
    """

    def __init__(self) -> None:
        self._inner: Broadcaster[TraceChannelKey] = Broadcaster()

    def subscribe(self, project_id: str, trace_id: str) -> AsyncIterator[str]:
        """Subscribe to SSE events for one Project's trace.

        Yields pre-formatted SSE message strings. Automatically cleaned up
        on disconnect.
        """
        return self._inner.subscribe((project_id, trace_id))

    async def publish(self, project_id: str, trace_id: str, event: TraceEvent) -> None:
        """Publish a trace event to all subscribers of a Project's trace."""
        await self._inner.publish((project_id, trace_id), event.to_sse_format())

    async def broadcast_trace_created(
        self, project_id: str, trace_id: str, data: dict[str, object]
    ) -> None:
        """Broadcast a trace:created event."""
        await self.publish(project_id, trace_id, TraceEvent("trace:created", trace_id, data))

    async def broadcast_span_created(
        self, project_id: str, trace_id: str, data: dict[str, object]
    ) -> None:
        """Broadcast a span:created event."""
        await self.publish(project_id, trace_id, TraceEvent("span:created", trace_id, data))

    async def broadcast_span_updated(
        self, project_id: str, trace_id: str, data: dict[str, object]
    ) -> None:
        """Broadcast a span:updated event."""
        await self.publish(project_id, trace_id, TraceEvent("span:updated", trace_id, data))

    async def broadcast_trace_completed(
        self, project_id: str, trace_id: str, data: dict[str, object]
    ) -> None:
        """Broadcast a trace:completed event."""
        await self.publish(project_id, trace_id, TraceEvent("trace:completed", trace_id, data))

    async def get_listener_count(self, project_id: str, trace_id: str) -> int:
        """Get the number of active listeners for a Project's trace."""
        return await self._inner.get_listener_count((project_id, trace_id))

    async def close_all(self) -> None:
        """Close all listener connections."""
        await self._inner.close_all()


_broadcaster: TraceBroadcaster | None = None
_broadcaster_lock = asyncio.Lock()


async def get_trace_broadcaster() -> TraceBroadcaster:
    """Get the global TraceBroadcaster singleton."""
    global _broadcaster

    if _broadcaster is None:
        async with _broadcaster_lock:
            if _broadcaster is None:
                _broadcaster = TraceBroadcaster()

    return _broadcaster


def reset_trace_broadcaster() -> None:
    """Reset the global broadcaster instance (for testing)."""
    global _broadcaster
    _broadcaster = None
