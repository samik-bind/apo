"""Issue #94: an unpriced generation must not let a run total masquerade as
complete. The per-call ``cost_provenance='unpriced'`` signal (issue #57) has to
roll up to the task run / trace so the CLI and dashboard can mark the total as
partial instead of silently under-reporting spend.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlmodel import Session, SQLModel, create_engine
from sqlalchemy.pool import StaticPool

from apo.models.db import AgentTaskRunDB, LoggedCallDB
from apo.services.trace_backend import NativeTraceBackend

NOW = datetime(2026, 8, 2, tzinfo=timezone.utc)


@pytest.fixture
def session() -> Session:  # pyright: ignore[reportInvalidTypeForm]
    eng = create_engine("sqlite://", poolclass=StaticPool)
    SQLModel.metadata.create_all(eng)
    sess = Session(eng)
    yield sess  # pyright: ignore[reportReturnType]
    sess.close()


def _make_task_run(run_id: str = "tr1", trace_run_id: str = "run-1") -> AgentTaskRunDB:
    return AgentTaskRunDB(
        id=run_id,
        batch_run_id="bch-1",
        task_id="task/x",
        task_path="task/x",
        status="completed",
        trace_run_id=trace_run_id,
    )


def _make_call(
    *,
    cid: str,
    run_id: str = "run-1",
    model: str = "gpt-4o-mini",
    cost: int | None = None,
    provided_cost: int | None = None,
    provenance: str | None = None,
    total_tokens: int | None = None,
) -> LoggedCallDB:
    return LoggedCallDB(  # pyright: ignore[reportCallIssue]
        id=cid,
        project="default",
        task_id="task/x",
        run_id=run_id,
        model=model,
        observation_type="GENERATION",
        created_at=NOW,
        cost=cost,
        provided_cost=provided_cost,
        cost_provenance=provenance,
        total_tokens=total_tokens,
    )


class TestUnpricedRollup:
    """A task run containing any unpriced call must carry that fact up to the
    run row so the total is not presented as complete."""

    def test_unpriced_call_count_rolls_up_to_task_run(self, session: Session) -> None:
        tr = _make_task_run()
        session.add(tr)
        # one priced call + one unpriced call against the same trace run
        session.add(
            _make_call(cid="c1", cost=1_000, provenance="computed", total_tokens=100)
        )
        session.add(
            _make_call(
                cid="c2",
                cost=None,
                provenance="unpriced",
                total_tokens=50_000,
                model="deepseek-v4-flash-0731",
            )
        )
        session.commit()

        NativeTraceBackend().aggregate_costs(session, tr, "default")

        # The total only counts the priced call (1_000 micro-USD); the unpriced
        # call does NOT silently contribute 0. ``total_cost`` is micro-USD.
        assert tr.total_cost == 1000.0
        # The unpriced provenance rolls up so consumers can mark it partial.
        assert tr.unpriced_call_count == 1

    def test_all_priced_run_has_zero_unpriced_count(self, session: Session) -> None:
        tr = _make_task_run()
        session.add(tr)
        session.add(_make_call(cid="c1", cost=500, provenance="computed"))
        session.add(_make_call(cid="c2", cost=1_500, provenance="computed"))
        session.commit()

        NativeTraceBackend().aggregate_costs(session, tr, "default")

        assert tr.total_cost == 2000.0
        assert tr.unpriced_call_count == 0

    def test_all_unpriced_run_carries_count_and_null_total(self, session: Session) -> None:
        tr = _make_task_run()
        session.add(tr)
        session.add(_make_call(cid="c1", cost=None, provenance="unpriced", model="glm-5.2"))
        session.commit()

        NativeTraceBackend().aggregate_costs(session, tr, "default")

        # No priced call → total stays null (not a fake $0.00).
        assert tr.total_cost is None
        assert tr.unpriced_call_count == 1
