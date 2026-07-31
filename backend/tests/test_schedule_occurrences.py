# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false
# pyright: reportAttributeAccessIssue=false, reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false

"""SPEC-163: idempotent Schedule Occurrence delivery for source-owned schedules.

Covers the core scheduler dispatch contract:
- 3. Offline ownership still creates one durable Batch.
- 4. One active Batch prevents backlog (later due times are missed).
- 5. Duplicate polls are idempotent (unique Occurrence + Batch).
- 11. Folder and All selections resolve the current catalog.
- 12. Empty dynamic selection pauses safely (missed selection_empty).
- 10. Exact selection pauses after catalog removal.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import Session, SQLModel, create_engine, select
from sqlalchemy.pool import StaticPool

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskScheduleDB,
    AgentTaskScheduleOccurrenceDB,
    ProjectDB,
    ProjectMembershipDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
    TaskExecutionAttemptDB,
    UserDB,
)
from apo.services.source_owned_executor import ensure_source_owned_pool  # noqa: F401

_PROJECT = "acme-evals"
_QUEUE_DEADLINE_SECONDS = 24 * 60 * 60


def _now() -> datetime:
    return datetime.now(timezone.utc)


@pytest.fixture
def session():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


@pytest.fixture
def owner_and_schedule(session):
    """Create a project, an admin owner, and a due source-owned exact-tasks schedule."""
    owner = UserDB(email="owner@test.com", name="Owner", password_hash="x", is_active=True)
    session.add(owner)
    session.commit()
    session.refresh(owner)

    project = ProjectDB(id=_PROJECT, name="Acme", created_by=owner.id)
    session.add(project)
    session.commit()

    now = _now()
    session.add(
        ProjectMembershipDB(
            project_id=_PROJECT, user_id=owner.id, role="admin",
            created_at=now, updated_at=now,
        )
    )
    session.commit()
    _publish_catalog(session, tasks=["support/refund", "support/cancel"])
    schedule = _make_schedule(session, owner_id=owner.id, selection=_exact(["support/refund", "support/cancel"]))
    return owner, schedule


def _publish_catalog(session, *, tasks: list[str], digest: str = "sha256:catalog") -> None:
    existing = session.exec(
        select(ProjectTaskSourceDB).where(ProjectTaskSourceDB.project == _PROJECT)
    ).first()
    if existing is None:
        source = ProjectTaskSourceDB(
            project=_PROJECT, source_type="published",
            catalog_digest=digest, task_count=len(tasks), status="ready",
        )
        session.add(source)
    else:
        source = existing
        source.source_type = "published"
        source.catalog_digest = digest
        source.task_count = len(tasks)
        source.status = "ready"
        session.add(source)
    session.commit()
    session.refresh(source)
    # Replace inventory rows for this source.
    for r in session.exec(
        select(ProjectTaskInventoryDB).where(ProjectTaskInventoryDB.task_source_id == source.id)
    ).all():
        session.delete(r)
    for task_id in tasks:
        display = task_id.split("/")[-1]
        folder = task_id.rsplit("/", 1)[0] if "/" in task_id else ""
        session.add(
            ProjectTaskInventoryDB(
                project=_PROJECT, task_source_id=source.id, task_id=task_id,
                task_inventory_id=task_id, display_name=display, adapter_name="cc",
                folder_path=folder, task_path=f"tasks/{task_id}", source_type="published",
            )
        )
    session.commit()


def _exact(task_ids: list[str]) -> dict[str, object]:
    return {"kind": "tasks", "task_ids": task_ids}


def _make_schedule(
    session,
    *,
    owner_id: str,
    selection: dict[str, object],
    cadence_type: str = "daily",
    enabled: bool = True,
    next_run_at: datetime | None = None,
    id_override: str = "sched-1",
) -> AgentTaskScheduleDB:
    schedule = AgentTaskScheduleDB(
        id=id_override,
        project=_PROJECT,
        name="Nightly",
        selection_type="tasks",
        selection_query=selection,
        environment="default",
        cadence_type=cadence_type,
        timezone="UTC",
        hour=9,
        minute=0,
        enabled=enabled,
        next_run_at=next_run_at or _now() - timedelta(minutes=5),
        execution_kind="source_owned",
        execution_owner_user_id=owner_id,
    )
    session.add(schedule)
    session.commit()
    session.refresh(schedule)
    return schedule


def _occurrences(session, schedule_id: str = "sched-1") -> list[AgentTaskScheduleOccurrenceDB]:
    return list(
        session.exec(
            select(AgentTaskScheduleOccurrenceDB)
            .where(AgentTaskScheduleOccurrenceDB.schedule_id == schedule_id)
            .order_by(AgentTaskScheduleOccurrenceDB.scheduled_for)
        ).all()
    )


def _batches(session) -> list[AgentTaskBatchRunDB]:
    return list(session.exec(select(AgentTaskBatchRunDB)).all())


class TestDispatchCreatesOneOccurrence:
    """Acceptance tests 3, 5."""

    def test_offline_owner_creates_one_pending_occurrence_and_batch(self, session, owner_and_schedule):
        from apo.services.schedule_occurrences import deliver_due_occurrence

        owner, schedule = owner_and_schedule
        # No connected executor enrolled — owner is offline.

        result = deliver_due_occurrence(session, schedule=schedule, now=_now())

        assert result.created is True
        occs = _occurrences(session)
        assert len(occs) == 1
        assert occs[0].status == "pending"
        assert occs[0].kind == "scheduled"
        assert occs[0].batch_run_id is not None
        # The Batch is source-owned, queued, owner-routed, with a 24h deadline.
        batch = session.get(AgentTaskBatchRunDB, occs[0].batch_run_id)
        assert batch.execution_target_json == {"kind": "source_owned"}
        assert batch.requested_by_user_id == owner.id
        attempts = session.exec(
            select(TaskExecutionAttemptDB).where(TaskExecutionAttemptDB.batch_run_id == batch.id)
        ).all()
        assert all(a.assignment_kind == "source_owned" for a in attempts)
        assert all(a.target_user_id == owner.id for a in attempts)
        # Schedule stays enabled and the active pointer is set.
        session.refresh(schedule)
        assert schedule.enabled is True
        assert schedule.active_batch_run_id == batch.id

    def test_duplicate_poll_is_idempotent(self, session, owner_and_schedule):
        from apo.services.schedule_occurrences import deliver_due_occurrence

        _, schedule = owner_and_schedule
        scheduled_for = schedule.next_run_at or _now()

        first = deliver_due_occurrence(session, schedule=schedule, now=_now())
        second = deliver_due_occurrence(session, schedule=schedule, now=_now())

        assert first.created is True
        # Same scheduled_for → same Occurrence, no duplicate Batch.
        assert second.created is False
        assert second.occurrence_id == first.occurrence_id
        assert second.batch_run_id == first.batch_run_id
        assert len(_occurrences(session)) == 1
        assert len(_batches(session)) == 1


class TestOneActiveBatchPreventsBacklog:
    """Acceptance test 4."""

    def test_later_due_time_while_active_is_missed(self, session, owner_and_schedule):
        from apo.services.schedule_occurrences import deliver_due_occurrence

        _, schedule = owner_and_schedule
        first = deliver_due_occurrence(session, schedule=schedule, now=_now())
        assert first.created is True

        # A later due time arrives while the first Batch is still active.
        later = _now() + timedelta(hours=12)
        schedule.next_run_at = later
        session.add(schedule)
        session.commit()

        second = deliver_due_occurrence(session, schedule=schedule, now=later)

        assert second.created is False
        assert len(_batches(session)) == 1  # no backlog
        occs = _occurrences(session)
        assert len(occs) == 2
        missed = [o for o in occs if o.status == "missed"]
        assert len(missed) == 1
        assert missed[0].missed_reason == "previous_occurrence_active"
        assert missed[0].batch_run_id is None


class TestSelectionResolution:
    """Acceptance tests 11, 12."""

    def test_folder_selection_resolves_current_catalog(self, session, owner_and_schedule):
        from apo.services.schedule_occurrences import deliver_due_occurrence

        owner, _ = owner_and_schedule
        schedule = _make_schedule(
            session, owner_id=owner.id, selection={"kind": "folder", "folder_id": "support"},
            id_override="sched-folder",
        )

        result = deliver_due_occurrence(session, schedule=schedule, now=_now())

        assert result.created is True
        batch = session.get(AgentTaskBatchRunDB, result.batch_run_id)
        # Both support/* tasks resolved.
        from apo.models.db import AgentTaskRunDB
        runs = session.exec(
            select(AgentTaskRunDB).where(AgentTaskRunDB.batch_run_id == batch.id)
        ).all()
        assert sorted(r.task_id for r in runs) == ["support/cancel", "support/refund"]

    def test_all_selection_resolves_full_catalog(self, session, owner_and_schedule):
        from apo.services.schedule_occurrences import deliver_due_occurrence

        owner, _ = owner_and_schedule
        schedule = _make_schedule(
            session, owner_id=owner.id, selection={"kind": "all"}, id_override="sched-all",
        )

        result = deliver_due_occurrence(session, schedule=schedule, now=_now())

        assert result.created is True
        from apo.models.db import AgentTaskRunDB
        batch = session.get(AgentTaskBatchRunDB, result.batch_run_id)
        runs = session.exec(
            select(AgentTaskRunDB).where(AgentTaskRunDB.batch_run_id == batch.id)
        ).all()
        assert len(runs) == 2

    def test_empty_folder_selection_misses_and_pauses(self, session, owner_and_schedule):
        from apo.services.schedule_occurrences import deliver_due_occurrence

        owner, _ = owner_and_schedule
        schedule = _make_schedule(
            session, owner_id=owner.id,
            selection={"kind": "folder", "folder_id": "nonexistent"},
            id_override="sched-empty",
        )

        result = deliver_due_occurrence(session, schedule=schedule, now=_now())

        assert result.created is False
        occs = _occurrences(session, schedule_id="sched-empty")
        assert len(occs) == 1
        assert occs[0].status == "missed"
        assert occs[0].missed_reason == "selection_empty"
        assert occs[0].batch_run_id is None
        session.refresh(schedule)
        assert schedule.enabled is False
        assert schedule.disabled_reason == "selection_empty"


class TestExactSelectionPause:
    """Acceptance test 10."""

    def test_removed_task_pauses_schedule(self, session, owner_and_schedule):
        from apo.services.schedule_occurrences import deliver_due_occurrence

        owner, _ = owner_and_schedule
        # Republish without 'support/cancel'.
        _purge_inventory(session)
        _publish_catalog(session, tasks=["support/refund"], digest="sha256:changed")

        schedule = _make_schedule(
            session, owner_id=owner.id,
            selection=_exact(["support/refund", "support/cancel"]),
            id_override="sched-exact",
        )

        result = deliver_due_occurrence(session, schedule=schedule, now=_now())

        assert result.created is False
        session.refresh(schedule)
        assert schedule.enabled is False
        assert schedule.disabled_reason == "catalog_changed"


# --- helpers ----------------------------------------------------------------


def _purge_inventory(session) -> None:
    rows = session.exec(select(ProjectTaskInventoryDB).where(ProjectTaskInventoryDB.project == _PROJECT)).all()
    for r in rows:
        session.delete(r)
    session.commit()
