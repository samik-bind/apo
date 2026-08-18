"""ArtifactStore registry and configuration.

Resolves the configured write backend (``APO_ARTIFACT_STORE``) and reads
backends by the name recorded on a Deliverable row. The default local backend
needs no extra services; S3 is opt-in.

Configuration is validated eagerly: invalid/negative/overflowing numeric
environment values raise at process start rather than silently disabling
limits (see Request and Storage Limits).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from apo.services.artifact_store import ArtifactStore
from apo.services.artifact_stores.local import LocalArtifactStore

_DEFAULT_MAX_ITEM_BYTES = 100 * 1024 * 1024  # 100 MiB per Artifact
_DEFAULT_MAX_RUN_BYTES = 500 * 1024 * 1024  # 500 MiB ready+pending per Task Run
_DEFAULT_UPLOAD_TTL_SECONDS = 86_400  # 24h pending-upload expiry


@dataclass(frozen=True)
class ArtifactStoreDescriptor:
    """Sanitized, public-safe descriptor for the configured store.

    Never includes credentials, secret-bearing URLs, or private object keys.
    Exposed via runtime configuration so operators (and the dashboard) can see
    which backend is selected and its size limits.
    """

    write_backend: str  # "local" | "s3"
    local_path: str | None
    s3_bucket: str | None
    s3_endpoint_host: str | None
    max_item_bytes: int
    max_run_bytes: int


def _require_positive_int(env_var: str, default: int) -> int:
    raw = os.environ.get(env_var)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(
            f"{env_var}={raw!r} is not a valid integer"
        ) from exc
    if value <= 0:
        raise ValueError(f"{env_var} must be positive, got {value}")
    return value


def default_artifact_dir() -> Path:
    """Resolve the local artifact root from ``APO_ARTIFACT_DIR`` or the data dir."""
    override = os.environ.get("APO_ARTIFACT_DIR")
    if override:
        return Path(override)
    return Path(_data_dir()) / "artifacts"


def _data_dir() -> str:
    from apo.services.artifact_stores.paths import DATA_DIR

    return DATA_DIR


def artifact_limits() -> tuple[int, int, int]:
    """Return ``(max_item_bytes, max_run_bytes, upload_ttl_seconds)``.

    Invalid/negative/overflowing values raise rather than disable limits.
    """
    max_item = _require_positive_int("APO_ARTIFACT_MAX_ITEM_BYTES", _DEFAULT_MAX_ITEM_BYTES)
    max_run = _require_positive_int("APO_ARTIFACT_MAX_RUN_BYTES", _DEFAULT_MAX_RUN_BYTES)
    ttl = _require_positive_int("APO_ARTIFACT_UPLOAD_TTL_SECONDS", _DEFAULT_UPLOAD_TTL_SECONDS)
    return max_item, max_run, ttl


def describe_artifact_store() -> ArtifactStoreDescriptor:
    """Build a sanitized descriptor from the current environment."""
    backend = os.environ.get("APO_ARTIFACT_STORE", "local").lower()
    if backend not in ("local", "s3"):
        raise ValueError(f"APO_ARTIFACT_STORE={backend!r} must be 'local' or 's3'")
    max_item, max_run, _ = artifact_limits()
    s3_endpoint = os.environ.get("APO_S3_ENDPOINT_URL")
    return ArtifactStoreDescriptor(
        write_backend=backend,
        local_path=str(default_artifact_dir()) if backend == "local" else None,
        s3_bucket=os.environ.get("APO_S3_BUCKET"),
        s3_endpoint_host=_host_of(s3_endpoint) if s3_endpoint else None,
        max_item_bytes=max_item,
        max_run_bytes=max_run,
    )


def _host_of(url: str) -> str:
    # Strip scheme and credentials; expose only the host for diagnostics.
    cleaned = url
    for scheme in ("https://", "http://"):
        if cleaned.startswith(scheme):
            cleaned = cleaned[len(scheme):]
    # Drop user@pass if present.
    if "@" in cleaned:
        cleaned = cleaned.split("@", 1)[1]
    return cleaned.split("/", 1)[0]


def get_store(backend: str | None, *, artifact_dir: Path | None = None) -> ArtifactStore:
    """Resolve a store by the backend name recorded on a row.

    ``backend=None`` (inline JSON Deliverables) never calls this. Reads use
    the row's recorded backend so changing the write backend never reinterprets
    existing rows.
    """
    name = (backend or "local").lower()
    if name == "local":
        return LocalArtifactStore(root=artifact_dir or default_artifact_dir())
    if name == "s3":
        # Ticket 09 — S3ArtifactStore. Imported lazily so the AWS SDK
        # stays an optional dependency in the default Local topology.
        try:
            from apo.services.artifact_stores.s3 import S3ArtifactStore
        except ImportError as exc:
            raise RuntimeError(
                "S3 artifact store requires the optional boto3 dependency;"
                + " install it or set APO_ARTIFACT_STORE=local"
            ) from exc
        return S3ArtifactStore.from_env()  # type: ignore[no-any-return]
    raise ValueError(f"unknown artifact storage backend: {backend!r}")
