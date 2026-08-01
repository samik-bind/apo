# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportReturnType=false, reportCallIssue=false

"""Retention covers Deliverable objects, not just rows.

Deleting a Task Run must remove its external objects idempotently BEFORE the
database rows, and a store failure must retain the rows for the next cleanup
(so objects are never orphaned by deleting the manifest first). Expired
pending uploads are failed and their staging bytes removed.
"""

from __future__ import annotations

import asyncio
import hashlib
from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import Session, select, text
from apo.db import engine, reset_apo_file_db
from apo.models.db import AgentTaskBatchRunDB, AgentTaskDeliverableDB, AgentTaskRunDB
from apo.services.retention import (
    cleanup_expired_artifact_uploads,
    delete_deliverable_objects_for_runs,
)


@pytest.fixture(autouse=True)
def setup_database():
    reset_apo_file_db()
    yield
    with Session(engine) as session:
        session.execute(text("DELETE FROM agent_task_deliverables"))
        session.execute(text("DELETE FROM agent_task_runs"))
        session.execute(text("DELETE FROM agent_task_batch_runs"))
        session.commit()


def _seed_old_run(
    session: Session,
    run_id: str,
    *,
    age_days: int,
    project: str = "p1",
) -> AgentTaskRunDB:
    old = datetime.now(timezone.utc) - timedelta(days=age_days)
    session.add(
        AgentTaskBatchRunDB(
            id=f"batch-{run_id}", project=project, selection_type="manual", status="completed",
            created_at=old,
        )
    )
    run = AgentTaskRunDB(
        id=run_id, batch_run_id=f"batch-{run_id}", task_id="t", task_path="p", status="passed",
    )
    session.add(run)
    session.flush()
    return run


def _add_object_deliverable(
    session: Session, run_id: str, key: str, backend: str = "local"
) -> AgentTaskDeliverableDB:
    row = AgentTaskDeliverableDB(
        id=f"dlv-{key}-{run_id}",
        project="p1",
        task_run_id=run_id,
        name=key,
        kind="artifact",
        status="ready",
        storage_backend=backend,
        storage_key=f"{key[:2]}/{key}",
        media_type="text/plain",
        size_bytes=5,
        stored_size_bytes=5,
        sha256=hashlib.sha256(b"abc").hexdigest(),
        created_at=datetime.now(timezone.utc),
        ready_at=datetime.now(timezone.utc),
    )
    session.add(row)
    session.flush()
    return row


class _RecordingStore:
    name = "local"

    def __init__(self) -> None:
        self.deleted: list[str] = []
        self.fail = False

    async def delete(self, key: str) -> None:
        if self.fail:
            raise OSError("store unavailable")
        self.deleted.append(key)

    async def check_ready(self) -> tuple[bool, str | None]:
        return (not self.fail, "store down" if self.fail else None)


class TestDeliverableObjectRetention:
    def test_deletes_objects_before_rows(self, monkeypatch):
        store = _RecordingStore()
        monkeypatch.setattr(
            "apo.services.retention.get_store",
            lambda backend, **_: store,
        )
        with Session(engine) as session:
            _seed_old_run(session, "run-1", age_days=30)
            _add_object_deliverable(session, "run-1", "aaobject1")
            _add_object_deliverable(session, "run-1", "bbobject2")
            run_ids = ["run-1"]

            asyncio.run(delete_deliverable_objects_for_runs(session, run_ids))

            # Objects deleted.
            assert sorted(store.deleted) == ["aa/aaobject1", "bb/bbobject2"]
            # Rows still present at this point (caller deletes rows after).
            rows = session.exec(
                select(AgentTaskDeliverableDB).where(
                    AgentTaskDeliverableDB.task_run_id == "run-1"
                )
            ).all()
            assert len(rows) == 2

    def test_store_failure_retains_rows_for_retry(self, monkeypatch):
        store = _RecordingStore()
        store.fail = True
        monkeypatch.setattr(
            "apo.services.retention.get_store",
            lambda backend, **_: store,
        )
        with Session(engine) as session:
            _seed_old_run(session, "run-2", age_days=30)
            _add_object_deliverable(session, "run-2", "ccobject3")
            run_ids = ["run-2"]

            with pytest.raises(OSError):
                asyncio.run(delete_deliverable_objects_for_runs(session, run_ids))

            # Rows preserved so the next cleanup retries; no orphan.
            rows = session.exec(
                select(AgentTaskDeliverableDB).where(
                    AgentTaskDeliverableDB.task_run_id == "run-2"
                )
            ).all()
            assert len(rows) == 1

    def test_inline_deliverables_need_no_object_deletion(self, monkeypatch):
        store = _RecordingStore()
        monkeypatch.setattr(
            "apo.services.retention.get_store",
            lambda backend, **_: store,
        )
        with Session(engine) as session:
            _seed_old_run(session, "run-3", age_days=30)
            row = AgentTaskDeliverableDB(
                id="dlv-inline-run-3", project="p1", task_run_id="run-3",
                name="inline", kind="json", status="ready",
                storage_backend=None, storage_key=None,
                inline_value_json={"value": 1}, media_type="application/json",
                size_bytes=10, stored_size_bytes=10,
                sha256="a" * 64, created_at=datetime.now(timezone.utc),
                ready_at=datetime.now(timezone.utc),
            )
            session.add(row)
            session.flush()

            asyncio.run(delete_deliverable_objects_for_runs(session, ["run-3"]))
            assert store.deleted == []


class TestExpiredUploadCleanup:
    def test_expired_pending_upload_is_failed(self, monkeypatch):
        store = _RecordingStore()
        monkeypatch.setattr(
            "apo.services.retention.get_store",
            lambda backend, **_: store,
        )
        with Session(engine) as session:
            _seed_old_run(session, "run-4", age_days=0)
            old = datetime.now(timezone.utc) - timedelta(hours=48)
            row = AgentTaskDeliverableDB(
                id="dlv-pending-run-4", project="p1", task_run_id="run-4",
                name="pending", kind="artifact", status="pending",
                storage_backend="local", storage_key=None,
                media_type="text/plain", size_bytes=5, sha256="a" * 64,
                created_at=old,
            )
            session.add(row)
            session.commit()

            summary = asyncio.run(cleanup_expired_artifact_uploads(session))
            session.commit()

            assert summary["failed_uploads"] >= 1
            refreshed = session.get(AgentTaskDeliverableDB, "dlv-pending-run-4")
            assert refreshed is not None
            assert refreshed.status == "failed"

    def test_recent_pending_upload_is_left_alone(self, monkeypatch):
        store = _RecordingStore()
        monkeypatch.setattr(
            "apo.services.retention.get_store",
            lambda backend, **_: store,
        )
        with Session(engine) as session:
            _seed_old_run(session, "run-5", age_days=0)
            recent = datetime.now(timezone.utc) - timedelta(minutes=5)
            row = AgentTaskDeliverableDB(
                id="dlv-recent-run-5", project="p1", task_run_id="run-5",
                name="recent", kind="artifact", status="pending",
                storage_backend="local", storage_key=None,
                media_type="text/plain", size_bytes=5, sha256="b" * 64,
                created_at=recent,
            )
            session.add(row)
            session.commit()

            asyncio.run(cleanup_expired_artifact_uploads(session))
            session.commit()

            refreshed = session.get(AgentTaskDeliverableDB, "dlv-recent-run-5")
            assert refreshed is not None
            assert refreshed.status == "pending"
