# pyright: reportAny=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportMissingParameterType=false

"""Direct unit tests for the run-list query service.

These exercise the filtering, sorting, pagination, and status-derivation
logic without going through FastAPI/HTTP — the whole reason the service
was extracted from the ``GET /v1/runs`` route handler. The HTTP-level
happy path is already covered by ``test_runs_api.py::test_list_runs``.
"""

from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import Session

from apo.models import LoggedCallDB, RunDB, RunMetricDB
from apo.routes.runs.list_query import (
    RunListFilters,
    RunListPagination,
    list_run_summaries,
)


_NOW = datetime.now(timezone.utc)


def _run(
    rid: str,
    *,
    project: str = "p",
    call_count: int = 0,
    created_at: datetime | None = None,
    duration_ms: float | None = None,
    bookmarked: bool = False,
) -> RunDB:
    return RunDB(
        id=rid,
        project=project,
        task_id="t",
        created_at=created_at or _NOW,
        call_count=call_count,
        duration_ms=duration_ms,
        bookmarked=bookmarked,
    )


def _call(
    cid: str,
    rid: str,
    *,
    level: str | None = None,
    project: str = "p",
    created_at: datetime | None = None,
) -> LoggedCallDB:
    return LoggedCallDB(
        id=cid,
        project=project,
        model="m",
        task_id="t",
        run_id=rid,
        created_at=created_at or _NOW,
        input={},
        messages=[],
        output={},
        level=level,
    )


def _query(
    session: Session, filters: RunListFilters | None = None
) -> tuple[list[str], int]:
    page = list_run_summaries(
        session,
        filters or RunListFilters(),
        RunListPagination(page=0, page_size=50, sort_by=None, sort_order="asc"),
    )
    return [r.id for r in page.data], page.total_count


# ---------------------------------------------------------------------------
# Metric filter: early-return when no run matches
# ---------------------------------------------------------------------------


def test_metric_filter_no_matches_short_circuits_to_empty(session: Session):
    session.add(_run("r1"))
    session.commit()

    ids, total = _query(
        session, RunListFilters(metric_name="nonexistent", min_score=0.5)
    )
    assert ids == []
    assert total == 0


def test_metric_filter_returns_matching_runs(session: Session):
    session.add(_run("r1", call_count=1))
    session.add(_run("r2", call_count=1))
    session.add(
        RunMetricDB(
            run_id="r1",
            project="p",
            metric_name="accuracy",
            score=0.9,
            metric_type="quality",
            data_type="NUMERIC",
        )
    )
    session.commit()

    ids, total = _query(session, RunListFilters(metric_name="accuracy"))
    assert ids == ["r1"]
    assert total == 1


def test_metric_filter_score_range(session: Session):
    session.add(_run("r1"))
    session.add(_run("r2"))
    session.add(
        RunMetricDB(
            run_id="r1", project="p", metric_name="acc", score=0.3,
            metric_type="quality", data_type="NUMERIC",
        )
    )
    session.add(
        RunMetricDB(
            run_id="r2", project="p", metric_name="acc", score=0.8,
            metric_type="quality", data_type="NUMERIC",
        )
    )
    session.commit()

    ids, _ = _query(
        session, RunListFilters(metric_name="acc", min_score=0.5)
    )
    assert ids == ["r2"]


# ---------------------------------------------------------------------------
# Status derivation + filter
# ---------------------------------------------------------------------------


def test_status_filter_error(session: Session):
    session.add(_run("r-err", call_count=1))
    session.add(_run("r-ok", call_count=1))
    session.add(_call("c1", "r-err", level="ERROR"))
    session.add(_call("c2", "r-ok", level=None))
    session.commit()

    ids, _ = _query(session, RunListFilters(status_values=["error"]))
    assert ids == ["r-err"]


def test_status_filter_success_excludes_zero_call_runs(session: Session):
    session.add(_run("r-empty", call_count=0))
    session.add(_run("r-ok", call_count=1))
    session.commit()

    ids, _ = _query(session, RunListFilters(status_values=["success"]))
    assert ids == ["r-ok"]


# ---------------------------------------------------------------------------
# Sort
# ---------------------------------------------------------------------------


def test_sort_by_duration_desc(session: Session):
    session.add(_run("r1", duration_ms=100.0, created_at=_NOW - timedelta(minutes=2)))
    session.add(_run("r2", duration_ms=500.0, created_at=_NOW - timedelta(minutes=1)))
    session.add(_run("r3", duration_ms=50.0, created_at=_NOW))
    session.commit()

    page = list_run_summaries(
        session,
        RunListFilters(),
        RunListPagination(page=0, page_size=50, sort_by="duration_ms", sort_order="desc"),
    )
    assert [r.id for r in page.data] == ["r2", "r1", "r3"]


def test_invalid_sort_field_falls_back_to_created_at(session: Session):
    session.add(_run("r1", created_at=_NOW - timedelta(minutes=1)))
    session.add(_run("r2", created_at=_NOW))
    session.commit()

    page = list_run_summaries(
        session,
        RunListFilters(),
        RunListPagination(page=0, page_size=50, sort_by="nonsense", sort_order="asc"),
    )
    assert [r.id for r in page.data] == ["r1", "r2"]


# ---------------------------------------------------------------------------
# Pagination
# ---------------------------------------------------------------------------


def test_pagination_page_boundaries(session: Session):
    for i in range(5):
        session.add(_run(f"r{i}", created_at=_NOW - timedelta(minutes=4 - i)))
    session.commit()

    page1 = list_run_summaries(
        session,
        RunListFilters(),
        RunListPagination(page=0, page_size=2, sort_by="created_at", sort_order="asc"),
    )
    page2 = list_run_summaries(
        session,
        RunListFilters(),
        RunListPagination(page=1, page_size=2, sort_by="created_at", sort_order="asc"),
    )

    assert len(page1.data) == 2
    assert page1.total_pages == 3
    assert [r.id for r in page1.data] == ["r0", "r1"]
    assert [r.id for r in page2.data] == ["r2", "r3"]


# ---------------------------------------------------------------------------
# Project scope
# ---------------------------------------------------------------------------


def test_allowed_projects_restricts_cross_tenant(session: Session):
    session.add(_run("r1", project="proj-a"))
    session.add(_run("r2", project="proj-b"))
    session.commit()

    ids, total = _query(session, RunListFilters(allowed_projects=["proj-a"]))
    assert ids == ["r1"]
    assert total == 1


def test_pinned_project_filters_exact_match(session: Session):
    session.add(_run("r1", project="proj-a"))
    session.add(_run("r2", project="proj-b"))
    session.commit()

    ids, _ = _query(session, RunListFilters(project="proj-a"))
    assert ids == ["r1"]


# ---------------------------------------------------------------------------
# Bookmarked filter
# ---------------------------------------------------------------------------


def test_bookmarked_filter(session: Session):
    session.add(_run("r1", bookmarked=True))
    session.add(_run("r2", bookmarked=False))
    session.commit()

    ids, _ = _query(session, RunListFilters(bookmarked=True))
    assert ids == ["r1"]


if __name__ == "__main__":
    import sys

    sys.exit(pytest.main(["-v", __file__]))
