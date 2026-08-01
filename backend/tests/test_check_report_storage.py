# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportReturnType=false, reportCallIssue=false

"""SPEC-167: Check Report storage boundary.

The full check evidence lives off the hot ``agent_task_runs`` row in
``agent_task_check_reports``; the run row carries only the scalar verdict
(``total_checks`` / ``passed_checks`` / ``failed_checks``). Per-field hygiene
(``received``, judge segments) is retained; the 1 MiB total cap and the
per-string caps on reasoning/instruction/expected are gone — for a judged run
the reasoning *is* the result, and the row is no longer on the hot path.
"""

from __future__ import annotations

import hashlib
import json

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from apo.models.db import AgentTaskCheckReportDB, AgentTaskRunDB
from apo.models.schemas import TruncatedCheckValue
from apo.services.check_report_storage import (
    JUDGE_SEGMENT_LIMIT,
    RECEIVED_VALUE_LIMIT,
    load_check_report,
    persist_check_report,
)


@pytest.fixture
def session() -> Session:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def _make_run(session: Session, run_id: str = "run-1") -> AgentTaskRunDB:
    run = AgentTaskRunDB(
        id=run_id,
        batch_run_id="batch-1",
        task_id="t1",
        task_path="/t",
        status="running",
    )
    session.add(run)
    session.commit()
    return run


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class TestPersistCheckReport:
    def test_writes_scalar_verdict_and_report_row(self, session: Session):
        run = _make_run(session)
        checks = [
            {"id": "a", "pass": True},
            {"id": "b", "pass": False},
            {"id": "c", "pass": True},
        ]

        persist_check_report(session, run, checks)
        session.commit()
        session.refresh(run)

        assert run.total_checks == 3
        assert run.passed_checks == 2
        assert run.failed_checks == 1
        assert run.checks_json is None  # legacy column cleared

        report = session.get(AgentTaskCheckReportDB, run.id)
        assert report is not None
        assert report.value_json == checks

    def test_load_returns_report_body(self, session: Session):
        run = _make_run(session)
        checks = [{"id": "a", "pass": True, "reasoning": "because"}]

        persist_check_report(session, run, checks)
        session.commit()

        assert load_check_report(session, run.id) == checks

    def test_load_falls_back_to_legacy_checks_json(self, session: Session):
        # A restored backup / pre-migration row with no report row still renders.
        run = _make_run(session)
        run.checks_json = [{"id": "legacy", "pass": True}]
        session.add(run)
        session.commit()

        assert load_check_report(session, run.id) == [{"id": "legacy", "pass": True}]

    def test_load_returns_none_for_missing_run(self, session: Session):
        assert load_check_report(session, "nope") is None

    def test_reasoning_is_not_capped(self, session: Session):
        run = _make_run(session)
        big = "r" * (1024 * 200)  # 200 KiB — well past the retired 32 KiB cap

        persist_check_report(session, run, [{"id": "a", "pass": True, "reasoning": big}])
        session.commit()

        body = load_check_report(session, run.id)
        assert body is not None
        assert body[0]["reasoning"] == big  # full reasoning retained

    def test_no_total_cap_many_checks_persist_whole(self, session: Session):
        run = _make_run(session)
        # 80 checks x ~64 KiB reasoning ~= 5 MiB — blows the retired 1 MiB cap.
        checks = [
            {"id": f"c-{i}", "pass": i % 2 == 0, "reasoning": "x" * (64 * 1024)}
            for i in range(80)
        ]

        persist_check_report(session, run, checks)
        session.commit()
        session.refresh(run)

        assert run.total_checks == 80
        assert run.passed_checks == 40
        body = load_check_report(session, run.id)
        assert body is not None
        assert len(body) == 80
        assert all(entry["reasoning"] == "x" * (64 * 1024) for entry in body)

    def test_pathological_received_becomes_marker(self, session: Session):
        run = _make_run(session)
        big = "y" * (RECEIVED_VALUE_LIMIT + 1000)
        encoded = json.dumps(big).encode("utf-8")

        persist_check_report(session, run, [{"id": "a", "pass": True, "received": big}])
        session.commit()

        body = load_check_report(session, run.id)
        assert body is not None
        received = body[0]["received"]
        assert isinstance(received, dict)
        assert received["kind"] == "truncated"
        assert received["size_bytes"] == len(encoded)
        assert received["sha256"] == _sha(encoded)

    def test_judge_segments_are_truncated(self, session: Session):
        run = _make_run(session)
        prompt = "p" * (JUDGE_SEGMENT_LIMIT + 500)
        response = "r" * (JUDGE_SEGMENT_LIMIT + 500)

        persist_check_report(
            session,
            run,
            [{"id": "a", "pass": True, "judge_prompt": prompt, "judge_response": response}],
        )
        session.commit()

        body = load_check_report(session, run.id)
        assert body is not None
        serialized = json.dumps(body)
        assert "p" * 1024 not in serialized
        assert "r" * 1024 not in serialized

    def test_group_identity_survives(self, session: Session):
        run = _make_run(session)
        checks = [
            {"id": "R-1", "pass": True, "group_id": "rules", "group_name": "Rules"},
            {"id": "R-2", "pass": False, "group_id": "rules", "group_name": "Rules"},
        ]

        persist_check_report(session, run, checks)
        session.commit()

        body = load_check_report(session, run.id)
        assert body is not None
        for entry in body:
            assert entry["group_id"] == "rules"
            assert entry["group_name"] == "Rules"

    def test_empty_and_none_checks_are_safe(self, session: Session):
        run = _make_run(session)
        persist_check_report(session, run, [])
        session.commit()
        session.refresh(run)
        assert run.total_checks == 0
        assert run.passed_checks == 0

        run2 = _make_run(session, "run-2")
        persist_check_report(session, run2, None)
        session.commit()
        session.refresh(run2)
        assert run2.total_checks == 0

    def test_non_dict_entries_are_dropped(self, session: Session):
        run = _make_run(session)
        persist_check_report(
            session,
            run,
            [{"id": "good", "pass": True}, "not a dict", None],  # type: ignore[list-item]
        )
        session.commit()
        session.refresh(run)

        assert run.total_checks == 1
        body = load_check_report(session, run.id)
        assert body == [{"id": "good", "pass": True}]

    def test_truncated_marker_matches_schema(self, session: Session):
        run = _make_run(session)
        big = "z" * (RECEIVED_VALUE_LIMIT + 10)

        persist_check_report(session, run, [{"id": "a", "pass": True, "received": big}])
        session.commit()

        body = load_check_report(session, run.id)
        assert body is not None
        parsed = TruncatedCheckValue.model_validate(body[0]["received"])
        assert parsed.kind == "truncated"

    def test_re_persist_upserts_the_report_row(self, session: Session):
        run = _make_run(session)
        persist_check_report(session, run, [{"id": "a", "pass": True}])
        session.commit()

        # Re-finalize (idempotent external re-report after a transient failure).
        persist_check_report(
            session, run, [{"id": "a", "pass": False}, {"id": "b", "pass": True}]
        )
        session.commit()
        session.refresh(run)

        assert run.total_checks == 2
        assert run.passed_checks == 1
        body = load_check_report(session, run.id)
        assert body == [{"id": "a", "pass": False}, {"id": "b", "pass": True}]
