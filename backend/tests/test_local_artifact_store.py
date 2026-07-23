# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportReturnType=false, reportCallIssue=false, reportAttributeAccessIssue=false

"""SPEC-140 ticket 02: LocalArtifactStore atomicity and durability.

The local store writes to a staging file, flushes, verifies size and digest,
and uses an atomic same-filesystem rename into ``objects/``. It must reject
path traversal, never follow symlinks for the destination, leave no completed
object after a partial write, and clean up its own staging bytes.
"""

from __future__ import annotations

import asyncio
import errno
import hashlib
import os
import stat
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from apo.services.artifact_stores.local import LocalArtifactStore


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


async def _aiter_bytes(data: bytes, chunks: int = 4) -> "AsyncIterator[bytes]":
    step = max(1, len(data) // chunks)
    for i in range(0, len(data), step):
        yield data[i : i + step]


# Mark every async test in the module; avoids per-test decoration.
pytestmark = pytest.mark.asyncio


@pytest.fixture
def store(tmp_path: Path) -> LocalArtifactStore:
    s = LocalArtifactStore(root=tmp_path)
    ready, reason = asyncio.run(s.check_ready())
    assert ready, reason
    return s


class TestLocalArtifactStore:
    async def test_put_writes_object_and_verifies_digest(self, store: LocalArtifactStore):
        data = b"hello artifact world"
        key = "ab/ab" + "0" * 24
        stored = await store.put(
            key, _aiter_bytes(data), expected_size=len(data), expected_sha256=_sha256(data)
        )

        assert stored.backend == "local"
        assert stored.key == key
        assert stored.size_bytes == len(data)
        assert stored.sha256 == _sha256(data)
        # The object exists at the sharded path and the staging file is gone.
        obj_path = store.root / "objects" / "ab" / ("ab" + "0" * 24)
        assert obj_path.is_file()
        staging = list((store.root / "staging").glob("*.part"))
        assert staging == []
        # Mode 0600 on the completed file.
        assert stat.S_IMODE(obj_path.stat().st_mode) == 0o600

    async def test_open_round_trips_bytes_in_order(self, store: LocalArtifactStore):
        data = bytes(range(256)) * 100
        key = "cd/cdkey1234567890123456789012"
        await store.put(
            key, _aiter_bytes(data, chunks=8),
            expected_size=len(data), expected_sha256=_sha256(data),
        )

        got = b""
        async for chunk in store.open(key):
            got += chunk
        assert got == data

    async def test_stat_returns_size_and_digest_when_present(self, store: LocalArtifactStore):
        data = b"stat me"
        key = "ef/ef" + "1" * 24
        await store.put(
            key, _aiter_bytes(data), expected_size=len(data), expected_sha256=_sha256(data)
        )

        stat_result = await store.stat(key)
        assert stat_result is not None
        assert stat_result.size_bytes == len(data)
        assert stat_result.sha256 == _sha256(data)

    async def test_stat_returns_none_for_missing_key(self, store: LocalArtifactStore):
        assert await store.stat("00/00missing") is None

    async def test_open_missing_key_raises(self, store: LocalArtifactStore):
        with pytest.raises(FileNotFoundError):
            async for _ in store.open("00/00missing"):
                pass

    async def test_digest_mismatch_leaves_no_completed_object(self, store: LocalArtifactStore):
        data = b"declared hash is wrong for these bytes"
        key = "12/12" + "2" * 24
        with pytest.raises(ValueError):
            await store.put(
                key,
                _aiter_bytes(data),
                expected_size=len(data),
                expected_sha256="f" * 64,  # wrong digest
            )

        # No completed object, no lingering staging part.
        obj_path = store.root / "objects" / "12" / ("12" + "2" * 24)
        assert not obj_path.exists()
        assert list((store.root / "staging").glob("*.part")) == []

    async def test_size_mismatch_leaves_no_completed_object(self, store: LocalArtifactStore):
        data = b"ten bytes"
        key = "34/34" + "3" * 24
        with pytest.raises(ValueError):
            await store.put(
                key,
                _aiter_bytes(data),
                expected_size=100,  # declared larger than actual
                expected_sha256=_sha256(data),
            )
        obj_path = store.root / "objects" / "34" / ("34" + "3" * 24)
        assert not obj_path.exists()
        assert list((store.root / "staging").glob("*.part")) == []

    async def test_partial_stream_leaves_no_completed_object(
        self, store: LocalArtifactStore, tmp_path: Path
    ):
        """A stream that raises halfway must not produce a completed object."""
        key = "56/56" + "4" * 24

        async def exploding_stream() -> "AsyncIterator[bytes]":
            yield b"first chunk"
            raise RuntimeError("stream blew up mid-upload")

        with pytest.raises(RuntimeError):
            await store.put(
                key,
                exploding_stream(),
                expected_size=10_000,
                expected_sha256=_sha256(b"whatever"),
            )
        obj_path = store.root / "objects" / "56" / ("56" + "4" * 24)
        assert not obj_path.exists()
        assert list((store.root / "staging").glob("*.part")) == []

    async def test_delete_is_idempotent(self, store: LocalArtifactStore):
        data = b"to delete"
        key = "78/78" + "5" * 24
        await store.put(
            key, _aiter_bytes(data), expected_size=len(data), expected_sha256=_sha256(data)
        )
        await store.delete(key)
        # Deleting again must not raise.
        await store.delete(key)
        obj_path = store.root / "objects" / "78" / ("78" + "5" * 24)
        assert not obj_path.exists()

    async def test_keys_with_traversal_segments_are_rejected(
        self, store: LocalArtifactStore
    ):
        """A storage key containing '..' must never escape the objects root."""
        data = b"escape attempt"
        for bad_key in ("../evil", "ab/../../evil", "..", "ab/cd/../../evil", "/abs/path"):
            with pytest.raises((ValueError, FileNotFoundError)):
                await store.put(
                    bad_key,
                    _aiter_bytes(data),
                    expected_size=len(data),
                    expected_sha256=_sha256(data),
                )
        # No file written outside objects/.
        assert not (store.root.parent / "evil").exists()

    async def test_root_creates_directories_with_restricted_mode(
        self, tmp_path: Path
    ):
        root = tmp_path / "fresh"
        store = LocalArtifactStore(root=root)
        ready, _ = await store.check_ready()
        assert ready
        # objects/ and staging/ exist with mode 0700.
        assert (root / "objects").is_dir()
        assert (root / "staging").is_dir()
        assert stat.S_IMODE((root / "objects").stat().st_mode) == 0o700
        assert stat.S_IMODE((root / "staging").stat().st_mode) == 0o700

    async def test_check_ready_reports_unwritable_root(self, tmp_path: Path):
        root = tmp_path / "locked"
        root.mkdir(mode=0o500)  # writable check should fail
        store = LocalArtifactStore(root=root)
        ready, reason = await store.check_ready()
        assert not ready
        assert reason is not None
        # restore so pytest can clean up
        os.chmod(root, 0o700)

    async def test_check_ready_reports_non_renamable_root(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """Readiness must catch when staging->objects rename is non-atomic.

        Cross-device rename raises ``EXDEV``; in a single-filesystem test
        environment we simulate it by patching ``os.replace`` to raise.
        """
        store = LocalArtifactStore(root=tmp_path / "root")

        real_replace = os.replace

        def _fake_replace(src: str, dst: str) -> None:
            # Only fail the readiness probe's rename, not probe cleanup.
            if str(dst).startswith(str(store.objects)):
                raise OSError(errno.EXDEV, "cross-device rename")
            return real_replace(src, dst)

        monkeypatch.setattr(
            "apo.services.artifact_stores.local.os.replace", _fake_replace
        )
        ready, reason = await store.check_ready()
        assert not ready
        assert reason is not None
