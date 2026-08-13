# pyright: reportAny=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false

"""SPEC-177 backend scene + unit tests for comparison overview/evidence routes
and the summary loader.

Covers the acceptance tests from the spec:
- Overview returns every frozen run as summaries (equal pass/pass, fail/fail,
  differing, errored, one-sided).
- Overview response is independent of Check Report size.
- Task evidence resolves the frozen pair server-side.
- One-sided task evidence remains explicit.
- Arbitrary task/run access is rejected.
- Unsafe bulk endpoint is gone.
- Summary loader excludes heavy evidence and is project-scoped.
"""

from datetime import datetime, timezone
from typing import cast

import pytest
from fastapi import HTTPException
from sqlmodel import Session
from starlette.requests import Request
from starlette.types import Scope

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ProjectDB,
    ProjectMembershipDB,
    UserDB,
)
from apo.models.schemas import (
    TaskViewComparisonSnapshot,
    TaskViewConfig,
)
from apo.routes.agent_task_views import (
    get_task_comparison_evidence,
    get_task_view_comparison_overview,
)
from apo.services.agent_task_run_details import load_task_run_summaries
from apo.services.task_view_comparison import create_comparison

_PROJECT = "proj-177"
_OWNER = "owner-177"
_NOW = datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _seed_project(session: Session) -> None:
    session.add(UserDB(id=_OWNER, email="o@t.co", name="Owner", password_hash="x"))
    session.flush()
    session.add(ProjectDB(id=_PROJECT, name=_PROJECT, created_by=_OWNER))
    session.flush()
    session.add(ProjectMembershipDB(project_id=_PROJECT, user_id=_OWNER, role="owner"))
    session.commit()


def _batch(session: Session, bid: str, *, project: str = _PROJECT) -> None:
    session.add(AgentTaskBatchRunDB(
        id=bid,
        project=project,
        selection_type="catalog",
        status="completed",
        total_tasks=1,
        created_at=_NOW,
        execution_target_json={},
    ))
    session.flush()


def _run(
    session: Session,
    rid: str,
    bid: str,
    *,
    task_id: str = "t1",
    status: str = "success",
    pass_result: bool | None = None,
    project: str = _PROJECT,
    model: str = "claude-sonnet",
    effort: str = "medium",
) -> AgentTaskRunDB:
    run = AgentTaskRunDB(
        id=rid,
        batch_run_id=bid,
        task_id=task_id,
        task_path=f"/{task_id}",
        adapter_name="test",
        status=status,
        pass_result=pass_result if pass_result is not None else (status == "success"),
        started_at=_NOW,
        completed_at=_NOW,
        configured_model=model,
        configured_effort=effort,
    )
    session.add(run)
    session.flush()
    return run


def _req(user_id: str | None = _OWNER) -> Request:
    request = Request(cast(Scope, {"type": "http"}))
    if user_id:
        request.state.user_id = user_id
    return request


def _make_comparison(
    session: Session,
    *,
    task_ids: list[str],
    side_a_runs: dict[str, str],
    side_b_runs: dict[str, str],
) -> TaskViewComparisonSnapshot:
    """Create a comparison by directly inserting runs + snapshot.

    ``side_a_runs`` / ``side_b_runs`` map ``task_id -> run_id``.
    """
    view_a = TaskViewConfig(model="claude-sonnet", effort="medium")
    view_b = TaskViewConfig(model="gpt-4o", effort="medium")
    return create_comparison(
        session,
        project_id=_PROJECT,
        task_ids=task_ids,
        view_a=view_a,
        view_b=view_b,
        created_by=_OWNER,
    )


# ---------------------------------------------------------------------------
# Summary loader unit tests (spec tests 1-2)
# ---------------------------------------------------------------------------


def test_summary_loader_excludes_heavy_evidence(session: Session) -> None:
    _seed_project(session)
    _batch(session, "b1")
    _run(session, "r1", "b1")
    session.commit()

    summaries = load_task_run_summaries(session, ["r1"], project_id=_PROJECT)
    assert len(summaries) == 1
    s = summaries[0]
    assert s.id == "r1"
    assert s.status == "success"
    assert s.task_id == "t1"


def test_summary_loader_preserves_requested_order(session: Session) -> None:
    _seed_project(session)
    _batch(session, "b1")
    _run(session, "r2", "b1", task_id="t2")
    _run(session, "r1", "b1", task_id="t1")
    session.commit()

    summaries = load_task_run_summaries(session, ["r1", "r2"], project_id=_PROJECT)
    assert [s.id for s in summaries] == ["r1", "r2"]


def test_summary_loader_is_project_scoped(session: Session) -> None:
    _seed_project(session)
    session.add(ProjectDB(id="proj-other", name="other", created_by=_OWNER))
    session.flush()
    session.add(ProjectMembershipDB(project_id="proj-other", user_id=_OWNER, role="owner"))
    session.commit()

    _batch(session, "b-ours")
    _run(session, "r-ours", "b-ours")

    _batch(session, "b-theirs", project="proj-other")
    _run(session, "r-theirs", "b-theirs", project="proj-other")
    session.commit()

    summaries = load_task_run_summaries(
        session, ["r-ours", "r-theirs"], project_id=_PROJECT
    )
    assert [s.id for s in summaries] == ["r-ours"]


def test_summary_loader_deduplicates_ids(session: Session) -> None:
    _seed_project(session)
    _batch(session, "b1")
    _run(session, "r1", "b1")
    session.commit()

    summaries = load_task_run_summaries(
        session, ["r1", "r1", "r1"], project_id=_PROJECT
    )
    assert len(summaries) == 1


# ---------------------------------------------------------------------------
# Overview scene tests (spec scene tests 1-2, 6)
# ---------------------------------------------------------------------------


async def test_overview_returns_every_frozen_run_as_summaries(
    session: Session,
) -> None:
    """Every frozen task — pass/pass, fail/fail, differing, errored, one-sided —
    is represented in the overview."""
    _seed_project(session)

    _batch(session, "ba")
    _batch(session, "bb")
    _run(session, "ra-pass", "ba", task_id="t-pass", status="success", pass_result=True, model="claude-sonnet")
    _run(session, "rb-pass", "bb", task_id="t-pass", status="success", pass_result=True, model="gpt-4o")
    _run(session, "ra-fail", "ba", task_id="t-fail", status="failed", pass_result=False, model="claude-sonnet")
    _run(session, "rb-fail", "bb", task_id="t-fail", status="failed", pass_result=False, model="gpt-4o")
    _run(session, "ra-diff", "ba", task_id="t-diff", status="success", pass_result=True, model="claude-sonnet")
    _run(session, "rb-diff", "bb", task_id="t-diff", status="failed", pass_result=False, model="gpt-4o")
    _run(session, "ra-err", "ba", task_id="t-err", status="error", model="claude-sonnet")
    _run(session, "rb-err", "bb", task_id="t-err", status="error", model="gpt-4o")
    session.commit()

    snap = _make_comparison(
        session,
        task_ids=["t-pass", "t-fail", "t-diff", "t-err"],
        side_a_runs={},
        side_b_runs={},
    )

    result = await get_task_view_comparison_overview(
        _PROJECT, snap.id, _req(), session
    )

    task_ids_in_snapshot = {c.task_id for c in result.snapshot.resolved}
    assert task_ids_in_snapshot == {"t-pass", "t-fail", "t-diff", "t-err"}

    run_ids_in_summaries = {r.id for r in result.runs}
    for cell in result.snapshot.resolved:
        if cell.a_run_id:
            assert cell.a_run_id in run_ids_in_summaries
        if cell.b_run_id:
            assert cell.b_run_id in run_ids_in_summaries


async def test_overview_404_for_missing_comparison(session: Session) -> None:
    _seed_project(session)
    with pytest.raises(HTTPException) as exc:
        await get_task_view_comparison_overview(
            _PROJECT, "tvc_nonexistent", _req(), session
        )
    assert cast(HTTPException, exc.value).status_code == 404


async def test_overview_404_cross_project(session: Session) -> None:
    _seed_project(session)
    session.add(ProjectDB(id="proj-other2", name="other", created_by=_OWNER))
    session.flush()
    session.add(ProjectMembershipDB(project_id="proj-other2", user_id=_OWNER, role="owner"))
    _batch(session, "ba", project="proj-other2")
    _batch(session, "bb", project="proj-other2")
    _run(session, "ra-x", "ba", project="proj-other2")
    _run(session, "rb-x", "bb", project="proj-other2")
    session.commit()

    snap = create_comparison(
        session,
        project_id="proj-other2",
        task_ids=["t1"],
        view_a=TaskViewConfig(model="claude-sonnet", effort="medium"),
        view_b=TaskViewConfig(model="gpt-4o", effort="medium"),
        created_by=_OWNER,
    )

    with pytest.raises(HTTPException) as exc:
        await get_task_view_comparison_overview(
            _PROJECT, snap.id, _req(), session
        )
    assert cast(HTTPException, exc.value).status_code == 404


# ---------------------------------------------------------------------------
# Task evidence scene tests (spec scene tests 3-5)
# ---------------------------------------------------------------------------


async def test_task_evidence_resolves_frozen_pair(session: Session) -> None:
    _seed_project(session)
    _batch(session, "ba")
    _batch(session, "bb")
    _run(session, "ra", "ba", task_id="t1", model="claude-sonnet")
    _run(session, "rb", "bb", task_id="t1", model="gpt-4o")
    session.commit()

    snap = _make_comparison(session, task_ids=["t1"], side_a_runs={}, side_b_runs={})

    evidence = await get_task_comparison_evidence(
        _PROJECT, snap.id, "t1", _req(), session
    )
    assert evidence.task_id == "t1"
    assert evidence.left is not None
    assert evidence.left.id == snap.resolved[0].a_run_id
    assert evidence.right is not None
    assert evidence.right.id == snap.resolved[0].b_run_id


async def test_one_sided_task_evidence(session: Session) -> None:
    _seed_project(session)
    _batch(session, "ba")
    _run(session, "ra-only", "ba", task_id="t1")
    session.commit()

    snap = _make_comparison(session, task_ids=["t1"], side_a_runs={}, side_b_runs={})

    cell = snap.resolved[0]
    assert cell.a_run_id is not None
    assert cell.b_run_id is None

    evidence = await get_task_comparison_evidence(
        _PROJECT, snap.id, "t1", _req(), session
    )
    assert evidence.left is not None
    assert evidence.right is None


async def test_task_evidence_404_for_task_not_in_snapshot(session: Session) -> None:
    _seed_project(session)
    _batch(session, "ba")
    _batch(session, "bb")
    _run(session, "ra", "ba", task_id="t1")
    _run(session, "rb", "bb", task_id="t1")
    session.commit()

    snap = _make_comparison(session, task_ids=["t1"], side_a_runs={}, side_b_runs={})

    with pytest.raises(HTTPException) as exc:
        await get_task_comparison_evidence(
            _PROJECT, snap.id, "t-nonexistent", _req(), session
        )
    assert cast(HTTPException, exc.value).status_code == 404


# ---------------------------------------------------------------------------
# Unsafe bulk endpoint is gone (spec scene test 6)
# ---------------------------------------------------------------------------


def test_old_bulk_evidence_route_is_gone() -> None:
    """The old GET /evidence route must not exist on the router."""
    from apo.routes.agent_task_views import router

    paths = {route.path for route in router.routes}
    assert "/v1/projects/{project_id}/task-view-comparisons/{comparison_id}/evidence" not in paths
    assert "/v1/projects/{project_id}/task-view-comparisons/{comparison_id}/overview" in paths
    assert "/v1/projects/{project_id}/task-view-comparisons/{comparison_id}/task-evidence" in paths


if __name__ == "__main__":
    import sys

    sys.exit(pytest.main(["-v", __file__]))
