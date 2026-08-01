"""SPEC-142: Task Revisions service.

Materializes immutable Task Revisions for pooled execution, records caller
attestations, deletes bundle objects, and exposes a public-safe summary. The
Control Plane owns the durable record and the bundle object; it never executes
customer code.

Object-vs-row atomicity: a bundle object is written through the configured
``ArtifactStore`` *before* the relational row commits. If the DB write fails,
the orphan object is deleted best-effort (idempotent). If the object write
fails, no row is created.

This is a foundation spec: nothing here changes where Tasks run and no
production batch-creation path calls it yet.
"""

from __future__ import annotations

import os
import secrets
import unicodedata
from collections.abc import AsyncIterator, Sequence
from datetime import datetime, timezone
from pathlib import Path

from sqlmodel import Session, select

from apo.db_helpers import _as_column

from apo.execution.execution_bundle import (
    DEFAULT_BUNDLE_LIMITS,
    BundleEntry,
    BundleError,
    BundleLimits,
    write_bundle,
)
from apo.execution.task_revision_manifest import (
    ManifestFileInput,
    build_manifest,
    content_sha256,
)
from apo.models.db import ProjectTaskSourceDB, TaskRevisionDB
from apo.models.execution import CallerSourceAttestation, TaskRevisionSummary
from apo.services.artifact_store import ArtifactStore
from apo.services.artifact_stores.registry import get_store


class TaskRevisionError(Exception):
    """Typed materialization/attestation failure (limit / source / invariant)."""

    kind: str

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(f"[{kind}] {message}")
        self.kind = kind


# Directory basenames always excluded (mirrors the CLI walker).
_EXCLUDED_DIR_NAMES = frozenset(
    {
        ".git",
        "node_modules",
        ".venv",
        "venv",
        "__pycache__",
        ".cache",
        ".turbo",
        ".next",
        ".nuxt",
        ".gradle",
        "dist",
        "build",
        "out",
        "target",
        "coverage",
        ".coverage",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        ".apo",
    }
)

# Exact file basenames always excluded (credentials / secret-bearing).
_EXCLUDED_FILE_NAMES = frozenset(
    {".env", ".npmrc", ".pypirc", "credentials", "credentials.json", ".DS_Store", "thumbs.db"}
)


def _is_excluded_file(name: str) -> bool:
    return name in _EXCLUDED_FILE_NAMES or name.startswith(".env.")


def walk_source_root(
    root: Path,
    *,
    limits: BundleLimits = DEFAULT_BUNDLE_LIMITS,
) -> tuple[list[ManifestFileInput], int, int]:
    """Walk a credential-free source root, returning (inputs, excluded_files, excluded_dirs).

    Applies the required exclusions and limits, never follows links, and counts
    excluded entries by entry (not by an excluded directory's contents) so the
    bounded summary never reveals secret-looking filenames.
    """
    inputs: list[ManifestFileInput] = []
    total_bytes = 0
    excluded_files = 0
    excluded_dirs = 0

    for dirpath, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        # Prune excluded directories in place so os.walk does not descend.
        kept: list[str] = []
        for d in dirnames:
            if d in _EXCLUDED_DIR_NAMES:
                excluded_dirs += 1
            else:
                kept.append(d)
        dirnames[:] = kept

        for name in filenames:
            full = Path(dirpath, name)
            try:
                st = full.lstat()
            except OSError:
                excluded_files += 1
                continue
            if not st.st_mode & 0o170000 == 0o100000:  # not a regular file
                excluded_files += 1
                continue
            if _is_excluded_file(name):
                excluded_files += 1
                continue

            rel = _relative_posix(root, full)
            _check_path_limits(rel, limits)
            size = st.st_size
            if size > limits.max_file_bytes:
                raise TaskRevisionError("limit", f"file {name!r} exceeds per-file limit")
            if total_bytes + size > limits.max_total_uncompressed_bytes:
                raise TaskRevisionError("limit", "workspace exceeds total-size limit")
            total_bytes += size
            if len(inputs) + 1 > limits.max_file_count:
                raise TaskRevisionError("limit", "workspace exceeds file-count limit")

            mode_class = "executable" if (st.st_mode & 0o111) else "regular"
            inputs.append(
                ManifestFileInput(path=rel, mode_class=mode_class, content=full.read_bytes())
            )

    return inputs, excluded_files, excluded_dirs


def _relative_posix(root: Path, path: Path) -> str:
    rel = path.relative_to(root).as_posix()
    return unicodedata.normalize("NFC", rel)


def _check_path_limits(rel: str, limits: BundleLimits) -> None:
    for seg in rel.split("/"):
        if len(seg.encode("utf-8")) > limits.max_path_segment_bytes:
            raise TaskRevisionError("limit", f"path segment exceeds {limits.max_path_segment_bytes} bytes")
    if len(rel.encode("utf-8")) > limits.max_path_bytes:
        raise TaskRevisionError("limit", f"path exceeds {limits.max_path_bytes} bytes")


def _new_revision_id() -> str:
    return "rev_" + secrets.token_hex(12)


def _new_bundle_key() -> str:
    return "bnd_" + secrets.token_hex(16)


def _sanitize_git_url(url: str | None) -> str | None:
    """Drop user-info from a Git URL so credentials never reach the record."""
    if not url:
        return url
    cleaned = url
    if "://" in cleaned:
        scheme, rest = cleaned.split("://", 1)
        if "@" in rest:
            rest = rest.split("@", 1)[1]
        cleaned = f"{scheme}://{rest}"
    return cleaned


def _resolve_store(store: ArtifactStore | None) -> ArtifactStore:
    return store if store is not None else get_store(None)


async def materialize_pooled_task_revision(
    session: Session,
    *,
    project_id: str,
    batch_run_id: str,
    task_source: ProjectTaskSourceDB,
    resolved_commit_sha: str | None = None,
    source_root: Path | None = None,
    store: ArtifactStore | None = None,
    limits: BundleLimits = DEFAULT_BUNDLE_LIMITS,
    commit: bool = True,
) -> TaskRevisionDB:
    """Snapshot, bundle, store, and persist one immutable bundled Task Revision.

    Production resolves the source root through the existing immutable source
    snapshot machinery (``resolve_task_source_root``); tests inject
    ``source_root`` directly. The bundle is streamed through the configured
    ``ArtifactStore`` before the relational row commits; on DB failure the
    orphan object is deleted best-effort.
    """
    root = source_root if source_root is not None else _resolve_production_root(
        session, task_source, resolved_commit_sha
    )
    resolved_store = _resolve_store(store)

    inputs, excluded_files, excluded_dirs = walk_source_root(root, limits=limits)
    manifest = build_manifest(
        inputs, excluded_file_count=excluded_files, excluded_directory_count=excluded_dirs
    )
    digest = content_sha256(manifest)

    bundle_path = Path(_bundle_temp_path())
    try:
        entries = [
            BundleEntry(path=f.path, mode_class=f.mode_class, content=_content_for(inputs, f.path))
            for f in manifest.files
        ]
        bundle_size, bundle_sha = write_bundle(entries, bundle_path, limits=limits)
    except BundleError as exc:
        raise TaskRevisionError(exc.kind, str(exc)) from exc

    key = _new_bundle_key()
    committed_key: str | None = None
    try:

        async def _chunks() -> AsyncIterator[bytes]:
            with open(bundle_path, "rb") as fh:
                while True:
                    block = fh.read(1024 * 1024)
                    if not block:
                        break
                    yield block

        _ = await resolved_store.put(
            key,
            _chunks(),
            expected_size=bundle_size,
            expected_sha256=bundle_sha,
        )
        committed_key = key
    finally:
        bundle_path.unlink(missing_ok=True)

    source_type, source_ref, commit_sha, dirty = _provenance(task_source, resolved_commit_sha)
    manifest_summary: dict[str, object] = {
        "fileCount": manifest.summary.file_count,
        "uncompressedSizeBytes": manifest.summary.uncompressed_size_bytes,
        "excludedFileCount": manifest.summary.excluded_file_count,
        "excludedDirectoryCount": manifest.summary.excluded_directory_count,
    }

    row = TaskRevisionDB(
        id=_new_revision_id(),
        project=project_id,
        batch_run_id=batch_run_id,
        materialization="bundled",
        source_type=source_type,
        source_ref=source_ref,
        commit_sha=commit_sha,
        dirty=dirty,
        content_sha256=digest,
        file_count=manifest.summary.file_count,
        uncompressed_size_bytes=manifest.summary.uncompressed_size_bytes,
        manifest_summary_json=manifest_summary,
        bundle_storage_backend=resolved_store.name,
        bundle_storage_key=committed_key,
        bundle_sha256=bundle_sha,
        bundle_size_bytes=bundle_size,
        created_at=datetime.now(timezone.utc),
    )

    try:
        session.add(row)
        if commit:
            session.commit()
            session.refresh(row)
        else:
            session.flush()
    except Exception:
        # We only reach here after object storage succeeded, so committed_key
        # is guaranteed set — delete the orphan object best-effort.
        try:
            await resolved_store.delete(committed_key)
        except Exception:
            pass
        raise
    return row


def _content_for(inputs: list[ManifestFileInput], normalized_path: str) -> bytes:
    """Return the original bytes whose normalized path matches ``normalized_path``."""
    target = unicodedata.normalize("NFC", normalized_path)
    for i in inputs:
        if unicodedata.normalize("NFC", i.path.replace("\\", "/")) == target:
            return i.content
    raise TaskRevisionError("structure", f"missing content for {normalized_path!r}")


def _bundle_temp_path() -> str:
    import tempfile

    fd, path = tempfile.mkstemp(prefix="apo-bundle-", suffix=".tar.gz")
    os.close(fd)
    return path


def _resolve_production_root(
    session: Session, task_source: ProjectTaskSourceDB, commit_sha: str | None
) -> Path:
    from apo.services.project_task_source_sync import resolve_task_source_root

    return resolve_task_source_root(session, task_source, resolved_commit_sha=commit_sha)


def _provenance(
    task_source: ProjectTaskSourceDB, resolved_commit_sha: str | None
) -> tuple[str, str | None, str | None, bool]:
    source_type = task_source.source_type
    if source_type == "git":
        return source_type, _sanitize_git_url(task_source.repository_url), resolved_commit_sha, False
    if source_type in ("filesystem", "demo"):
        return source_type, None, None, False
    return source_type, None, resolved_commit_sha, False


def create_attested_task_revision(
    session: Session,
    *,
    project_id: str,
    batch_run_id: str,
    attestation: CallerSourceAttestation,
) -> TaskRevisionDB:
    """Persist a caller-attested source identity without source bytes.

    Attested revisions carry no bundle fields. ``dirty`` and ``content_sha256``
    come straight from the authenticated attestation; a dirty attestation must
    never be serialized as "executed commit X" without also stating its content
    differs.

    ``CallerSourceAttestation.source_type`` is ``Literal["caller_worktree"]`` so
    the schema already rejects any other value.
    """
    row = TaskRevisionDB(
        id=_new_revision_id(),
        project=project_id,
        batch_run_id=batch_run_id,
        materialization="attested",
        source_type="caller_worktree",
        source_ref=attestation.task_root_label,
        commit_sha=attestation.base_commit_sha,
        dirty=attestation.dirty,
        content_sha256=attestation.content_sha256,
        file_count=attestation.file_count,
        uncompressed_size_bytes=attestation.uncompressed_size_bytes,
        manifest_summary_json={
            "fileCount": attestation.file_count,
            "uncompressedSizeBytes": attestation.uncompressed_size_bytes,
            "excludedFileCount": 0,
            "excludedDirectoryCount": 0,
        },
        bundle_storage_backend=None,
        bundle_storage_key=None,
        bundle_sha256=None,
        bundle_size_bytes=None,
        created_at=datetime.now(timezone.utc),
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


async def delete_task_revision_bundle(
    revision: TaskRevisionDB,
    *,
    store: ArtifactStore | None = None,
) -> None:
    """Idempotently delete the bundle object for a bundled revision.

    Attested revisions have no object and are a no-op.
    """
    key = revision.bundle_storage_key
    if not key:
        return
    backend = revision.bundle_storage_backend or "local"
    resolved = store if store is not None else get_store(backend)
    try:
        await resolved.delete(key)
    except Exception:
        # Idempotent: a missing or already-deleted object is not an error.
        return


async def delete_task_revision_bundles_for_batches(
    session: Session,
    batch_ids: list[str],
) -> int:
    """Delete bundle objects for revisions in the given batches BEFORE their rows.

    Mirrors SPEC-140 ``delete_deliverable_objects_for_runs``: objects are
    removed idempotently first, grouped by backend; only after success may the
    relational rows go. Returns the number of objects deleted.
    """
    if not batch_ids:
        return 0
    rows = session.exec(
        select(TaskRevisionDB).where(
            _as_column(TaskRevisionDB.batch_run_id).in_(batch_ids),
            _as_column(TaskRevisionDB.bundle_storage_key).is_not(None),
        )
    ).all()
    return await _delete_bundled_objects(rows)


async def delete_task_revision_bundles_for_project(
    session: Session,
    project_id: str,
) -> int:
    """Delete bundle objects for all revisions in a project BEFORE their rows."""
    rows = session.exec(
        select(TaskRevisionDB).where(
            TaskRevisionDB.project == project_id,
            _as_column(TaskRevisionDB.bundle_storage_key).is_not(None),
        )
    ).all()
    return await _delete_bundled_objects(rows)


async def _delete_bundled_objects(rows: Sequence[TaskRevisionDB]) -> int:
    """Delete objects grouped by the backend recorded on each row. Idempotent."""
    by_backend: dict[str, list[TaskRevisionDB]] = {}
    for row in rows:
        backend = row.bundle_storage_backend or "local"
        by_backend.setdefault(backend, []).append(row)
    deleted = 0
    for backend, group in by_backend.items():
        store = get_store(backend)
        for row in group:
            if row.bundle_storage_key is not None:
                try:
                    await store.delete(row.bundle_storage_key)
                    deleted += 1
                except Exception:
                    pass
    return deleted


def get_revision_for_batch(session: Session, batch_run_id: str) -> TaskRevisionDB | None:
    """Return the Revision for a Batch, if one exists (historical Batches have none)."""
    return session.exec(
        select(TaskRevisionDB).where(TaskRevisionDB.batch_run_id == batch_run_id)
    ).first()


def get_revision_summary_for_batch(
    session: Session, batch_run_id: str
) -> TaskRevisionSummary | None:
    """Public-safe Revision summary for a Batch, or None when no Revision exists."""
    revision = get_revision_for_batch(session, batch_run_id)
    return to_summary(revision) if revision is not None else None


def to_summary(revision: TaskRevisionDB) -> TaskRevisionSummary:
    """Public-safe view of a Revision (no private storage fields)."""
    materialization = revision.materialization
    if materialization not in ("attested", "bundled"):
        raise TaskRevisionError("invariant", f"bad materialization: {materialization!r}")
    return TaskRevisionSummary(
        id=revision.id,
        materialization=materialization,
        source_type=revision.source_type,
        source_ref=revision.source_ref,
        commit_sha=revision.commit_sha,
        dirty=revision.dirty,
        content_sha256=revision.content_sha256,
        file_count=revision.file_count,
        uncompressed_size_bytes=revision.uncompressed_size_bytes,
        bundle_size_bytes=revision.bundle_size_bytes,
        created_at=revision.created_at,
    )


__all__ = [
    "TaskRevisionError",
    "create_attested_task_revision",
    "delete_task_revision_bundle",
    "delete_task_revision_bundles_for_batches",
    "delete_task_revision_bundles_for_project",
    "get_revision_for_batch",
    "get_revision_summary_for_batch",
    "materialize_pooled_task_revision",
    "to_summary",
    "walk_source_root",
]
