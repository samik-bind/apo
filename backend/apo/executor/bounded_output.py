"""SPEC-144: bounded subprocess output (64 KiB UTF-8-safe ring-buffer tails).

Captures stdout/stderr from a child process without ever buffering the whole
stream. The retained tail is decoded UTF-8-safe (``errors="replace"``) so
invalid or split multibyte sequences never raise and never exceed the byte cap.
Human stdout/stderr are diagnostics only — the result comes from the result
file, never from stdout parsing.
"""

from __future__ import annotations

from typing import final

@final
class BoundedOutput:
    """A byte ring buffer retaining at most ``max_bytes`` of the most recent output."""

    __slots__ = ("_max", "_buf")
    _max: int
    _buf: bytearray

    def __init__(self, *, max_bytes: int = 64 * 1024) -> None:
        if max_bytes <= 0:
            raise ValueError("max_bytes must be positive")
        self._max = max_bytes
        self._buf = bytearray()

    def append(self, data: bytes) -> None:
        """Append output bytes, evicting the oldest data past the cap."""
        if not data:
            return
        self._buf.extend(data)
        excess = len(self._buf) - self._max
        if excess > 0:
            del self._buf[:excess]

    def byte_len(self) -> int:
        return len(self._buf)

    def tail(self) -> str:
        """Decode the retained tail, replacing invalid/split UTF-8 safely."""
        return self._buf.decode("utf-8", errors="replace")


__all__ = ["BoundedOutput"]
