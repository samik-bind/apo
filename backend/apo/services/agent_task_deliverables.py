"""Deliverable service.

Owns JSON validation, compact serialization, inline-vs-object placement,
manifest construction, and upload state transitions. The service, not the
routes, owns these concerns so backend and external execution paths share
one finalization boundary.

Placement rules:

- compact UTF-8 size <= ``INLINE_THRESHOLD_BYTES`` -> stored inline as
  ``{"value": <value>}`` on the row;
- otherwise gzip-compressed once and written through the configured
  ``ArtifactStore``; the manifest reports the logical uncompressed size and
  digest while storage compression stays an implementation detail.

Storage placement never changes product meaning: a large JSON Deliverable
stored as an object is still a JSON Deliverable, not an Artifact.
"""

# pyright: reportAny=false, reportImplicitStringConcatenation=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

from __future__ import annotations

import gzip
import hashlib
import json
import secrets
from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone
from typing import Literal, cast

from sqlmodel import Session, select

from apo.db_helpers import _as_column
from apo.models.db import AgentTaskDeliverableDB, AgentTaskRunDB
from apo.models.schemas import (
    ArtifactUploadIntent,
    DeliverableSummary,
)
from apo.services.artifact_store import ArtifactStore
from apo.services.artifact_stores.registry import artifact_limits
from apo.services.lifecycle import TASK_RUN_TERMINAL

# — inline threshold is a code constant, not a tuning knob.
INLINE_THRESHOLD_BYTES = 64 * 1024  # 64 KiB

# name validation. 1-255 UTF-8 bytes, no NUL/control characters.
_NAME_MAX_BYTES = 255
_UPLOAD_INTENT_TTL = timedelta(seconds=86_400)


def lock_task_run(session: Session, task_run_id: str) -> AgentTaskRunDB | None:
    """Serialize intent creation, PUT completion, and result finalization on
    one Task Run row (SPEC-172 fence).

    PostgreSQL's row lock prevents two operations from observing an
    inconsistent intermediate state. SQLite serializes writes at the database
    level and safely ignores ``FOR UPDATE``.
    """
    from sqlmodel import col

    return session.exec(
        select(AgentTaskRunDB)
        .where(col(AgentTaskRunDB.id) == task_run_id)
        .with_for_update()
    ).one_or_none()


# Internal alias so callers read naturally.
_lock_task_run = lock_task_run


async def persist_json_deliverable(
    session: Session,
    *,
    project: str,
    task_run_id: str,
    name: str,
    value: object,
    store: ArtifactStore,
) -> AgentTaskDeliverableDB:
    """Validate, serialize, and place a JSON Deliverable row.

    Small values go inline; large values are gzip-compressed and written
    through ``store``. Returns the persisted (ready) row, unsaved — the caller
    commits so multiple rows and the terminal task-run state land together.
    """
    validate_deliverable_name(name)
    body = _compact_json_bytes(value)
    size = len(body)
    sha = _sha256_hex(body)

    # SPEC-172 invariant #6: a JSON deliverable name cannot collide with an
    # existing Artifact (or another JSON deliverable) on the same Task Run.
    existing = _find_deliverable(session, project, task_run_id, name)
    if existing is not None:
        raise ValueError(
            f"Deliverable name '{name}' already exists on task run {task_run_id}"
        )

    if size <= INLINE_THRESHOLD_BYTES:
        row = AgentTaskDeliverableDB(
            id=_new_id(),
            project=project,
            task_run_id=task_run_id,
            name=name,
            kind="json",
            status="ready",
            storage_backend=None,
            storage_key=None,
            inline_value_json={"value": _as_json_safe(value)},
            display_filename=None,
            media_type="application/json",
            content_encoding="identity",
            size_bytes=size,
            stored_size_bytes=size,
            sha256=sha,
            created_at=datetime.now(timezone.utc),
            ready_at=datetime.now(timezone.utc),
        )
        session.add(row)
        return row

    # Large JSON: gzip once, write through the store.
    compressed = gzip.compress(body)
    key = _storage_key()
    await store.put(
        key,
        _async_iter([compressed]),
        expected_size=len(compressed),
        expected_sha256=_sha256_hex(compressed),
    )
    row = AgentTaskDeliverableDB(
        id=_new_id(),
        project=project,
        task_run_id=task_run_id,
        name=name,
        kind="json",
        status="ready",
        storage_backend=store.name,
        storage_key=key,
        inline_value_json=None,
        display_filename=None,
        media_type="application/json",
        content_encoding="gzip",
        size_bytes=size,
        stored_size_bytes=len(compressed),
        sha256=sha,
        created_at=datetime.now(timezone.utc),
        ready_at=datetime.now(timezone.utc),
    )
    session.add(row)
    return row


async def read_json_deliverable_value(
    session: Session, deliverable_id: str, *, store: ArtifactStore
) -> object:
    """Read one JSON Deliverable body, inflating gzip when object-backed.

    Only this path opens a body; list/manifest/detail queries never call it.
    """
    row = session.get(AgentTaskDeliverableDB, deliverable_id)
    if row is None or row.kind != "json":
        raise KeyError(deliverable_id)

    if row.inline_value_json is not None:
        wrapped = row.inline_value_json
        return wrapped.get("value")

    if row.storage_key is None or row.storage_backend is None:
        raise RuntimeError(f"json deliverable {deliverable_id} has no body")

    raw = b"".join([chunk async for chunk in store.open(row.storage_key)])
    if row.content_encoding == "gzip":
        raw = gzip.decompress(raw)
    return json.loads(raw.decode("utf-8"))


def build_deliverable_manifest(
    session: Session,
    task_run_id: str,
    *,
    download_url_prefix: str | None = None,
) -> list[DeliverableSummary]:
    """Project metadata-only columns for every Deliverable on a Task Run.

    Reads only metadata attributes from each row; the inline JSON body (when
    present) is bounded by ``INLINE_THRESHOLD_BYTES`` so it never carries a
    multi-megabyte payload — large bodies live in object storage, not inline.
    Manifest ordering follows insertion (created_at, id) for stable display.
    """
    rows = session.exec(
        select(AgentTaskDeliverableDB)
        .where(AgentTaskDeliverableDB.task_run_id == task_run_id)
        .order_by(
            _as_column(AgentTaskDeliverableDB.created_at),
            _as_column(AgentTaskDeliverableDB.id),
        )
    ).all()

    prefix = download_url_prefix or f"/v1/agent-task-runs/{task_run_id}/deliverables"
    items: list[DeliverableSummary] = []
    for row in rows:
        items.append(_row_to_summary(row, download_url=prefix))
    return items


def _row_to_summary(
    row: AgentTaskDeliverableDB, *, download_url: str | None
) -> DeliverableSummary:
    is_ready = row.status == "ready"
    return DeliverableSummary(
        id=row.id,
        name=row.name,
        kind=cast(Literal["json", "artifact"], row.kind),
        status=cast(Literal["pending", "ready", "failed"], row.status),
        media_type=row.media_type,
        display_filename=row.display_filename,
        size_bytes=row.size_bytes,
        sha256=row.sha256,
        download_url=f"{download_url}/{row.id}" if is_ready and download_url else None,
    )


def synthesize_legacy_manifest(
    deliverables_json: object,
) -> list[DeliverableSummary]:
    """Synthesize a manifest from a legacy ``deliverables_json`` blob.

    Used only for rows written previously that have no Deliverable rows.
    The body is loaded exactly once, on this one-run request, never from
    list/statistics/compare queries. Names are surfaced in lexical order.
    """
    if not isinstance(deliverables_json, dict) or not deliverables_json:
        return []
    items: list[DeliverableSummary] = []
    for name in sorted(deliverables_json):
        body = _compact_json_bytes(deliverables_json[name])
        items.append(
            DeliverableSummary(
                id=f"legacy:{name}",
                name=name,
                kind="json",
                status="ready",
                media_type="application/json",
                display_filename=None,
                size_bytes=len(body),
                sha256=_sha256_hex(body),
                download_url=None,  # legacy bodies have no per-id route
            )
        )
    return items


def read_legacy_deliverable_body(
    deliverables_json: object,
    deliverable_id: str,
) -> tuple[bytes, str]:
    """Resolve a ``legacy:<name>`` manifest id to its inline body.

    The mirror of :func:`synthesize_legacy_manifest`: the manifest advertises a
    ``legacy:<name>`` id with a measured ``size_bytes``/``sha256``, and this
    returns the compact-JSON body bytes plus that same digest so the body
    endpoint can serve what the manifest promised (issue #105).

    Raises :class:`KeyError` when the id is not a ``legacy:`` id, the inline
    blob is missing, or the named deliverable does not exist.
    """
    prefix = "legacy:"
    if not deliverable_id.startswith(prefix):
        raise KeyError(deliverable_id)
    name = deliverable_id[len(prefix):]
    if not isinstance(deliverables_json, dict) or name not in deliverables_json:
        raise KeyError(deliverable_id)
    body = _compact_json_bytes(deliverables_json[name])
    return body, _sha256_hex(body)


def build_trace_output_manifest(
    items: list[DeliverableSummary], task_run_id: str
) -> dict[str, object]:
    """Compact manifest written into ``RunDB.output``.

    Contains name/kind/size only — never a body. This replaces the old path
    that copied the full Deliverables object into the trace row.
    """
    return {
        "type": "apo.task-deliverables",
        "task_run_id": task_run_id,
        "count": len(items),
        "items": [
            {"name": i.name, "kind": i.kind, "size_bytes": i.size_bytes} for i in items
        ],
    }


# --- Artifact upload intents -----


def validate_deliverable_name(name: str) -> str:
    """Validate a Deliverable name: 1-255 UTF-8 bytes, no NUL/control chars."""
    if not name:
        raise ValueError("Deliverable name must not be empty")
    encoded = name.encode("utf-8")
    if len(encoded) > _NAME_MAX_BYTES:
        raise ValueError(
            f"Deliverable name exceeds {_NAME_MAX_BYTES} UTF-8 bytes"
        )
    if any(byte < 0x20 or byte == 0x7F for byte in encoded):
        raise ValueError("Deliverable name must not contain control characters")
    return name


def validate_sha256_hex(value: str) -> str:
    """Validate a SHA-256 hex digest (64 lowercase hex characters)."""
    if len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        raise ValueError("sha256 must be 64 lowercase hex characters")
    return value


async def create_artifact_upload_intent(
    session: Session,
    store: ArtifactStore,
    *,
    project: str,
    task_run_id: str,
    name: str,
    display_filename: str,
    media_type: str,
    size_bytes: int,
    sha256: str,
) -> ArtifactUploadIntent:
    """Open a two-phase Artifact upload, idempotent on matching metadata.

    Idempotent by ``(Project, Task Run, name)`` when all declared metadata
    matches. Conflicting metadata returns ``ValueError`` (caller maps to 409).
    Rejects terminal runs, name collisions with JSON Deliverables, and
    over-limit sizes.
    """
    validate_deliverable_name(name)
    validate_sha256_hex(sha256)
    if size_bytes <= 0:
        raise ValueError("size_bytes must be positive")
    if not display_filename:
        raise ValueError("display_filename must not be empty")
    if not media_type:
        raise ValueError("media_type must not be empty")

    max_item, max_run, _ = artifact_limits()
    if size_bytes > max_item:
        raise ValueError(
            f"Artifact size {size_bytes} exceeds per-item limit {max_item}"
        )

    task_run = _lock_task_run(session, task_run_id)
    if task_run is None:
        raise ValueError("Task run not found")
    if task_run.status in TASK_RUN_TERMINAL:
        raise ValueError(
            f"Task run {task_run_id} is terminal (status={task_run.status})"
        )

    _reject_run_total_overflow(session, task_run_id, size_bytes, max_run)

    # Idempotency: same run/name with identical metadata returns the existing row.
    existing = _find_deliverable(session, project, task_run_id, name)
    if existing is not None:
        if (
            existing.kind == "artifact"
            and existing.status in ("pending", "ready")
            and existing.display_filename == display_filename
            and existing.media_type == media_type
            and existing.size_bytes == size_bytes
            and existing.sha256 == sha256
        ):
            return _intent_from_row(existing)
        raise ValueError(
            f"Deliverable name '{name}' already exists with conflicting metadata"
        )

    row = AgentTaskDeliverableDB(
        id=_new_id(),
        project=project,
        task_run_id=task_run_id,
        name=name,
        kind="artifact",
        status="pending",
        storage_backend=store.name,
        storage_key=None,
        inline_value_json=None,
        display_filename=display_filename,
        media_type=media_type,
        content_encoding="identity",
        size_bytes=size_bytes,
        stored_size_bytes=None,
        sha256=sha256,
        created_at=datetime.now(timezone.utc),
        ready_at=None,
    )
    session.add(row)
    session.flush()
    return _intent_from_row(row)


async def complete_artifact_upload(
    session: Session,
    store: ArtifactStore,
    *,
    project: str,
    deliverable_id: str,
    body_stream: AsyncIterator[bytes],
    declared_size: int | None,
) -> DeliverableSummary:
    """Stream uploaded bytes into the store, verify, and mark the row ready.

    The store independently counts and hashes; size/digest mismatch raises
    ``ValueError`` (caller maps to 422) and leaves no completed object. Stale
    staging bytes are cleaned by the store.
    """
    row = session.get(AgentTaskDeliverableDB, deliverable_id)
    if row is None or row.project != project:
        raise KeyError(deliverable_id)
    if row.kind != "artifact":
        raise ValueError(f"Deliverable {deliverable_id} is not an artifact")
    if row.status == "ready":
        # Idempotent retry with matching metadata: return the ready summary.
        return _row_to_summary(row, download_url=None)
    if row.status == "failed":
        raise ValueError(f"Deliverable {deliverable_id} is failed; create a new intent")

    if declared_size is not None and declared_size != row.size_bytes:
        raise ValueError(
            f"Content-Length {declared_size} does not match declared {row.size_bytes}"
        )

    key = _storage_key()
    stored = await store.put(
        key,
        body_stream,
        expected_size=row.size_bytes,
        expected_sha256=row.sha256,
    )

    # SPEC-172 fence: lock the Task Run before promoting to ready. If the run
    # became terminal while bytes were streaming, compensate by deleting the
    # just-written object and reject.
    task_run = _lock_task_run(session, row.task_run_id)
    if task_run is None:
        try:
            await store.delete(key)
        except Exception:
            pass
        raise ValueError(
            f"artifact_upload_closed: Task Run {row.task_run_id} no longer exists"
        )
    if task_run.status in TASK_RUN_TERMINAL:
        try:
            await store.delete(key)
        except Exception:
            pass
        raise ValueError(
            f"artifact_upload_closed: Task Run {row.task_run_id} no longer accepts Artifact uploads"
        )

    # Re-check the deliverable row: a concurrent PUT may have already promoted it.
    session.refresh(row)
    if row.status == "ready":
        # Idempotent: a concurrent PUT already completed this upload.
        try:
            await store.delete(key)
        except Exception:
            pass
        return _row_to_summary(row, download_url=None)

    row.storage_key = key
    row.storage_backend = stored.backend
    row.stored_size_bytes = stored.size_bytes
    row.status = "ready"
    row.ready_at = datetime.now(timezone.utc)
    session.add(row)
    session.flush()
    return _row_to_summary(row, download_url=None)


def load_deliverable_for_download(
    session: Session, *, project: str, deliverable_id: str
) -> AgentTaskDeliverableDB:
    """Load one Deliverable for body download, project-scoped.

    Raises ``KeyError`` when absent or outside the caller's Project. Only this
    path (and ``complete_artifact_upload``) opens a body.
    """
    row = session.get(AgentTaskDeliverableDB, deliverable_id)
    if row is None or row.project != project or row.status != "ready":
        raise KeyError(deliverable_id)
    return row


def _find_deliverable(
    session: Session, project: str, task_run_id: str, name: str
) -> AgentTaskDeliverableDB | None:
    return session.exec(
        select(AgentTaskDeliverableDB).where(
            AgentTaskDeliverableDB.project == project,
            AgentTaskDeliverableDB.task_run_id == task_run_id,
            AgentTaskDeliverableDB.name == name,
        )
    ).first()


def _reject_run_total_overflow(
    session: Session,
    task_run_id: str,
    incoming_size: int,
    max_run: int,
) -> None:
    """Reject an upload that would push the run over its total byte budget."""
    rows = session.exec(
        select(
            _as_column(AgentTaskDeliverableDB.size_bytes),
        ).where(AgentTaskDeliverableDB.task_run_id == task_run_id)
    ).all()
    # Single-column select returns scalars directly.
    pending_ready = sum(int(r) for r in rows if r is not None)
    if pending_ready + incoming_size > max_run:
        raise ValueError(
            f"Task run {task_run_id} would exceed total Deliverable byte limit "
            f"({max_run})"
        )


def _intent_from_row(row: AgentTaskDeliverableDB) -> ArtifactUploadIntent:
    summary = _row_to_summary(row, download_url=None)
    return ArtifactUploadIntent(
        id=row.id,
        deliverable=summary,
        method="PUT",
        upload_url=f"/v1/agent-task-artifact-uploads/{row.id}",
        required_headers={
            "Content-Type": "application/octet-stream",
            "Content-Length": str(row.size_bytes),
        },
        expires_at=datetime.now(timezone.utc) + _UPLOAD_INTENT_TTL,
    )


# --- helpers -----------------------------------------------------------------


def _compact_json_bytes(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _as_json_safe(value: object) -> object:
    # The value is already JSON-serializable (we just encoded it). Return as-is
    # so the stored wrapper round-trips through SQLModel's JSON column.
    return value


def _new_id() -> str:
    return "dlv_" + secrets.token_hex(12)


def _storage_key() -> str:
    token = secrets.token_hex(16)
    shard = token[:2]
    return f"{shard}/{token}"


async def _async_iter(chunks: list[bytes]) -> AsyncIterator[bytes]:
    # Tiny async generator wrapping an in-memory buffer; the store still
    # verifies size and digest independently.
    for chunk in chunks:
        yield chunk
