# pyright: reportAny=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportUnusedParameter=false

"""DELETE /v1/agent-task-runs/{id} and /v1/agent-task-batch-runs/{id}.

Run deletion is destructive history rewrite (admin-only, terminal runs
only). These tests build a Batch with one row in every run-dependent
table — check report, judgment, correction, Deliverables (object and
inline), attempt, and the full trace projection — delete via the API,
and assert nothing is left behind while sibling data survives. A future
table that isn't covered by the cascade gets caught here.
"""

import hashlib
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskCheckReportDB,
    AgentTaskDeliverableDB,
    AgentTaskJudgmentDB,
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    AgentTaskScheduleOccurrenceDB,
    AgentTaskTestResultCorrectionDB,
    CallMetricDB,
    LoggedCallDB,
    OtlpIngestBatchDB,
    OtlpSpanDB,
    ProjectDB,
    ProjectMembershipDB,
    RunDB,
    RunMetricDB,
    TaskExecutionAttemptDB,
    TaskRevisionDB,
    UserDB,
)
from apo.services.project_memberships import create_owner_membership


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_user(session: Session, email: str) -> UserDB:
    user = UserDB(email=email, name=email, password_hash="x", is_active=True)
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _make_project(session: Session, owner: UserDB, slug: str) -> ProjectDB:
    project = ProjectDB(id=slug, name=slug, created_by=owner.id)
    session.add(project)
    session.commit()
    session.refresh(project)
    create_owner_membership(session, project.id, owner.id)
    return project


def _make_member(session: Session, project_id: str, email: str) -> UserDB:
    user = _make_user(session, email)
    now = datetime.now(timezone.utc)
    session.add(
        ProjectMembershipDB(
            project_id=project_id, user_id=user.id, role="member",
            created_at=now, updated_at=now,
        )
    )
    session.commit()
    return user


def _seed_batch(
    session: Session,
    project_id: str,
    batch_id: str,
    *,
    status: str = "completed",
) -> AgentTaskBatchRunDB:
    batch = AgentTaskBatchRunDB(
        id=batch_id,
        project=project_id,
        selection_type="task",
        task_root="/tmp/tasks",
        environment="default",
        status=status,
        created_at=datetime.now(timezone.utc),
    )
    session.add(batch)
    session.commit()
    return batch


def _seed_run(
    session: Session,
    batch_id: str,
    run_id: str,
    *,
    status: str = "passed",
    trace_run_id: str | None = None,
    sequence_index: int = 0,
    total_checks: int = 0,
) -> AgentTaskRunDB:
    run = AgentTaskRunDB(
        id=run_id,
        batch_run_id=batch_id,
        task_id=run_id,
        task_path=f"/tmp/tasks/{run_id}",
        sequence_index=sequence_index,
        status=status,
        pass_result=status == "passed",
        trace_run_id=trace_run_id,
        total_checks=total_checks,
        passed_checks=total_checks if status == "passed" else 0,
        started_at=datetime.now(timezone.utc),
        completed_at=datetime.now(timezone.utc),
    )
    session.add(run)
    session.commit()
    return run


def _seed_run_dependencies(
    session: Session,
    project_id: str,
    batch_id: str,
    run_id: str,
    *,
    trace_id: str,
    object_key: str,
) -> None:
    """Insert one row in every run-dependent table, in FK-safe order."""
    now = datetime.now(timezone.utc)
    digest = hashlib.sha256(b"abc").hexdigest()

    session.add(
        AgentTaskCheckReportDB(run_id=run_id, value_json=[], created_at=now)
    )
    session.add(
        AgentTaskJudgmentDB(
            task_run_id=run_id, project=project_id, pass_result=True, created_at=now
        )
    )
    session.add(
        AgentTaskTestResultCorrectionDB(
            task_run_id=run_id,
            project=project_id,
            test_id="report-is-complete",
            action="set_pass",
        )
    )
    session.add(
        AgentTaskDeliverableDB(
            id=f"dlv-obj-{run_id}",
            project=project_id,
            task_run_id=run_id,
            name="artifact.txt",
            kind="artifact",
            status="ready",
            storage_backend="local",
            storage_key=object_key,
            media_type="text/plain",
            size_bytes=3,
            stored_size_bytes=3,
            sha256=digest,
            created_at=now,
            ready_at=now,
        )
    )
    session.add(
        AgentTaskDeliverableDB(
            id=f"dlv-json-{run_id}",
            project=project_id,
            task_run_id=run_id,
            name="summary",
            kind="json",
            status="ready",
            inline_value_json={"ok": True},
            media_type="application/json",
            size_bytes=12,
            sha256=digest,
            created_at=now,
            ready_at=now,
        )
    )
    session.add(
        TaskExecutionAttemptDB(
            project=project_id,
            batch_run_id=batch_id,
            task_run_id=run_id,
            sequence_index=0,
            target_kind="pool",
            queue_expires_at=now + timedelta(hours=1),
            status="completed",
        )
    )

    # Trace projection: RunDB + one call with metrics, spans, and the
    # durable OTLP inbox row softly referencing the run.
    session.add(
        RunDB(
            id=trace_id,
            project=project_id,
            task_run_id=run_id,
            created_at=now,
        )
    )
    session.add(
        LoggedCallDB(
            id=f"{trace_id}-tool",
            run_id=trace_id,
            project=project_id,
            task_id="",
            created_at=now,
            model="unknown",
            observation_type="TOOL",
            latency_ms=5.0,
            input={},
            output={},
            messages=[],
        )
    )
    session.add(
        RunMetricDB(
            run_id=trace_id, project=project_id,
            metric_name="total_cost", metric_type="aggregate",
        )
    )
    session.add(
        CallMetricDB(
            call_id=f"{trace_id}-tool", project=project_id,
            metric_name="latency", metric_type="aggregate",
        )
    )
    session.add(
        OtlpSpanDB(
            project_id=project_id, trace_id=trace_id, span_id=f"{trace_id}-tool"
        )
    )
    session.add(
        OtlpIngestBatchDB(
            id=f"ingest-{run_id}",
            project_id=project_id,
            payload="{}",
            verified_task_run_id=run_id,
        )
    )
    session.commit()


class _RecordingStore:
    name: str = "local"

    def __init__(self) -> None:
        self.deleted: list[str] = []
        self.fail: bool = False

    async def delete(self, key: str) -> None:
        if self.fail:
            raise OSError("store unavailable")
        self.deleted.append(key)

    async def check_ready(self) -> tuple[bool, str | None]:
        return (not self.fail, "store down" if self.fail else None)


def _patch_store(monkeypatch: Any, store: _RecordingStore) -> None:
    def _get_store(backend: str, **_: object) -> _RecordingStore:
        return store

    monkeypatch.setattr("apo.services.retention.get_store", _get_store)


# ---------------------------------------------------------------------------
# Task run deletion
# ---------------------------------------------------------------------------


def test_delete_task_run_cascades_everything(
    client: TestClient, session: Session, monkeypatch: Any
) -> None:
    owner = _make_user(session, "owner@t.dev")
    _make_project(session, owner, "p1")
    batch = _seed_batch(session, "p1", "b1")
    # three runs: two passed, one failed — deleting the failed one must
    # recompute the batch rollups from the survivors.
    _seed_run(session, "b1", "r-pass-1", status="passed", total_checks=2)
    _seed_run(session, "b1", "r-pass-2", status="passed", total_checks=2)
    failed = _seed_run(session, "b1", "r-fail", status="failed", total_checks=3)
    batch.total_tasks = 3
    batch.passed_tasks = 2
    batch.failed_tasks = 1
    batch.total_checks = 7
    batch.passed_checks = 4
    session.add(batch)
    _seed_run_dependencies(
        session, "p1", "b1", "r-fail", trace_id="tracefail", object_key="ff/failobj"
    )
    _seed_run_dependencies(
        session, "p1", "b1", "r-pass-1", trace_id="traceone", object_key="aa/oneobj"
    )

    store = _RecordingStore()
    _patch_store(monkeypatch, store)

    resp = client.delete(f"/v1/agent-task-runs/{failed.id}")
    assert resp.status_code == 200
    # The route commits on its own session; drop our stale identity map.
    session.expire_all()
    body = resp.json()
    assert body["ok"] is True
    assert body["deleted_runs"] == 1
    assert body["deleted_traces"] == 1
    assert body["deleted_batches"] == 0

    # Only the failed run's artifact object went; the survivor's stays.
    assert store.deleted == ["ff/failobj"]

    # Every dependent row for the deleted run is gone.
    assert session.get(AgentTaskRunDB, "r-fail") is None
    assert session.get(AgentTaskCheckReportDB, "r-fail") is None
    assert (
        session.exec(
            select(AgentTaskJudgmentDB).where(AgentTaskJudgmentDB.task_run_id == "r-fail")
        ).first()
        is None
    )
    assert (
        session.exec(
            select(AgentTaskTestResultCorrectionDB).where(
                AgentTaskTestResultCorrectionDB.task_run_id == "r-fail"
            )
        ).first()
        is None
    )
    assert (
        session.exec(
            select(AgentTaskDeliverableDB).where(
                AgentTaskDeliverableDB.task_run_id == "r-fail"
            )
        ).all()
        == []
    )
    assert (
        session.exec(
            select(TaskExecutionAttemptDB).where(
                TaskExecutionAttemptDB.task_run_id == "r-fail"
            )
        ).first()
        is None
    )

    # The trace projection is gone, scoped to the deleted run only.
    assert (
        session.exec(
            select(RunDB).where(RunDB.id == "tracefail", RunDB.project == "p1")
        ).first()
        is None
    )
    assert (
        session.exec(
            select(LoggedCallDB).where(LoggedCallDB.run_id == "tracefail")
        ).first()
        is None
    )
    assert (
        session.exec(
            select(RunMetricDB).where(RunMetricDB.run_id == "tracefail")
        ).first()
        is None
    )
    assert (
        session.exec(
            select(CallMetricDB).where(CallMetricDB.call_id == "tracefail-tool")
        ).first()
        is None
    )
    assert (
        session.exec(
            select(OtlpSpanDB).where(OtlpSpanDB.trace_id == "tracefail")
        ).first()
        is None
    )
    # The soft OTLP inbox reference was cleared, not deleted.
    inbox = session.get(OtlpIngestBatchDB, "ingest-r-fail")
    assert inbox is not None and inbox.verified_task_run_id is None

    # Sibling run and its rows survive untouched.
    assert session.get(AgentTaskRunDB, "r-pass-1") is not None
    assert (
        session.exec(
            select(RunDB).where(RunDB.id == "traceone", RunDB.project == "p1")
        ).first()
        is not None
    )

    # The batch stayed and its rollups were recomputed from survivors.
    survived = session.get(AgentTaskBatchRunDB, "b1")
    assert survived is not None
    assert survived.total_tasks == 2
    assert survived.passed_tasks == 2
    assert survived.failed_tasks == 0
    assert survived.total_checks == 4


def test_delete_last_task_run_removes_empty_batch(
    client: TestClient, session: Session
) -> None:
    owner = _make_user(session, "owner@t.dev")
    _make_project(session, owner, "p2")
    _seed_batch(session, "p2", "b2")
    run = _seed_run(session, "b2", "r-only")
    now = datetime.now(timezone.utc)
    session.add(
        TaskRevisionDB(
            project="p2",
            batch_run_id="b2",
            materialization="attested",
            source_type="caller_worktree",
            content_sha256="a" * 64,
            file_count=1,
            uncompressed_size_bytes=10,
            manifest_summary_json={},
        )
    )
    session.add(
        AgentTaskScheduleDB(
            id="sched-2",
            project="p2",
            name="daily",
            selection_type="task",
            cadence_type="daily",
            active_batch_run_id="b2",
            last_batch_run_id="b2",
        )
    )
    session.add(
        AgentTaskScheduleOccurrenceDB(
            id="occ-2",
            project="p2",
            schedule_id="sched-2",
            schedule_name="daily",
            kind="scheduled",
            scheduled_for=now,
            status="delivered",
            batch_run_id="b2",
        )
    )
    session.commit()

    resp = client.delete(f"/v1/agent-task-runs/{run.id}")
    assert resp.status_code == 200
    # The route commits on its own session; drop our stale identity map.
    session.expire_all()
    assert resp.json()["deleted_batches"] == 1

    assert session.get(AgentTaskBatchRunDB, "b2") is None
    assert (
        session.exec(
            select(TaskRevisionDB).where(TaskRevisionDB.batch_run_id == "b2")
        ).first()
        is None
    )
    schedule = session.get(AgentTaskScheduleDB, "sched-2")
    assert schedule is not None
    assert schedule.active_batch_run_id is None
    assert schedule.last_batch_run_id is None
    occurrence = session.get(AgentTaskScheduleOccurrenceDB, "occ-2")
    assert occurrence is not None and occurrence.batch_run_id is None


def test_delete_task_run_requires_admin_role(
    client: TestClient, session: Session, make_authed_client: Any
) -> None:
    owner = _make_user(session, "owner@t.dev")
    _make_project(session, owner, "p3")
    member = _make_member(session, "p3", "member@t.dev")
    stranger = _make_user(session, "stranger@t.dev")
    _seed_batch(session, "p3", "b3")
    run = _seed_run(session, "b3", "r-3")

    member_client = make_authed_client(member.id, session)
    resp = member_client.delete(f"/v1/agent-task-runs/{run.id}")
    assert resp.status_code == 403

    stranger_client = make_authed_client(stranger.id, session)
    resp = stranger_client.delete(f"/v1/agent-task-runs/{run.id}")
    assert resp.status_code == 403

    assert session.get(AgentTaskRunDB, "r-3") is not None


def test_delete_task_run_not_found(client: TestClient) -> None:
    resp = client.delete("/v1/agent-task-runs/nope")
    assert resp.status_code == 404


def test_delete_task_run_conflict_while_running(
    client: TestClient, session: Session
) -> None:
    owner = _make_user(session, "owner@t.dev")
    _make_project(session, owner, "p4")
    _seed_batch(session, "p4", "b4", status="running")
    run = _seed_run(session, "b4", "r-live", status="running")

    resp = client.delete(f"/v1/agent-task-runs/{run.id}")
    assert resp.status_code == 409
    assert session.get(AgentTaskRunDB, "r-live") is not None


def test_delete_cancelled_task_run_is_allowed(
    client: TestClient, session: Session
) -> None:
    owner = _make_user(session, "owner@t.dev")
    _make_project(session, owner, "p5")
    _seed_batch(session, "p5", "b5", status="cancelled")
    run = _seed_run(session, "b5", "r-cancelled", status="cancelled")

    resp = client.delete(f"/v1/agent-task-runs/{run.id}")
    assert resp.status_code == 200
    # The route commits on its own session; drop our stale identity map.
    session.expire_all()
    assert session.get(AgentTaskRunDB, "r-cancelled") is None


def test_delete_task_run_demo_rejected(
    client: TestClient, session: Session
) -> None:
    owner = _make_user(session, "owner@t.dev")
    _make_project(session, owner, "demo")
    _seed_batch(session, "demo", "b-demo")
    run = _seed_run(session, "b-demo", "r-demo")

    resp = client.delete(f"/v1/agent-task-runs/{run.id}")
    assert resp.status_code == 403
    assert session.get(AgentTaskRunDB, "r-demo") is not None


def test_store_failure_keeps_rows_for_retry(
    client: TestClient, session: Session, monkeypatch: Any
) -> None:
    owner = _make_user(session, "owner@t.dev")
    _make_project(session, owner, "p6")
    _seed_batch(session, "p6", "b6")
    run = _seed_run(session, "b6", "r-6")
    _seed_run_dependencies(
        session, "p6", "b6", "r-6", trace_id="trace6", object_key="66/obj6"
    )

    store = _RecordingStore()
    store.fail = True
    _patch_store(monkeypatch, store)

    resp = client.delete(f"/v1/agent-task-runs/{run.id}")
    assert resp.status_code == 503
    # Rows survive so deletion can be retried; no orphaned objects.
    assert session.get(AgentTaskRunDB, "r-6") is not None
    assert (
        session.exec(
            select(AgentTaskDeliverableDB).where(
                AgentTaskDeliverableDB.task_run_id == "r-6"
            )
        ).first()
        is not None
    )


# ---------------------------------------------------------------------------
# Batch run deletion
# ---------------------------------------------------------------------------


def test_delete_batch_run_cascades_everything(
    client: TestClient, session: Session, monkeypatch: Any
) -> None:
    owner = _make_user(session, "owner@t.dev")
    _make_project(session, owner, "p7")
    _seed_batch(session, "p7", "b7")
    _seed_run(session, "b7", "r-7a", trace_run_id="trace7a")
    _seed_run(session, "b7", "r-7b", trace_run_id="trace7b")
    _seed_run_dependencies(
        session, "p7", "b7", "r-7a", trace_id="trace7a", object_key="77/obja"
    )
    _seed_run_dependencies(
        session, "p7", "b7", "r-7b", trace_id="trace7b", object_key="77/objb"
    )
    session.add(
        TaskRevisionDB(
            project="p7",
            batch_run_id="b7",
            materialization="attested",
            source_type="caller_worktree",
            content_sha256="b" * 64,
            file_count=1,
            uncompressed_size_bytes=10,
            manifest_summary_json={},
        )
    )
    session.add(
        AgentTaskScheduleDB(
            id="sched-7",
            project="p7",
            name="weekly",
            selection_type="task",
            cadence_type="weekly",
            last_batch_run_id="b7",
        )
    )
    session.commit()

    store = _RecordingStore()
    _patch_store(monkeypatch, store)

    resp = client.delete("/v1/agent-task-batch-runs/b7")
    assert resp.status_code == 200
    session.expire_all()
    body = resp.json()
    assert body["ok"] is True
    assert body["deleted_runs"] == 2
    assert body["deleted_traces"] == 2
    assert body["deleted_batches"] == 1

    assert sorted(store.deleted) == ["77/obja", "77/objb"]
    assert session.get(AgentTaskBatchRunDB, "b7") is None
    assert (
        session.exec(select(AgentTaskRunDB).where(AgentTaskRunDB.batch_run_id == "b7")).all()
        == []
    )
    assert (
        session.exec(
            select(TaskExecutionAttemptDB).where(TaskExecutionAttemptDB.batch_run_id == "b7")
        ).all()
        == []
    )
    assert (
        session.exec(
            select(TaskRevisionDB).where(TaskRevisionDB.batch_run_id == "b7")
        ).first()
        is None
    )
    assert (
        session.exec(select(RunDB).where(RunDB.project == "p7")).all() == []
    )
    schedule = session.get(AgentTaskScheduleDB, "sched-7")
    assert schedule is not None and schedule.last_batch_run_id is None


def test_delete_batch_run_conflict_while_running(
    client: TestClient, session: Session
) -> None:
    owner = _make_user(session, "owner@t.dev")
    _make_project(session, owner, "p8")
    _seed_batch(session, "p8", "b8", status="running")

    resp = client.delete("/v1/agent-task-batch-runs/b8")
    assert resp.status_code == 409
    assert session.get(AgentTaskBatchRunDB, "b8") is not None


def test_delete_batch_run_not_found(client: TestClient) -> None:
    resp = client.delete("/v1/agent-task-batch-runs/nope")
    assert resp.status_code == 404
