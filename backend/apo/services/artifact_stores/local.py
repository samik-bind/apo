"""SPEC-140: local filesystem ArtifactStore.

Zero-configuration default. Objects live under the existing persistent
``/app/data`` volume so no MinIO, bucket, port, credential, or extra
container is required.

Layout::

    <root>/
      objects/        # mode 0700 — completed immutable objects
        ab/
          ab<opaque-content-id>   # mode 0600
      staging/        # mode 0700 — in-flight <upload-id>.part files

A write streams to a staging file, flushes+fsyncs, independently counts and
hashes the bytes, verifies size and SHA-256, and then uses an atomic
same-filesystem rename into ``objects/``. Directories use mode ``0700``;
completed files use mode ``0600``.
"""

from __future__ import annotations

import hashlib
import os
import secrets
from collections.abc import AsyncIterator
from pathlib import Path

from apo.services.artifact_store import ArtifactStat, StoredArtifact

_CHUNK_SIZE = 64 * 1024
_STAGING_SUFFIX = ".part"
_DIR_MODE = 0o700
_FILE_MODE = 0o600


class LocalArtifactStore:
    """The local-disk ArtifactStore.

    ``root`` is the artifact root (``${APO_ARTIFACT_DIR:-<DATA_DIR>/artifacts}``);
    ``objects/`` and ``staging/`` are created underneath it. The two
    directories MUST live on the same filesystem so the staging -> objects
    rename is atomic; ``check_ready`` verifies that.
    """

    name = "local"

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.objects = self.root / "objects"
        self.staging = self.root / "staging"

    async def put(
        self,
        key: str,
        chunks: AsyncIterator[bytes],
        *,
        expected_size: int,
        expected_sha256: str,
    ) -> StoredArtifact:
        target = self._resolve_object(key)
        staging_path = self.staging / f"{secrets.token_hex(16)}{_STAGING_SUFFIX}"

        digest = hashlib.sha256()
        counted = 0
        try:
            with open(staging_path, "wb") as fh:
                async for chunk in chunks:
                    _ = fh.write(chunk)
                    digest.update(chunk)
                    counted += len(chunk)
                fh.flush()
                os.fsync(fh.fileno())

            if counted != expected_size:
                raise ValueError(
                    f"artifact size mismatch: declared {expected_size}, received {counted}"
                )
            actual_digest = digest.hexdigest()
            if actual_digest != expected_sha256:
                raise ValueError(
                    "artifact digest mismatch: declared"
                    + f" {expected_sha256}, computed {actual_digest}"
                )

            # Atomic promotion: same-filesystem rename into objects/.
            target.parent.mkdir(parents=True, exist_ok=True)
            os.chmod(target.parent, _DIR_MODE)
            os.replace(staging_path, target)
            os.chmod(target, _FILE_MODE)
        except BaseException:
            # Clean up staging bytes whether verification failed or the
            # stream raised. Never leave a half-written .part behind.
            try:
                staging_path.unlink()
            except FileNotFoundError:
                pass
            raise

        return StoredArtifact(
            backend=self.name,
            key=key,
            size_bytes=counted,
            sha256=actual_digest,
        )

    async def open(self, key: str) -> AsyncIterator[bytes]:
        path = self._resolve_object(key)
        if not path.is_file():
            raise FileNotFoundError(f"artifact not found: {key}")
        with open(path, "rb") as fh:
            while True:
                chunk = fh.read(_CHUNK_SIZE)
                if not chunk:
                    break
                yield chunk

    async def stat(self, key: str) -> ArtifactStat | None:
        path = self._resolve_object(key)
        if not path.is_file():
            return None
        digest = hashlib.sha256()
        size = 0
        with open(path, "rb") as fh:
            while True:
                chunk = fh.read(_CHUNK_SIZE)
                if not chunk:
                    break
                digest.update(chunk)
                size += len(chunk)
        return ArtifactStat(size_bytes=size, sha256=digest.hexdigest())

    async def delete(self, key: str) -> None:
        path = self._resolve_object(key)
        try:
            path.unlink()
        except FileNotFoundError:
            return
        except IsADirectoryError:
            # Defensive: never recursively remove a directory.
            return

    async def check_ready(self) -> tuple[bool, str | None]:
        try:
            self._ensure_dir(self.root)
            self._ensure_dir(self.objects)
            self._ensure_dir(self.staging)
        except OSError as exc:
            return False, f"artifact root not writable: {exc.strerror or exc}"

        # Verify same-filesystem atomic rename between staging and objects.
        probe = self.staging / f".ready-probe-{secrets.token_hex(8)}"
        try:
            _ = probe.write_bytes(b"")
            os.chmod(probe, _FILE_MODE)
            target = self.objects / f".ready-probe-{secrets.token_hex(8)}"
            os.replace(probe, target)
            target.unlink()
        except OSError as exc:
            try:
                probe.unlink()
            except FileNotFoundError:
                pass
            return (
                False,
                "staging and objects must share a filesystem for atomic rename"
                + f" ({exc.strerror or exc})",
            )
        return True, None

    def _resolve_object(self, key: str) -> Path:
        """Resolve a server-generated key to its object path, rejecting traversal.

        Keys are opaque server-controlled segments. Any ``..`` segment, empty
        segment, absolute path, or escape outside ``objects/`` is rejected so a
        bad key can never write or read outside the object root.
        """
        if not key or key.startswith("/") or "\x00" in key:
            raise ValueError(f"invalid artifact key: {key!r}")
        parts = key.split("/")
        if any(part in ("", ".", "..") for part in parts):
            raise ValueError(f"invalid artifact key: {key!r}")
        candidate = (self.objects / key).resolve()
        try:
            _ = candidate.relative_to(self.objects.resolve())
        except ValueError as exc:
            raise ValueError(f"artifact key escapes objects root: {key!r}") from exc
        return candidate

    @staticmethod
    def _ensure_dir(path: Path) -> None:
        # Only apply the restricted mode to freshly-created directories; never
        # relax an operator-configured mode (e.g. a read-only root) which would
        # mask an unwritable store from readiness checks.
        created = not path.exists()
        path.mkdir(parents=True, exist_ok=True)
        if created:
            os.chmod(path, _DIR_MODE)
