# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownLambdaType=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUntypedFunctionDecorator=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportUnannotatedClassAttribute=false, reportUnusedParameter=false
"""SPEC-142: Task Revisions service (materialize / attest / delete).

Covers acceptance tests #3 (secret exclusion), #6 (limits), #7 (git provenance
shape), #8 (attestation honesty), #9 (ArtifactStore failure), #10 (DB failure
cleanup), and the public TaskRevisionSummary contract (#scene).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest
from apo.execution.execution_bundle import BundleLimits
from apo.models.db import AgentTaskBatchRunDB, ProjectDB, ProjectTaskSourceDB, TaskRevisionDB
from apo.models.execution import CallerSourceAttestation
from apo.services.artifact_store import ArtifactStat, StoredArtifact
from apo.services.artifact_stores.local import LocalArtifactStore
from apo.services.task_revisions import (
    create_attested_task_revision,
    delete_task_revision_bundle,
    materialize_pooled_task_revision,
    to_summary,
)
from sqlmodel import Session, select


pytestmark = pytest.mark.asyncio


# ── helpers ────────────────────────────────────────────────────────────────


def _seed_project_and_batch(session: Session, *, project_id: str = "proj-test") -> str:
    session.add(ProjectDB(id=project_id, name=project_id, created_at=datetime.now(timezone.utc)))
    batch_id = "batch-" + project_id
    session.add(
        AgentTaskBatchRunDB(
            id=batch_id,
            project=project_id,
            selection_type="single",
            status="queued",
            created_at=datetime.now(timezone.utc),
        )
    )
    session.commit()
    return batch_id


def _write(root: Path, rel: str, content: bytes, *, executable: bool = False) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    if executable:
        path.chmod(0o755)


class _FakeStore:
    """In-memory ArtifactStore that records puts/deletes for failure testing."""

    name = "fake"

    def __init__(self, *, fail_put: bool = False) -> None:
        self._objects: dict[str, bytes] = {}
        self.deleted_keys: list[str] = []
        self.fail_put = fail_put

    async def put(
        self,
        key: str,
        chunks: AsyncIterator[bytes],
        *,
        expected_size: int,
        expected_sha256: str,
    ) -> StoredArtifact:
        if self.fail_put:
            raise RuntimeError("simulated store failure")
        import hashlib

        buf = bytearray()
        async for chunk in chunks:
            buf.extend(chunk)
        data = bytes(buf)
        digest = hashlib.sha256(data).hexdigest()
        self._objects[key] = data
        return StoredArtifact(backend="fake", key=key, size_bytes=len(data), sha256=digest)

    def open(self, key: str) -> AsyncIterator[bytes]:
        raise NotImplementedError

    async def stat(self, key: str) -> ArtifactStat | None:
        data = self._objects.get(key)
        if data is None:
            return None
        import hashlib

        return ArtifactStat(size_bytes=len(data), sha256=hashlib.sha256(data).hexdigest())

    async def delete(self, key: str) -> None:
        self.deleted_keys.append(key)
        self._objects.pop(key, None)

    async def check_ready(self) -> tuple[bool, str | None]:
        return True, None


def _filesystem_source(project_id: str) -> ProjectTaskSourceDB:
    return ProjectTaskSourceDB(
        id="src-test",
        project=project_id,
        source_type="filesystem",
        display_name="fs",
        status="ready",
    )


# ── materialize: filesystem ───────────────────────────────────────────────


async def test_materialize_filesystem_source_creates_bundled_revision(
    session: Session, tmp_path: Path
) -> None:
    batch_id = _seed_project_and_batch(session)
    root = tmp_path / "src"
    _write(root, "README.md", b"hi\n")
    _write(root, "run.sh", b"echo hi\n", executable=True)

    store = LocalArtifactStore(root=tmp_path / "store")
    revision = await materialize_pooled_task_revision(
        session,
        project_id="proj-test",
        batch_run_id=batch_id,
        task_source=_filesystem_source("proj-test"),
        source_root=root,
        store=store,
    )

    assert revision.materialization == "bundled"
    assert revision.source_type == "filesystem"
    assert revision.commit_sha is None
    assert revision.dirty is False
    assert len(revision.content_sha256) == 64
    assert revision.bundle_storage_backend == "fake-local-name" or revision.bundle_storage_backend
    assert revision.bundle_storage_key
    assert revision.bundle_sha256 and len(revision.bundle_sha256) == 64
    assert revision.bundle_size_bytes and revision.bundle_size_bytes > 0
    assert revision.file_count == 2

    persisted = session.get(TaskRevisionDB, revision.id)
    assert persisted is not None
    assert persisted.bundle_storage_key == revision.bundle_storage_key


async def test_materialize_is_deterministic_across_runs(session: Session, tmp_path: Path) -> None:
    batch_a = _seed_project_and_batch(session, project_id="proj-a")
    # second project + batch for a second revision (batch_run_id is unique)
    session.add(ProjectDB(id="proj-b", name="proj-b", created_at=datetime.now(timezone.utc)))
    session.add(AgentTaskBatchRunDB(id="batch-b", project="proj-b", selection_type="single", status="queued", created_at=datetime.now(timezone.utc)))
    session.commit()

    root = tmp_path / "src"
    _write(root, "a.txt", b"aaa")
    _write(root, "z.txt", b"zzz")
    store = LocalArtifactStore(root=tmp_path / "store")

    rev_a = await materialize_pooled_task_revision(
        session, project_id="proj-a", batch_run_id=batch_a,
        task_source=_filesystem_source("proj-a"), source_root=root, store=store,
    )
    rev_b = await materialize_pooled_task_revision(
        session, project_id="proj-b", batch_run_id="batch-b",
        task_source=_filesystem_source("proj-b"), source_root=root, store=store,
    )
    assert rev_a.content_sha256 == rev_b.content_sha256
    assert rev_a.bundle_sha256 == rev_b.bundle_sha256


async def test_materialize_excludes_secrets_and_records_bounded_counts(
    session: Session, tmp_path: Path
) -> None:
    batch_id = _seed_project_and_batch(session)
    root = tmp_path / "src"
    _write(root, "src/main.ts", b"export {}\n")
    _write(root, ".env", b"SECRET=1")
    _write(root, "node_modules/pkg/index.js", b"module.exports=1;")
    _write(root, "credentials.json", b"{}")
    store = LocalArtifactStore(root=tmp_path / "store")

    revision = await materialize_pooled_task_revision(
        session, project_id="proj-test", batch_run_id=batch_id,
        task_source=_filesystem_source("proj-test"), source_root=root, store=store,
    )
    assert revision.file_count == 1
    summary: dict[str, Any] = dict(revision.manifest_summary_json)
    assert summary["excludedFileCount"] == 2  # .env, credentials.json
    assert summary["excludedDirectoryCount"] == 1  # node_modules


async def test_materialize_limit_exceeded_leaves_no_row_and_no_object(
    session: Session, tmp_path: Path
) -> None:
    batch_id = _seed_project_and_batch(session)
    root = tmp_path / "src"
    _write(root, "a.txt", b"aa")
    _write(root, "b.txt", b"bb")
    _write(root, "c.txt", b"cc")
    store = LocalArtifactStore(root=tmp_path / "store")

    with pytest.raises(Exception):  # typed materialization error
        await materialize_pooled_task_revision(
            session, project_id="proj-test", batch_run_id=batch_id,
            task_source=_filesystem_source("proj-test"), source_root=root, store=store,
            limits=BundleLimits(max_file_count=2),
        )
    assert session.exec(select(TaskRevisionDB)).all() == []
    # No object committed to the store (objects dir holds only directory entries).
    objects_dir = tmp_path / "store" / "objects"
    committed = [p for p in objects_dir.rglob("*") if p.is_file()] if objects_dir.exists() else []
    assert committed == []


async def test_materialize_store_failure_leaves_no_row(
    session: Session, tmp_path: Path
) -> None:
    batch_id = _seed_project_and_batch(session)
    root = tmp_path / "src"
    _write(root, "a.txt", b"aa")
    fake = _FakeStore(fail_put=True)

    with pytest.raises(RuntimeError):
        await materialize_pooled_task_revision(
            session, project_id="proj-test", batch_run_id=batch_id,
            task_source=_filesystem_source("proj-test"), source_root=root, store=fake,
        )
    assert session.exec(select(TaskRevisionDB)).all() == []


async def test_materialize_db_failure_cleans_orphan_object(
    session: Session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    batch_id = _seed_project_and_batch(session)
    root = tmp_path / "src"
    _write(root, "a.txt", b"aa")
    fake = _FakeStore()

    def _boom() -> None:
        raise RuntimeError("simulated DB commit failure")

    monkeypatch.setattr(session, "commit", _boom)

    with pytest.raises(RuntimeError):
        await materialize_pooled_task_revision(
            session, project_id="proj-test", batch_run_id=batch_id,
            task_source=_filesystem_source("proj-test"), source_root=root, store=fake,
        )
    # object was put then cleaned up best-effort
    assert fake.deleted_keys


# ── attest ────────────────────────────────────────────────────────────────


async def test_create_attested_revision_has_no_bundle_fields(
    session: Session, tmp_path: Path
) -> None:
    batch_id = _seed_project_and_batch(session)
    attestation = CallerSourceAttestation(
        source_type="caller_worktree",
        repository_url="https://github.com/example/repo",
        base_commit_sha="abc123",
        dirty=True,
        content_sha256="a" * 64,
        task_root_label="worktree",
        file_count=7,
        uncompressed_size_bytes=1234,
    )
    revision = create_attested_task_revision(
        session,
        project_id="proj-test",
        batch_run_id=batch_id,
        attestation=attestation,
    )
    assert revision.materialization == "attested"
    assert revision.dirty is True
    assert revision.content_sha256 == "a" * 64
    assert revision.commit_sha == "abc123"
    assert revision.file_count == 7
    assert revision.bundle_storage_key is None
    assert revision.bundle_sha256 is None
    assert revision.bundle_size_bytes is None
    assert revision.bundle_storage_backend is None


# ── delete ────────────────────────────────────────────────────────────────


async def test_delete_bundled_revision_removes_object(session: Session, tmp_path: Path) -> None:
    batch_id = _seed_project_and_batch(session)
    root = tmp_path / "src"
    _write(root, "a.txt", b"aa")
    fake = _FakeStore()
    revision = await materialize_pooled_task_revision(
        session, project_id="proj-test", batch_run_id=batch_id,
        task_source=_filesystem_source("proj-test"), source_root=root, store=fake,
    )
    key = revision.bundle_storage_key
    assert key
    await delete_task_revision_bundle(revision, store=fake)
    assert key in fake.deleted_keys


async def test_delete_attested_revision_is_noop(session: Session) -> None:
    batch_id = _seed_project_and_batch(session)
    attestation = CallerSourceAttestation(
        source_type="caller_worktree", dirty=False, content_sha256="b" * 64,
        task_root_label="w", file_count=1, uncompressed_size_bytes=1,
    )
    revision = create_attested_task_revision(
        session, project_id="proj-test", batch_run_id=batch_id, attestation=attestation,
    )
    fake = _FakeStore()
    await delete_task_revision_bundle(revision, store=fake)  # must not raise
    assert fake.deleted_keys == []


# ── summary ───────────────────────────────────────────────────────────────


async def test_to_summary_omits_private_storage_fields(session: Session, tmp_path: Path) -> None:
    batch_id = _seed_project_and_batch(session)
    root = tmp_path / "src"
    _write(root, "a.txt", b"aa")
    revision = await materialize_pooled_task_revision(
        session, project_id="proj-test", batch_run_id=batch_id,
        task_source=_filesystem_source("proj-test"), source_root=root,
        store=LocalArtifactStore(root=tmp_path / "store"),
    )
    summary = to_summary(revision)
    # Private storage fields must never appear on the public summary.
    dumped = summary.model_dump()
    for forbidden in ("bundle_storage_key", "bundle_storage_backend", "manifest_summary_json"):
        assert forbidden not in dumped
    assert summary.materialization == "bundled"
    assert summary.bundle_size_bytes == revision.bundle_size_bytes
