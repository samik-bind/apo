# pyright: reportMissingImports=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportAny=false, reportExplicitAny=false, reportUnknownParameterType=false
"""Optional S3-compatible ArtifactStore.

Clients still upload/download through authenticated Apo endpoints; no browser
or executor receives bucket credentials. Uses the AWS credential chain when
explicit credentials are absent and supports S3-compatible endpoints (R2,
MinIO, Backblaze). Blocking SDK calls run via ``asyncio.to_thread`` so they
never block the event loop.

boto3 is an optional dependency (``pip install apo-backend[s3]``); the default
Local topology never imports this module. The store satisfies the same
``ArtifactStore`` contract as the local backend so changing the write backend
never changes observable behavior.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
from collections.abc import AsyncIterator
from typing import Any, Protocol, final

from apo.services.artifact_store import ArtifactStat, StoredArtifact

_CHUNK = 64 * 1024


class _S3Client(Protocol):
    """The slice of boto3's client API this store depends on."""

    def head_bucket(self, **kwargs: Any) -> dict[str, Any]: ...
    def put_object(self, **kwargs: Any) -> dict[str, Any]: ...
    def get_object(self, **kwargs: Any) -> dict[str, Any]: ...
    def head_object(self, **kwargs: Any) -> dict[str, Any]: ...
    def delete_object(self, **kwargs: Any) -> dict[str, Any]: ...


@final
class S3ArtifactStore:
    """S3-compatible backend. ``client`` is injectable for conformance tests."""

    name = "s3"

    def __init__(
        self,
        *,
        client: _S3Client,
        bucket: str,
        prefix: str,
    ) -> None:
        self._client = client
        self._bucket = bucket
        self._prefix = prefix

    @classmethod
    def from_env(cls) -> S3ArtifactStore:
        """Build the store from the S3_* environment contract.

        Uses the provider credential chain when explicit credentials are
        absent; raises if ``APO_S3_BUCKET`` is unset.
        """
        bucket = os.environ.get("APO_S3_BUCKET")
        if not bucket:
            raise RuntimeError("APO_S3_BUCKET is required when APO_ARTIFACT_STORE=s3")
        prefix = os.environ.get("APO_S3_PREFIX", "artifacts/")
        client = _build_boto3_client()
        return cls(client=client, bucket=bucket, prefix=prefix)

    async def put(
        self,
        key: str,
        chunks: AsyncIterator[bytes],
        *,
        expected_size: int,
        expected_sha256: str,
    ) -> StoredArtifact:
        _validate_key(key)
        body = await _drain(chunks)
        if len(body) != expected_size:
            raise ValueError(
                f"artifact size mismatch: declared {expected_size}, received {len(body)}"
            )
        digest = hashlib.sha256(body).hexdigest()
        if digest != expected_sha256:
            raise ValueError(
                "artifact digest mismatch: declared"
                + f" {expected_sha256}, computed {digest}"
            )
        object_key = self._object_key(key)
        _ = await asyncio.to_thread(
            self._client.put_object,
            Bucket=self._bucket,
            Key=object_key,
            Body=body,
        )
        return StoredArtifact(backend=self.name, key=key, size_bytes=len(body), sha256=digest)

    async def open(self, key: str) -> AsyncIterator[bytes]:
        _validate_key(key)
        object_key = self._object_key(key)
        response = await asyncio.to_thread(
            self._client.get_object, Bucket=self._bucket, Key=object_key
        )
        body = response["Body"]
        # Drain through the event loop in chunks so callers never buffer a
        # whole object in the backend byte string.
        while True:
            chunk = await asyncio.to_thread(body.read, _CHUNK)
            if not chunk:
                break
            yield chunk

    async def stat(self, key: str) -> ArtifactStat | None:
        _validate_key(key)
        object_key = self._object_key(key)
        try:
            response = await asyncio.to_thread(
                self._client.head_object, Bucket=self._bucket, Key=object_key
            )
        except Exception:  # noqa: BLE001 - missing key / transient -> absent
            return None
        size = int(response.get("ContentLength") or 0)
        return ArtifactStat(size_bytes=size, sha256=None)

    async def delete(self, key: str) -> None:
        _validate_key(key)
        object_key = self._object_key(key)
        try:
            _ = await asyncio.to_thread(
                self._client.delete_object, Bucket=self._bucket, Key=object_key
            )
        except Exception:  # noqa: BLE001 - idempotent delete never raises
            return

    async def check_ready(self) -> tuple[bool, str | None]:
        try:
            _ = await asyncio.to_thread(self._client.head_bucket, Bucket=self._bucket)
        except Exception as exc:  # noqa: BLE001
            return False, f"S3 bucket '{self._bucket}' unreachable: {exc}"
        return True, None

    def _object_key(self, key: str) -> str:
        return f"{self._prefix}{key}".lstrip("/")


def _validate_key(key: str) -> None:
    if not key or key.startswith("/") or "\x00" in key:
        raise ValueError(f"invalid artifact key: {key!r}")
    parts = key.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError(f"invalid artifact key: {key!r}")


async def _drain(chunks: AsyncIterator[bytes]) -> bytes:
    collected = bytearray()
    async for chunk in chunks:
        collected.extend(chunk)
    return bytes(collected)


def _build_boto3_client() -> _S3Client:
    try:
        import boto3  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "S3 artifact store requires the optional boto3 dependency;"
            + " install `apo-backend[s3]` or set APO_ARTIFACT_STORE=local"
        ) from exc

    endpoint = os.environ.get("APO_S3_ENDPOINT_URL")
    region = os.environ.get("APO_S3_REGION")
    access_key = os.environ.get("APO_S3_ACCESS_KEY_ID")
    secret_key = os.environ.get("APO_S3_SECRET_ACCESS_KEY")
    force_path_style = os.environ.get("APO_S3_FORCE_PATH_STYLE", "false").lower() in (
        "1",
        "true",
        "yes",
    )

    kwargs: dict[str, Any] = {}
    if endpoint:
        kwargs["endpoint_url"] = endpoint
    if region:
        kwargs["region_name"] = region
    if access_key and secret_key:
        kwargs["aws_access_key_id"] = access_key
        kwargs["aws_secret_access_key"] = secret_key

    if force_path_style:
        from botocore.config import Config  # type: ignore[import-not-found]

        kwargs["config"] = Config(s3={"addressing_style": "path"})

    return boto3.client("s3", **kwargs)  # type: ignore[no-any-return]
