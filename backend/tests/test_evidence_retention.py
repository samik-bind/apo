# pyright: reportAny=false, reportAttributeAccessIssue=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUnusedParameter=false

"""Two-tier retention: evidence expires, verdicts stay forever.

``APO_EVIDENCE_RETENTION_DAYS`` bounds the evidence tier (transcripts,
traces, check reports, rejudge check evidence, deliverables, attempt
diagnostics) while verdict rows — status, pass/fail, check counts, costs,
corrections — survive untouched, so the regression timeline stays intact.
Bookmarked traces are the escape hatch: a bookmarked run keeps all of its
evidence.
"""

import asyncio
import hashlib
from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import Session, select

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskCheckReportDB,
    AgentTaskDeliverableDB,
    AgentTaskJudgmentDB,
    AgentTaskRunDB,
    AgentTaskTestResultCorrectionDB,
    LoggedCallDB,
    OtlpSpanDB,
    ProjectDB,
    RunDB,
    TaskExecutionAttemptDB,
    UserDB,
)
from apo.services import retention
from apo.services.retention import expire_run_evidence
from tests.conftest import engine as test_engine
from tests.test_run_deletion import _RecordingStore, _patch_store

NOW = datetime.now(timezone.utc)


def _make_user(session: Session, email: str) -> UserDB:
    user = UserDB(email=email, name=email, password_hash="x", is_active=True)
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _seed_old_run(
    session: Session,
    *,
    run_id: str,
    batch_age_days: int = 30,
    bookmarked: bool = False,
) -> None:
    """One run with every evidence type attached, on an old batch."""
    owner = _make_user(session, f"owner-{run_id}@t.dev")
    session.add(ProjectDB(id="p-ev", name="p-ev", created_by=owner.id))
    session.commit()
    session.add(
        AgentTaskBatchRunDB(
            id="b-ev",
            project="p-ev",
            selection_type="task",
            task_root="/tmp",
            environment="default",
            status="completed",
            total_tasks=1,
            passed_tasks=1,
            created_at=NOW - timedelta(days=batch_age_days),
        )
    )
    session.commit()
    session.add(
        AgentTaskRunDB(
            id=run_id,
            batch_run_id="b-ev",
            task_id="t",
            task_path="/tmp/t",
            status="passed",
            pass_result=True,
            total_checks=2,
            passed_checks=2,
            transcript_json={"turns": ["..."]},
            trace_run_id=f"trace-{run_id}",
            started_at=NOW - timedelta(days=batch_age_days),
            completed_at=NOW - timedelta(days=batch_age_days),
        )
    )
    session.commit()
    session.add(AgentTaskCheckReportDB(run_id=run_id, value_json=[{"check": 1}], created_at=NOW))
    digest = hashlib.sha256(b"abc").hexdigest()
    session.add(
        AgentTaskDeliverableDB(
            id=f"dlv-{run_id}",
            project="p-ev",
            task_run_id=run_id,
            name="report.md",
            kind="artifact",
            status="ready",
            storage_backend="local",
            storage_key=f"ev/{run_id}",
            media_type="text/markdown",
            size_bytes=5,
            stored_size_bytes=5,
            sha256=digest,
            created_at=NOW,
            ready_at=NOW,
        )
    )
    session.add(
        AgentTaskJudgmentDB(
            task_run_id=run_id,
            project="p-ev",
            pass_result=True,
            checks_json=[{"check": "replayed"}],
            created_at=NOW,
        )
    )
    session.add(
        AgentTaskTestResultCorrectionDB(
            task_run_id=run_id,
            project="p-ev",
            test_id="report-is-complete",
            action="set_pass",
        )
    )
    session.add(
        TaskExecutionAttemptDB(
            project="p-ev",
            batch_run_id="b-ev",
            task_run_id=run_id,
            sequence_index=0,
            target_kind="pool",
            queue_expires_at=NOW + timedelta(hours=1),
            status="completed",
            stdout_tail="agent stdout...",
            stderr_tail="agent stderr...",
        )
    )
    # Trace projection: one run row, one call, one span.
    session.add(
        RunDB(
            id=f"trace-{run_id}",
            project="p-ev",
            task_run_id=run_id,
            bookmarked=bookmarked,
            created_at=NOW - timedelta(days=batch_age_days),
        )
    )
    session.add(
        LoggedCallDB(
            id=f"trace-{run_id}-tool",
            run_id=f"trace-{run_id}",
            project="p-ev",
            task_id="",
            created_at=NOW,
            model="unknown",
            observation_type="TOOL",
            latency_ms=5.0,
            input={},
            output={},
            messages=[],
        )
    )
    session.add(
        OtlpSpanDB(
            project_id="p-ev",
            trace_id=f"trace-{run_id}",
            span_id=f"trace-{run_id}-tool",
            created_at=NOW - timedelta(days=batch_age_days),
        )
    )
    session.commit()


class TestExpireRunEvidence:
    def test_evidence_goes_verdicts_stay(self, session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
        _seed_old_run(session, run_id="r-ev")
        store = _RecordingStore()
        _patch_store(monkeypatch, store)

        summary = asyncio.run(expire_run_evidence(session, NOW - timedelta(days=7)))

        assert summary["runs_affected"] == 1
        assert summary["deleted_traces"] == 1
        assert summary["deleted_check_reports"] == 1
        assert summary["deleted_deliverables"] == 1
        assert summary["blanked_judgments"] == 1
        assert store.deleted == ["ev/r-ev"]

        # Verdict tier survives.
        run = session.get(AgentTaskRunDB, "r-ev")
        assert run is not None
        assert run.status == "passed"
        assert run.pass_result is True
        assert run.total_checks == 2
        assert session.get(AgentTaskBatchRunDB, "b-ev") is not None
        assert (
            session.exec(
                select(AgentTaskTestResultCorrectionDB).where(
                    AgentTaskTestResultCorrectionDB.task_run_id == "r-ev"
                )
            ).first()
            is not None
        )
        judgment = session.exec(
            select(AgentTaskJudgmentDB).where(AgentTaskJudgmentDB.task_run_id == "r-ev")
        ).first()
        assert judgment is not None and judgment.pass_result is True

        # Evidence tier is gone.
        assert run.transcript_json is None
        assert run.trace_run_id is None
        assert session.get(AgentTaskCheckReportDB, "r-ev") is None
        assert (
            session.exec(
                select(AgentTaskDeliverableDB).where(AgentTaskDeliverableDB.task_run_id == "r-ev")
            ).first()
            is None
        )
        assert judgment.checks_json is None
        attempt = session.exec(
            select(TaskExecutionAttemptDB).where(TaskExecutionAttemptDB.task_run_id == "r-ev")
        ).first()
        assert attempt is not None
        assert attempt.stdout_tail is None and attempt.stderr_tail is None
        assert (
            session.exec(select(RunDB).where(RunDB.project == "p-ev")).all() == []
        )
        assert (
            session.exec(select(LoggedCallDB).where(LoggedCallDB.project == "p-ev")).all() == []
        )
        assert (
            session.exec(select(OtlpSpanDB).where(OtlpSpanDB.project_id == "p-ev")).all() == []
        )

    def test_bookmarked_run_keeps_everything(self, session: Session) -> None:
        _seed_old_run(session, run_id="r-bm", bookmarked=True)

        summary = asyncio.run(expire_run_evidence(session, NOW - timedelta(days=7)))

        assert summary["runs_affected"] == 0
        run = session.get(AgentTaskRunDB, "r-bm")
        assert run is not None
        assert run.transcript_json is not None
        assert run.trace_run_id is not None
        assert session.get(AgentTaskCheckReportDB, "r-bm") is not None
        # RunDB's PK is the surrogate row_id — query by (project, trace id).
        assert (
            session.exec(
                select(RunDB).where(RunDB.id == "trace-r-bm", RunDB.project == "p-ev")
            ).first()
            is not None
        )

    def test_fresh_batches_untouched(self, session: Session) -> None:
        _seed_old_run(session, run_id="r-fresh", batch_age_days=2)

        summary = asyncio.run(expire_run_evidence(session, NOW - timedelta(days=7)))

        assert summary["runs_affected"] == 0
        assert session.get(AgentTaskCheckReportDB, "r-fresh") is not None

    def test_demo_project_never_expires(self, session: Session) -> None:
        # The read-only demo workspace's showcase runs are managed by
        # demo_workspace reseeding — retention must never chew them.
        owner = _make_user(session, "demo-owner@t.dev")
        session.add(ProjectDB(id="demo", name="Demo workspace", created_by=owner.id))
        session.commit()
        session.add(
            AgentTaskBatchRunDB(
                id="b-demo-ev",
                project="demo",
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
                id="r-demo-ev",
                batch_run_id="b-demo-ev",
                task_id="t",
                task_path="/tmp/t",
                status="passed",
                pass_result=True,
                transcript_json={"turns": ["..."]},
                trace_run_id="trace-r-demo-ev",
                started_at=NOW - timedelta(days=30),
                completed_at=NOW - timedelta(days=30),
            )
        )
        session.add(RunDB(id="trace-r-demo-ev", project="demo", task_run_id="r-demo-ev", created_at=NOW - timedelta(days=30)))
        session.commit()

        summary = asyncio.run(expire_run_evidence(session, NOW - timedelta(days=7)))

        assert summary["runs_affected"] == 0
        run = session.get(AgentTaskRunDB, "r-demo-ev")
        assert run is not None
        assert run.transcript_json is not None
        assert run.trace_run_id is not None

    def test_re_run_is_a_noop(self, session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
        _seed_old_run(session, run_id="r-idem")
        store = _RecordingStore()
        _patch_store(monkeypatch, store)

        _ = asyncio.run(expire_run_evidence(session, NOW - timedelta(days=7)))
        session.commit()
        summary = asyncio.run(expire_run_evidence(session, NOW - timedelta(days=7)))

        # The has-evidence predicate no longer matches the expired run, so
        # the pass reports zero and never touches the store again.
        assert summary["runs_affected"] == 0
        assert store.deleted == ["ev/r-idem"]


class TestWiringAndPolicy:
    def test_maintenance_pass_expires_evidence(
        self, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _seed_old_run(session, run_id="r-maint")
        monkeypatch.setattr(retention, "engine", test_engine)
        monkeypatch.setattr(retention, "is_sqlite", lambda: False)
        monkeypatch.setattr(retention, "RETENTION_DAYS", 0)
        monkeypatch.setenv("APO_EVIDENCE_RETENTION_DAYS", "7")

        summary = retention.run_maintenance_cleanup()

        assert summary["runs_affected"] == 1
        assert summary["deleted_traces"] == 1
        assert session.get(AgentTaskCheckReportDB, "r-maint") is None
        # Retention-off means no full purge keys.
        assert "runs" not in summary

    def test_evidence_retention_days_env_parsing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from apo.services.retention import evidence_retention_days

        monkeypatch.delenv("APO_EVIDENCE_RETENTION_DAYS", raising=False)
        assert evidence_retention_days() == 0  # default: keep evidence forever
        monkeypatch.setenv("APO_EVIDENCE_RETENTION_DAYS", "90")
        assert evidence_retention_days() == 90
        monkeypatch.setenv("APO_EVIDENCE_RETENTION_DAYS", "garbage")
        assert evidence_retention_days() == 0
        monkeypatch.setenv("APO_EVIDENCE_RETENTION_DAYS", "-3")
        assert evidence_retention_days() == 0
