"""SPEC-142: Task Revision transport/domain schemas.

Public-safe serializers and the caller attestation shape. ``TaskRevisionSummary``
deliberately omits private storage fields (``bundle_storage_key``, the full
per-file manifest, raw excluded filenames) and full filesystem paths.
``CallerSourceAttestation`` is added here for contract testing; SPEC-145 wires
it into the CLI/API path.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from sqlmodel import SQLModel


# ============================================================================
# SPEC-142: Task Revision transport schemas
# ============================================================================


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


class CallerTaskDescriptor(SQLModel):
    """Bounded discovered metadata for the single Task a caller run targets.

    If it matches current backend inventory, the Task Run links the inventory
    row; if it is new/dirty-only, the backend stores ``task_inventory_id=null``
    and uses this descriptor. It never substitutes a different inventory Task.
    """

    task_id: str
    task_path: str
    display_name: str
    adapter_name: str | None = None
    has_checks: bool = False


class CallerIdentity(SQLModel):
    """Bounded allow-listed caller metadata (no raw hostname by default).

    Each value <=255 UTF-8 bytes; total <=4 KiB. Stored on the caller Attempt's
    ``executor_snapshot_json`` for auditability.
    """

    client: str  # "apo-cli"
    client_version: str
    hostname_hash: str | None = None
    ci_provider: str | None = None
    ci_job_id: str | None = None
    git_branch: str | None = None
    os: str
    architecture: str


__all__ = [
    "AttemptStatus",
    "AttemptSummary",
    "CallerIdentity",
    "CallerSourceAttestation",
    "CallerTaskDescriptor",
    "ExecutionPhase",
    "ExecutorCapabilities",
    "ExecutorPoolKind",
    "PoolExecutionTarget",
    "ProjectActor",
    "TaskRevisionSummary",
]


# ============================================================================
# SPEC-143: Execution Control Plane domain types
# ============================================================================

EXECUTOR_PROTOCOL_VERSION = 1
SUPPORTED_EXECUTOR_PROTOCOL_VERSIONS = {1, 2}

ExecutorPoolKind = Literal["bundled", "connected", "managed"]
AttemptStatus = Literal[
    "queued", "leased", "running",
    "succeeded", "failed", "cancelled", "lost",
]
ExecutionPhase = Literal[
    "claiming", "downloading", "preparing",
    "running", "uploading", "finalizing",
]


class PoolExecutionTarget(SQLModel):
    """Execution target resolved once at Batch creation: a specific Pool."""

    kind: Literal["pool"]
    pool_id: str


class ExecutorCapabilities(SQLModel):
    """Capabilities an Executor reports at enrollment (drives claim matching)."""

    protocol_version: int
    executor_version: str
    driver_kinds: list[str]
    os: str
    architecture: str
    runtimes: dict[str, str]
    max_concurrency: int


class AttemptSummary(SQLModel):
    """Public-safe view of an Execution Attempt."""

    id: str
    task_run_id: str
    status: AttemptStatus
    phase: ExecutionPhase | None = None
    executor_id: str | None = None
    executor_name: str | None = None
    executor_pool_id: str | None = None
    driver_kind: str | None = None
    queued_at: datetime
    claimed_at: datetime | None = None
    started_at: datetime | None = None
    heartbeat_at: datetime | None = None
    completed_at: datetime | None = None
    failure_kind: str | None = None
    error_message: str | None = None
    cancel_requested_at: datetime | None = None


@dataclass(frozen=True)
class ProjectActor:
    """A verified Project member acting on a request (SPEC-143).

    Unlike the legacy batch path (which trusted ``request.project`` from the
    body), pooled Batch creation requires the caller to resolve a real
    membership first. Built by ``resolve_project_actor`` in
    ``execution_pools`` via ``require_project_role_strict``.
    """

    project_id: str
    user_id: str
    role: str
