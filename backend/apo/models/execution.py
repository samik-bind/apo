"""SPEC-142: Task Revision transport/domain schemas.

Public-safe serializers and the caller attestation shape. ``TaskRevisionSummary``
deliberately omits private storage fields (``bundle_storage_key``, the full
per-file manifest, raw excluded filenames) and full filesystem paths.
``CallerSourceAttestation`` is added here for contract testing; SPEC-145 wires
it into the CLI/API path.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from sqlmodel import SQLModel


class TaskRevisionSummary(SQLModel):
    """Public-safe view of a Task Revision (no private storage fields)."""

    id: str
    materialization: Literal["attested", "bundled"]
    source_type: str
    source_ref: str | None = None
    commit_sha: str | None = None
    dirty: bool
    content_sha256: str
    file_count: int
    uncompressed_size_bytes: int
    bundle_size_bytes: int | None = None
    created_at: datetime


class CallerSourceAttestation(SQLModel):
    """Caller-reported source identity without uploading source bytes (SPEC-145).

    Authenticated self-reported provenance, not a source backup. apo stores the
    digest, bounded summary, base commit, and dirty state; it has no bundle
    storage key. A dirty attestation must never be serialized as "executed
    commit X" without also stating that its content differs.
    """

    source_type: Literal["caller_worktree"]
    repository_url: str | None = None
    base_commit_sha: str | None = None
    dirty: bool
    content_sha256: str
    task_root_label: str
    file_count: int
    uncompressed_size_bytes: int


__all__ = ["CallerSourceAttestation", "TaskRevisionSummary"]
