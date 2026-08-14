"""A minimal in-memory fake of the boto3 S3 client for conformance tests.

Mimics the slice of the boto3 client API that ``S3ArtifactStore`` calls:
``head_bucket``, ``put_object``, ``get_object``, ``head_object``,
``delete_object``. The store reads object bodies via ``read()``, so the fake
returns a simple readable; no botocore dependency required.
"""

# pyright: reportExplicitAny=false, reportUnannotatedClassAttribute=false, reportUnusedCallResult=false, reportUnusedParameter=false

from __future__ import annotations

from typing import Any


class FakeNoSuchKey(Exception):
    pass


class FakeStreamingBody:
    """File-like object mimicking the readable part of a boto3 response body."""

    def __init__(self, data: bytes) -> None:
        self._data = data
        self._pos = 0

    def read(self, amt: int | None = None) -> bytes:
        if amt is None or amt < 0:
            chunk = self._data[self._pos :]
            self._pos = len(self._data)
            return chunk
        chunk = self._data[self._pos : self._pos + amt]
        self._pos += len(chunk)
        return chunk


class FakeS3Client:
    """In-memory stand-in for ``boto3.client("s3")``."""

    def __init__(self, *, bucket: str, prefix: str, fail_head: bool = False) -> None:
        self.bucket = bucket
        self.prefix = prefix
        self.fail_head = fail_head
        self._objects: dict[str, bytes] = {}

    def head_bucket(self, **_: Any) -> dict[str, Any]:
        if self.fail_head:
            raise FakeNoSuchKey("bucket unreachable")
        return {}

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, **_: Any) -> dict[str, Any]:
        self._objects[Key] = Body
        return {}

    def get_object(self, *, Bucket: str, Key: str, **_: Any) -> dict[str, Any]:
        if Key not in self._objects:
            raise FakeNoSuchKey(Key)
        body = self._objects[Key]
        return {
            "Body": FakeStreamingBody(body),
            "ContentLength": len(body),
        }

    def head_object(self, *, Bucket: str, Key: str, **_: Any) -> dict[str, Any]:
        if Key not in self._objects:
            raise FakeNoSuchKey(Key)
        return {"ContentLength": len(self._objects[Key])}

    def delete_object(self, *, Bucket: str, Key: str, **_: Any) -> dict[str, Any]:
        self._objects.pop(Key, None)
        return {}
