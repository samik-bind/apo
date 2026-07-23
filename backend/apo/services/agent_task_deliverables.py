"""SPEC-140 ticket 03: Deliverable service.

Owns JSON validation, compact serialization, inline-vs-object placement,
manifest construction, and upload state transitions. The service, not the
routes, owns these concerns so backend and external execution paths share
one finalization boundary.

Placement rules (SPEC-140 §"Chosen storage matrix"):

- compact UTF-8 size <= ``INLINE_THRESHOLD_BYTES`` -> stored inline as
  ``{"value": <value>}`` on the row;
- otherwise gzip-compressed once and written through the configured
  ``ArtifactStore``; the manifest reports the logical uncompressed size and
  digest while storage compression stays an implementation detail.

Storage placement never changes product meaning: a large JSON Deliverable
stored as an object is still a JSON Deliverable, not an Artifact.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import secrets
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from typing import Literal, cast

from sqlmodel import Session, select

from apo.db_helpers import _as_column
from apo.models.db import AgentTaskDeliverableDB
from apo.models.schemas import DeliverableSummary
from apo.services.artifact_store import ArtifactStore

# SPEC-140 §3 — inline threshold is a code constant, not a tuning knob.
INLINE_THRESHOLD_BYTES = 64 * 1024  # 64 KiB


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
    body = _compact_json_bytes(value)
    size = len(body)
    sha = _sha256_hex(body)

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

    Used only for rows written before SPEC-140 that have no Deliverable rows.
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


def build_trace_output_manifest(
    items: list[DeliverableSummary], task_run_id: str
) -> dict[str, object]:
    """Compact manifest written into ``RunDB.output`` (SPEC-140 §Trace linkage).

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
