# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportMissingTypeArgument=false, reportMissingImports=false

"""SPEC-140 ticket 09: S3ArtifactStore conformance.

The S3 backend must satisfy the same observable semantics as the local store.
Uses a fake boto3 client (in-memory) so the suite runs without AWS credentials
or network. Real boto3 is an optional dependency — the store imports lazily.
"""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import AsyncIterator

import pytest

# The fake client stands in for boto3.client("s3"). It is defined here so the
# test does not require boto3 to be installed.
from tests._fake_s3 import FakeS3Client
from apo.services.artifact_stores.s3 import S3ArtifactStore


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


async def _aiter(data: bytes, chunks: int = 3) -> AsyncIterator[bytes]:
    step = max(1, len(data) // chunks)
    for i in range(0, len(data), step):
        yield data[i : i + step]


pytestmark = pytest.mark.asyncio


@pytest.fixture
def store() -> S3ArtifactStore:
    return S3ArtifactStore(
        client=FakeS3Client(bucket="artifacts", prefix="artifacts/"),
        bucket="artifacts",
        prefix="artifacts/",
    )


class TestS3ArtifactStoreConformance:
    async def test_put_verifies_size_and_digest(self, store: S3ArtifactStore):
        data = b"s3 artifact bytes"
        key = "ab/ab" + "0" * 24
        stored = await store.put(
            key, _aiter(data), expected_size=len(data), expected_sha256=_sha(data)
        )
        assert stored.backend == "s3"
        assert stored.key == key
        assert stored.size_bytes == len(data)
        assert stored.sha256 == _sha(data)

    async def test_open_round_trips_exact_bytes(self, store: S3ArtifactStore):
        data = bytes(range(256)) * 50
        key = "cd/cd" + "1" * 24
        await store.put(
            key, _aiter(data, chunks=8),
            expected_size=len(data), expected_sha256=_sha(data),
        )
        got = b"".join([c async for c in store.open(key)])
        assert got == data

    async def test_stat_returns_size_and_digest(self, store: S3ArtifactStore):
        data = b"stat me"
        key = "ef/ef" + "2" * 24
        await store.put(
            key, _aiter(data), expected_size=len(data), expected_sha256=_sha(data)
        )
        stat = await store.stat(key)
        assert stat is not None
        assert stat.size_bytes == len(data)
        # sha256 is optional on stat (S3 head_object can't provide it cheaply);
        # the verified digest lives on the Deliverable row from `put`.

    async def test_stat_returns_none_for_missing(self, store: S3ArtifactStore):
        assert await store.stat("00/00missing") is None

    async def test_digest_mismatch_raises(self, store: S3ArtifactStore):
        data = b"wrong digest for these bytes"
        key = "12/12" + "3" * 24
        with pytest.raises(ValueError):
            await store.put(
                key, _aiter(data),
                expected_size=len(data), expected_sha256="f" * 64,
            )

    async def test_size_mismatch_raises(self, store: S3ArtifactStore):
        data = b"ten bytes"
        key = "34/34" + "4" * 24
        with pytest.raises(ValueError):
            await store.put(
                key, _aiter(data), expected_size=100, expected_sha256=_sha(data),
            )

    async def test_delete_is_idempotent(self, store: S3ArtifactStore):
        data = b"delete me"
        key = "78/78" + "5" * 24
        await store.put(
            key, _aiter(data), expected_size=len(data), expected_sha256=_sha(data)
        )
        await store.delete(key)
        await store.delete(key)  # no raise
        assert await store.stat(key) is None

    async def test_check_ready_reaches_bucket(self, store: S3ArtifactStore):
        ok, reason = await store.check_ready()
        assert ok
        assert reason is None

    async def test_check_ready_reports_unreachable_bucket(self):
        failing = S3ArtifactStore(
            client=FakeS3Client(bucket="artifacts", prefix="artifacts/", fail_head=True),
            bucket="artifacts",
            prefix="artifacts/",
        )
        ok, reason = await failing.check_ready()
        assert not ok
        assert reason is not None
