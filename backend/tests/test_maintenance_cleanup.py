# pyright: reportAny=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportUnusedParameter=false

"""Daily maintenance pass: ingest-payload trim, span sweep, credential
reaping, batch-purge reference detachment, and schedule-delete cascade.

These close the retention-coverage gaps from the data-growth research
(docs/data-growth-retention-research.md): raw OTLP payloads and spans used
to survive every cleanup, abandoned uploads were never reaped (dead code),
purging a schedule-referenced batch could FK-fail, and schedule deletion
orphaned occurrences and adaptive states.
"""

from datetime import datetime, timedelta, timezone

import pytest

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.models.db import (
    AdaptiveTaskStateDB,
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    AgentTaskScheduleOccurrenceDB,
    EmailVerificationTokenDB,
    ExecutorEnrollmentTokenDB,
    OtlpIngestBatchDB,
    OtlpSpanDB,
    PasswordResetTokenDB,
    ProjectDB,
    RunDB,
    UserDB,
)
from apo.services import retention
from apo.services.project_memberships import create_owner_membership
from tests.conftest import engine as test_engine

NOW = datetime.now(timezone.utc)


def _make_user(session: Session, email: str) -> UserDB:
    user = UserDB(email=email, name=email, password_hash="x", is_active=True)
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


# ---------------------------------------------------------------------------
# Ingest payload trimming
# ---------------------------------------------------------------------------


def _seed_ingest(session: Session, batch_id: str, age_days: int, payload: str) -> None:
    session.add(
        OtlpIngestBatchDB(
            id=batch_id,
            project_id="p1",
            received_at=NOW - timedelta(days=age_days),
            payload=payload,
        )
    )
    session.commit()


def test_trim_blanks_old_payloads_and_keeps_recent(session: Session) -> None:
    _seed_ingest(session, "ing-old", age_days=10, payload='{"spans": [...]}')
    _seed_ingest(session, "ing-fresh", age_days=2, payload='{"spans": [...]}')
    _seed_ingest(session, "ing-already-empty", age_days=30, payload="")

    trimmed = retention.trim_old_ingest_payloads(
        session, NOW - timedelta(days=7)
    )

    # Only the payload-bearing old row matches; already-empty rows are
    # excluded by the WHERE so the count reflects real bytes freed.
    assert trimmed == 1
    assert session.get(OtlpIngestBatchDB, "ing-old").payload == ""
    assert session.get(OtlpIngestBatchDB, "ing-fresh").payload == '{"spans": [...]}'
    assert session.get(OtlpIngestBatchDB, "ing-already-empty").payload == ""
    # The audit row survives the trim.
    assert session.get(OtlpIngestBatchDB, "ing-old") is not None


def test_trim_window_env_parsing(monkeypatch: pytest.MonkeyPatch) -> None:
    import os

    from apo.services.retention import (
        DEFAULT_INGEST_PAYLOAD_RETENTION_DAYS,
        ingest_payload_retention_days,
    )

    # Default when unset or garbage; clamped at zero.
    os.environ.pop("APO_INGEST_RETENTION_DAYS", None)
    assert ingest_payload_retention_days() == DEFAULT_INGEST_PAYLOAD_RETENTION_DAYS
    os.environ["APO_INGEST_RETENTION_DAYS"] = "not-a-number"
    assert ingest_payload_retention_days() == DEFAULT_INGEST_PAYLOAD_RETENTION_DAYS
    os.environ["APO_INGEST_RETENTION_DAYS"] = "30"
    assert ingest_payload_retention_days() == 30
    os.environ["APO_INGEST_RETENTION_DAYS"] = "-5"
    assert ingest_payload_retention_days() == 0
    os.environ.pop("APO_INGEST_RETENTION_DAYS", None)


# ---------------------------------------------------------------------------
# Span orphan sweep
# ---------------------------------------------------------------------------


def _seed_span(session: Session, project: str, trace_id: str, age_days: int) -> None:
    session.add(
        OtlpSpanDB(
            project_id=project,
            trace_id=trace_id,
            span_id=f"{trace_id}-s",
            created_at=NOW - timedelta(days=age_days),
        )
    )


def test_span_sweep_removes_orphans_keeps_living_traces(session: Session) -> None:
    # A surviving (bookmarked) old trace keeps its spans.
    session.add(
        RunDB(id="t-keep", project="p1", bookmarked=True, created_at=NOW - timedelta(days=30))
    )
    _seed_span(session, "p1", "t-keep", age_days=30)
    # A purged trace leaves orphaned spans — these must go.
    _seed_span(session, "p1", "t-gone", age_days=30)
    # A young trace's spans stay regardless.
    session.add(RunDB(id="t-young", project="p1", created_at=NOW))
    _seed_span(session, "p1", "t-young", age_days=0)
    session.commit()

    deleted = retention.delete_orphaned_spans(session, NOW - timedelta(days=7))

    assert deleted == 1
    remaining = session.exec(select(OtlpSpanDB)).all()
    assert sorted(s.trace_id for s in remaining) == ["t-keep", "t-young"]


def test_span_sweep_scopes_survival_by_project(session: Session) -> None:
    # Same OTel trace id projected in two projects: p2's copy survives on
    # p2's living run even though p1's copy is orphaned.
    session.add(RunDB(id="t-shared", project="p2", created_at=NOW - timedelta(days=30)))
    _seed_span(session, "p1", "t-shared", age_days=30)
    _seed_span(session, "p2", "t-shared", age_days=30)
    session.commit()

    deleted = retention.delete_orphaned_spans(session, NOW - timedelta(days=7))

    assert deleted == 1
    remaining = session.exec(select(OtlpSpanDB)).all()
    assert [s.project_id for s in remaining] == ["p2"]


# ---------------------------------------------------------------------------
# Credential reaping
# ---------------------------------------------------------------------------


def test_reap_deletes_only_expired_credentials(session: Session) -> None:
    user = _make_user(session, "tok@t.dev")
    session.add(
        EmailVerificationTokenDB(
            user_id=user.id, code_hash="h-old", expires_at=NOW - timedelta(days=1)
        )
    )
    session.add(
        EmailVerificationTokenDB(
            user_id=user.id, code_hash="h-live", expires_at=NOW + timedelta(days=1)
        )
    )
    session.add(
        PasswordResetTokenDB(
            user_id=user.id, token_hash="r-old", expires_at=NOW - timedelta(hours=1)
        )
    )
    session.add(
        ExecutorEnrollmentTokenDB(
            id="enr-old",
            scope_kind="installation",
            token_prefix="pre",
            token_hash="e-old",
            expires_at=NOW - timedelta(days=2),
        )
    )
    session.commit()

    deleted = retention.reap_expired_credentials(session)

    assert deleted == 3
    live = session.exec(select(EmailVerificationTokenDB)).all()
    assert [t.code_hash for t in live] == ["h-live"]
    assert session.exec(select(PasswordResetTokenDB)).first() is None


# ---------------------------------------------------------------------------
# Batch purge: schedule references detach instead of FK-failing
# ---------------------------------------------------------------------------


def test_batch_purge_detaches_schedule_references(session: Session) -> None:
    owner = _make_user(session, "purge@t.dev")
    session.add(ProjectDB(id="p1", name="p1", created_by=owner.id))
    session.add(
        AgentTaskBatchRunDB(
            id="b-old",
            project="p1",
            selection_type="task",
            task_root="/tmp",
            environment="default",
            status="completed",
            created_at=NOW - timedelta(days=30),
        )
    )
    session.commit()
    session.add(
        AgentTaskRunDB(
            id="r-old",
            batch_run_id="b-old",
            task_id="t",
            task_path="/tmp/t",
            status="passed",
        )
    )
    session.add(
        AgentTaskScheduleDB(
            id="sched-1",
            project="p1",
            name="daily",
            selection_type="task",
            cadence_type="daily",
            active_batch_run_id="b-old",
            last_batch_run_id="b-old",
        )
    )
    session.commit()
    session.add(
        AgentTaskScheduleOccurrenceDB(
            id="occ-1",
            project="p1",
            schedule_id="sched-1",
            schedule_name="daily",
            kind="scheduled",
            scheduled_for=NOW - timedelta(days=30),
            status="delivered",
            batch_run_id="b-old",
        )
    )
    session.commit()

    # Under PRAGMA foreign_keys=ON this used to FK-fail on the schedule
    # reference before the reference detach existed.
    deleted = retention._delete_old_batch_runs(session, NOW - timedelta(days=7))

    assert deleted >= 1
    assert session.get(AgentTaskBatchRunDB, "b-old") is None
    schedule = session.get(AgentTaskScheduleDB, "sched-1")
    assert schedule is not None
    assert schedule.active_batch_run_id is None
    assert schedule.last_batch_run_id is None
    occurrence = session.get(AgentTaskScheduleOccurrenceDB, "occ-1")
    assert occurrence is not None and occurrence.batch_run_id is None


# ---------------------------------------------------------------------------
# Schedule deletion cascades occurrences and adaptive states
# ---------------------------------------------------------------------------


def test_schedule_delete_cascades_dependents(
    client: TestClient, session: Session
) -> None:
    owner = _make_user(session, "owner@t.dev")
    session.add(ProjectDB(id="p9", name="p9", created_by=owner.id))
    session.commit()
    create_owner_membership(session, "p9", owner.id)
    session.add(
        AgentTaskScheduleDB(
            id="sched-9",
            project="p9",
            name="weekly",
            selection_type="task",
            cadence_type="weekly",
        )
    )
    session.commit()
    session.add(
        AgentTaskScheduleOccurrenceDB(
            id="occ-9",
            project="p9",
            schedule_id="sched-9",
            schedule_name="weekly",
            kind="scheduled",
            scheduled_for=NOW,
            status="delivered",
        )
    )
    session.add(
        AdaptiveTaskStateDB(
            id="sched-9||some-task",
            schedule_id="sched-9",
            task_id="some-task",
        )
    )
    session.commit()

    resp = client.delete("/v1/agent-task-schedules/sched-9")

    assert resp.status_code == 200
    session.expire_all()
    assert session.get(AgentTaskScheduleDB, "sched-9") is None
    assert session.get(AgentTaskScheduleOccurrenceDB, "occ-9") is None
    assert session.get(AdaptiveTaskStateDB, "sched-9||some-task") is None


# ---------------------------------------------------------------------------
# Wiring: the maintenance pass runs hygiene even with retention off
# ---------------------------------------------------------------------------


def test_maintenance_pass_runs_hygiene_with_retention_off(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(retention, "engine", test_engine)
    monkeypatch.setattr(retention, "is_sqlite", lambda: False)
    monkeypatch.setattr(retention, "RETENTION_DAYS", 0)

    # An old ingest payload gets trimmed by the always-on pass.
    _seed_ingest(session, "ing-maint", age_days=10, payload="x" * 100)

    summary = retention.run_maintenance_cleanup()

    assert summary["trimmed_ingest_payloads"] == 1
    assert session.get(OtlpIngestBatchDB, "ing-maint").payload == ""
    # Retention-off means no run/batch purge keys in the summary.
    assert "runs" not in summary
    assert "agent_task_batch_runs" not in summary
