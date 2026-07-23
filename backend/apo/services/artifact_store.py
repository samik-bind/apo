"""SPEC-140: ArtifactStore protocol and shared types.

An ``ArtifactStore`` owns immutable file bytes outside the relational
database. The database owns Deliverable identity, authorization, and listing;
the store never becomes an authorization or listing source.

Storage keys are server-generated opaque segments (never client filenames).
Each implementation verifies size and SHA-256 of the exact bytes it commits.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass(frozen=True)
class StoredArtifact:
    """Result of a successful ``put``: the committed location and verifiable size/digest."""

    backend: str
    key: str
    size_bytes: int
    sha256: str


@dataclass(frozen=True)
class ArtifactStat:
    """Metadata for an existing object, without reading its bytes."""

    size_bytes: int
    sha256: str | None


@runtime_checkable
class ArtifactStore(Protocol):
    """The storage boundary every backend (local, S3, ...) implements.

    ``name`` records which backend wrote a row so changing the configured
    write backend never reinterprets existing rows: reads use the backend
    recorded on the row.
    """

    name: str

    async def put(
        self,
        key: str,
        chunks: AsyncIterator[bytes],
        *,
        expected_size: int,
        expected_sha256: str,
    ) -> StoredArtifact:
        """Stream bytes to a staging path, verify size+digest, atomically promote.

        Raises ``ValueError`` on size or digest mismatch and leaves no
        completed object. Streaming callers may raise mid-stream; the store
        cleans up its own staging bytes in that case.
        """
        ...

    def open(self, key: str) -> AsyncIterator[bytes]:
        """Stream the exact committed bytes back, in order.

        Declared as a sync function returning an ``AsyncIterator`` so async
        generator implementations match the protocol directly.
        """
        ...

    async def stat(self, key: str) -> ArtifactStat | None:
        """Return size (and digest when cheap) for an existing object, else None."""
        ...

    async def delete(self, key: str) -> None:
        """Idempotently remove an object. Never raises for a missing key."""
        ...

    async def check_ready(self) -> tuple[bool, str | None]:
        """Return ``(ok, reason)``. ``reason`` is None when ready, operator-actionable otherwise."""
        ...
