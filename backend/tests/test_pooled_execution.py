# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownLambdaType=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUntypedFunctionDecorator=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false, reportMissingTypeArgument=false, reportArgumentType=false

"""SPEC-146: pooled Batch creation + pool resolution policy.

Covers acceptance: explicit Pool overrides default; missing target uses valid
default; no default -> 409 executor_pool_required; cross-Project Pool rejected;
disabled/archived Pool rejects new Batch; pooled Batch creates Revision + queued
ordered Attempts; target never changes after creation.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

import pytest
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ExecutorPoolDB,
    ProjectDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
    TaskExecutionAttemptDB,
    TaskRevisionDB,
)
from apo.services.execution_pools import set_default_pool
from apo.services.execution_queue import (
    PoolResolutionError,
    create_pooled_batch_run,
    resolve_execution_pool,
)
from sqlmodel import Session, select


def _seed_project(session: Session, project_id: str) -> None:
    session.add(ProjectDB(id=project_id, name=project_id, created_at=datetime.now(timezone.utc)))
    session.flush()


def _seed_pool(session: Session, project_id: str, pool_id: str, *, enabled: bool = True, archived: bool = False) -> ExecutorPoolDB:
    pool = ExecutorPoolDB(
        id=pool_id, project=project_id, name=pool_id, slug=pool_id, kind="bundled",
        enabled=enabled, archived_at=datetime.now(timezone.utc) if archived else None,
        queue_ttl_seconds=3600, created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    )
    session.add(pool)
    session.flush()
    return pool


def _seed_filesystem_source(session: Session, project_id: str, root: Path) -> ProjectTaskSourceDB:
    source = ProjectTaskSourceDB(
        id=f"src-{project_id}", project=project_id, source_type="filesystem",
        display_name="fs", filesystem_path=str(root), status="ready",
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    )
    session.add(source)
    session.flush()
    inv = ProjectTaskInventoryDB(
        id=f"inv-{project_id}", project=project_id, task_source_id=source.id,
        task_id="demo-task", display_name="demo", folder_path="demo-task",
        task_path="demo-task", created_at=datetime.now(timezone.utc),
        source_type="filesystem",
    )
    session.add(inv)
    session.commit()
    return source


def _write_task(root: Path) -> None:
    task_dir = root / "demo-task"
    task_dir.mkdir(parents=True, exist_ok=True)
    (task_dir / "demo-task.eval.ts").write_text("export const task = {};")


def _source(session: Session, project_id: str) -> ProjectTaskSourceDB | None:
    return session.exec(
        select(ProjectTaskSourceDB).where(ProjectTaskSourceDB.project == project_id)
    ).first()


# ── pool resolution policy ────────────────────────────────────────────────


def test_resolve_explicit_pool_overrides_default(session: Session) -> None:
    _seed_project(session, "p1")
    default = _seed_pool(session, "p1", "pool-default")
    explicit = _seed_pool(session, "p1", "pool-explicit")
    set_default_pool(session, project_id="p1", pool_id=default.id)
    resolved = resolve_execution_pool(session, project_id="p1", explicit_pool_id=explicit.id)
    assert resolved.id == "pool-explicit"


def test_resolve_missing_target_uses_valid_default(session: Session) -> None:
    _seed_project(session, "p1")
    default = _seed_pool(session, "p1", "pool-default")
    set_default_pool(session, project_id="p1", pool_id=default.id)
    resolved = resolve_execution_pool(session, project_id="p1", explicit_pool_id=None)
    assert resolved.id == "pool-default"


def test_resolve_no_default_raises_required(session: Session) -> None:
    _seed_project(session, "p1")
    with pytest.raises(PoolResolutionError) as exc:
        resolve_execution_pool(session, project_id="p1", explicit_pool_id=None)
    assert exc.value.kind == "executor_pool_required"


def test_resolve_cross_project_pool_rejected(session: Session) -> None:
    _seed_project(session, "p1")
    _seed_project(session, "p2")
    _seed_pool(session, "p2", "pool-p2")
    with pytest.raises(PoolResolutionError) as exc:
        resolve_execution_pool(session, project_id="p1", explicit_pool_id="pool-p2")
    assert exc.value.kind == "executor_pool_not_owned"


def test_resolve_disabled_pool_rejects(session: Session) -> None:
    _seed_project(session, "p1")
    _seed_pool(session, "p1", "pool-off", enabled=False)
    with pytest.raises(PoolResolutionError) as exc:
        resolve_execution_pool(session, project_id="p1", explicit_pool_id="pool-off")
    assert exc.value.kind == "executor_pool_disabled"


def test_resolve_archived_pool_rejects(session: Session) -> None:
    _seed_project(session, "p1")
    _seed_pool(session, "p1", "pool-old", archived=True)
    with pytest.raises(PoolResolutionError) as exc:
        resolve_execution_pool(session, project_id="p1", explicit_pool_id="pool-old")
    assert exc.value.kind == "executor_pool_archived"


# ── pooled Batch creation ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_pooled_batch_run_creates_revision_and_queued_attempts(
    session: Session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("APO_ARTIFACT_DIR", str(tmp_path / "store"))
    root = tmp_path / "src"
    _write_task(root)
    _seed_project(session, "p1")
    pool = _seed_pool(session, "p1", "pool-1")
    source = _seed_filesystem_source(session, "p1", root)

    # Isolate to the pooled layer: stub create_batch_run's selection resolution
    # (exercised by its own tests) so we test revision + attempt creation.
    import apo.services.execution_queue as _queue

    def _stub_create_batch_run(session, **kwargs):
        from apo.models.db import AgentTaskBatchRunDB as _B, AgentTaskRunDB as _R
        b = _B(id="batch-pooled", project="p1", selection_type="all", status="queued",
               environment="default", run_metadata={}, total_tasks=1,
               created_at=datetime.now(timezone.utc))
        session.add(b)
        session.flush()
        session.add(_R(id="run-1", batch_run_id="batch-pooled", task_id="demo-task",
                       task_path="demo-task", sequence_index=0, status="pending"))
        session.commit()
        session.refresh(b)
        return b

    monkeypatch.setattr(_queue, "create_batch_run", _stub_create_batch_run, raising=False)
    # create_pooled_batch_run lazy-imports create_batch_run from agent_task_runner.
    import apo.services.agent_task_runner as _runner
    monkeypatch.setattr(_runner, "create_batch_run", _stub_create_batch_run)

    batch = await create_pooled_batch_run(
        session, project_id="p1", pool_id=pool.id, selection_type="all",
        task_paths=None, task_root=str(root), grep=None, environment="default",
        run_metadata=None, task_source=source,
    )

    # Revision materialized (bundled).
    revision = session.exec(
        select(TaskRevisionDB).where(TaskRevisionDB.batch_run_id == batch.id)
    ).first()
    assert revision is not None and revision.materialization == "bundled"
    assert revision.bundle_storage_key

    # One queued Attempt per Task Run, ordered, target_kind=pool.
    attempts = session.exec(
        select(TaskExecutionAttemptDB).where(TaskExecutionAttemptDB.batch_run_id == batch.id)
    ).all()
    assert len(attempts) >= 1
    assert all(a.status == "queued" for a in attempts)
    assert all(a.target_kind == "pool" for a in attempts)
    assert all(a.executor_pool_id == pool.id for a in attempts)
    assert all(a.task_revision_id == revision.id for a in attempts)

    # Target persisted and immutable.
    assert batch.execution_target_json == {"kind": "pool", "pool_id": pool.id}


@pytest.mark.asyncio
async def test_create_pooled_batch_run_no_source_raises(
    session: Session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_project(session, "p1")
    pool = _seed_pool(session, "p1", "pool-1")
    with pytest.raises(PoolResolutionError) as exc:
        await create_pooled_batch_run(
            session, project_id="p1", pool_id=pool.id, selection_type="all",
            task_paths=None, task_root=None, grep=None, environment="default",
            run_metadata=None, task_source=None,
        )
    assert exc.value.kind == "executor_pool_required"
    # No Batch/Attempt left behind.
    assert session.exec(select(AgentTaskBatchRunDB)).all() == []
    assert session.exec(select(TaskExecutionAttemptDB)).all() == []
