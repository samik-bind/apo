# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false
# pyright: reportAttributeAccessIssue=false, reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false

"""SPEC-163 scene: the registered scheduler path delivers source-owned work.

Covers backend scene test 2: ``run_due_schedules_once`` against the test
engine creates one Occurrence, one source-owned Batch, ordered Attempts,
a next UTC run time, and owner routing.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import Session, SQLModel, create_engine, select
from sqlalchemy.pool import StaticPool

from apo.models.db import (
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    AgentTaskScheduleOccurrenceDB,
    ProjectDB,
    ProjectMembershipDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
    TaskExecutionAttemptDB,
    UserDB,
)

_PROJECT = "acme-evals"


def _now() -> datetime:
    return datetime.now(timezone.utc)


@pytest.fixture
def bound_engine(monkeypatch):
    """Create an isolated engine and bind the scheduler module to it."""
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    import apo.services.agent_task_scheduler as sched

    monkeypatch.setattr(sched, "engine", engine)
    return engine, sched


def _seed_source_owned_schedule(engine) -> str:
    with Session(engine) as session:
        owner = UserDB(email="owner@test.com", name="Owner", password_hash="x", is_active=True)
        session.add(owner)
        session.commit()
        session.refresh(owner)

        session.add(ProjectDB(id=_PROJECT, name="Acme", created_by=owner.id))
        session.commit()
        now = _now()
        session.add(
            ProjectMembershipDB(
                project_id=_PROJECT, user_id=owner.id, role="admin",
                created_at=now, updated_at=now,
            )
        )
        source = ProjectTaskSourceDB(
            project=_PROJECT, source_type="published",
            catalog_digest="sha256:c", task_count=2, status="ready",
        )
        session.add(source)
        session.commit()
        session.refresh(source)
        for tid in ("support/refund", "support/cancel"):
            display = tid.split("/")[-1]
            session.add(
                ProjectTaskInventoryDB(
                    project=_PROJECT, task_source_id=source.id, task_id=tid,
                    task_inventory_id=tid, display_name=display, adapter_name="cc",
                    folder_path="support", task_path=f"tasks/{tid}", source_type="published",
                )
            )
        schedule = AgentTaskScheduleDB(
            id="sched-1", project=_PROJECT, name="Nightly",
            selection_type="tasks",
            selection_query={"kind": "tasks", "task_ids": ["support/refund", "support/cancel"]},
            environment="default", cadence_type="daily", timezone="UTC",
            hour=9, minute=0, next_run_at=now - timedelta(minutes=5),
            execution_kind="source_owned", execution_owner_user_id=owner.id,
        )
        session.add(schedule)
        session.commit()
        return owner.id


def test_run_due_schedules_once_creates_occurrence_and_source_owned_batch(bound_engine):
    engine, sched = bound_engine
    owner_id = _seed_source_owned_schedule(engine)

    created = sched.run_due_schedules_once()

    assert created == 1
    with Session(engine) as session:
        occs = list(
            session.exec(
                select(AgentTaskScheduleOccurrenceDB).where(
                    AgentTaskScheduleOccurrenceDB.schedule_id == "sched-1"
                )
            ).all()
        )
        assert len(occs) == 1
        assert occs[0].status == "pending"
        assert occs[0].kind == "scheduled"
        assert occs[0].batch_run_id is not None

        from apo.models.db import AgentTaskBatchRunDB

        batch = session.get(AgentTaskBatchRunDB, occs[0].batch_run_id)
        assert batch.execution_target_json == {"kind": "source_owned"}
        assert batch.requested_by_user_id == owner_id
        runs = list(
            session.exec(
                select(AgentTaskRunDB).where(AgentTaskRunDB.batch_run_id == batch.id)
            ).all()
        )
        assert [r.sequence_index for r in runs] == [0, 1]
        attempts = list(
            session.exec(
                select(TaskExecutionAttemptDB).where(
                    TaskExecutionAttemptDB.batch_run_id == batch.id
                )
            ).all()
        )
        assert all(a.target_user_id == owner_id for a in attempts)
        assert all(a.assignment_kind == "source_owned" for a in attempts)

        schedule = session.get(AgentTaskScheduleDB, "sched-1")
        assert schedule.active_batch_run_id == batch.id
        assert schedule.next_run_at is not None
        # next_run_at round-trips through SQLite naive (UTC implied); compare
        # as UTC so the next cadence is provably in the future.
        next_run = schedule.next_run_at
        if next_run.tzinfo is None:
            next_run = next_run.replace(tzinfo=timezone.utc)
        assert next_run > _now()


def test_run_due_schedules_once_is_idempotent_across_duplicate_polls(bound_engine):
    engine, sched = bound_engine
    _seed_source_owned_schedule(engine)

    sched.run_due_schedules_once()
    # Re-running before the cadence advanced past the next poll window: the
    # Schedule is no longer due (next_run_at is now future), so no second Batch.
    second = sched.run_due_schedules_once()

    assert second == 0
    with Session(engine) as session:
        occs = list(
            session.exec(select(AgentTaskScheduleOccurrenceDB)).all()
        )
        assert len(occs) == 1
