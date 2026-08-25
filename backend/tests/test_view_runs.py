"""Direct contract tests for the view-scoped run cohort (B3 deepening).

``runs_in_view`` is the shared seam between ``agent_task_stats`` (aggregates the
cohort) and ``task_view_comparison`` (picks latest-completed-per-task from the
cohort). These tests pin its contract independently of either consumer — the
filtering, scoping, ordering, and row shape that both consumers depend on.

The route-level tests in ``test_task_view_stats.py`` and
``test_task_view_comparison.py`` exercise the cohort transitively; this file
tests it at its own interface so the seam can be evolved without routing
through two layers of FastAPI.
"""

# pyright: reportUnusedCallResult=false, reportUnusedImport=false

from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import Session

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    TaskDefinitionRevisionDB,
    UserDB,
)
from apo.models.schemas import TaskViewConfig
from apo.services.view_runs import ViewRun, runs_in_view, since_cutoff
from tests.conftest import seed_project_for_user

_PROJECT = "proj-cohort"
_OWNER = "owner-cohort"
_TASK_A = "evals/task-a"
_TASK_B = "evals/task-b"


def _seed_cohort(session: Session) -> datetime:
    """Seed a project with runs that vary along model / effort / started_at.

    Returns the anchor ``now`` so tests can build time-window assertions
    against the same clock the seed used.
    """
    now = datetime.now(timezone.utc)
    session.add(UserDB(id=_OWNER, email="owner-cohort@test", name="Owner", password_hash="x"))
    session.flush()
    seed_project_for_user(session, _OWNER, project_id=_PROJECT)

    session.add(
        AgentTaskBatchRunDB(
            id="batch-cohort",
            project=_PROJECT,
            created_at=now,
            status="completed",
            total_tasks=4,
            task_root="/t",
            environment="default",
            selection_type="task",
        )
    )
    session.flush()
    # one definition revision referenced by every seeded run; comparison's
    # wide-row test asserts the cohort carries this through unchanged.
    session.add(
        TaskDefinitionRevisionDB(
            id="d1",
            project=_PROJECT,
            task_id=_TASK_A,
            content_sha256="a" * 64,
            source_size_bytes=1,
        )
    )
    session.flush()

    def _run(
        rid: str,
        task: str,
        model: str,
        effort: str | None,
        started_at: datetime,
        status: str = "passed",
        pass_result: bool = True,
        total_cost: float | None = 0.01,
        total_checks: int = 1,
        passed_checks: int = 1,
        def_rev: str | None = "d1",
    ) -> AgentTaskRunDB:
        return AgentTaskRunDB(
            id=rid,
            batch_run_id="batch-cohort",
            task_id=task,
            task_path=f"/t/{task}",
            status=status,
            pass_result=pass_result,
            configured_model=model,
            configured_effort=effort,
            started_at=started_at,
            completed_at=started_at,
            total_cost=total_cost,
            total_checks=total_checks,
            passed_checks=passed_checks,
            task_definition_revision_id=def_rev,
        )

    # task-a: opus+high (old + recent) and deepseek+low (recent)
    session.add(_run("a-opus-old", _TASK_A, "claude-opus", "high", now - timedelta(days=3)))
    session.add(_run("a-opus-new", _TASK_A, "claude-opus", "high", now - timedelta(hours=1)))
    session.add(_run("a-deep", _TASK_A, "deepseek", "low", now - timedelta(hours=1)))
    # task-b: opus+medium only (so cohort narrows when scoped to task-a)
    session.add(_run("b-opus", _TASK_B, "claude-opus", "medium", now - timedelta(hours=2)))
    session.commit()
    return now


def test_runs_in_view_filters_by_model(session: Session) -> None:
    """A view with model=claude-opus excludes runs under other models."""
    _seed_cohort(session)
    runs = runs_in_view(
        session,
        project_id=_PROJECT,
        task_ids=[_TASK_A, _TASK_B],
        view=TaskViewConfig(model="claude-opus"),
    )
    # opus ran for task-a (twice: old + new) and task-b (once) -> 3 opus runs.
    # deepseek-v3 run on task-a is excluded by the model filter.
    assert len(runs) == 3
    assert all(r.task_id in {_TASK_A, _TASK_B} for r in runs)


def test_runs_in_view_filters_by_effort(session: Session) -> None:
    """Effort narrows within a model: opus+high yields only task-a's two runs."""
    _seed_cohort(session)
    runs = runs_in_view(
        session,
        project_id=_PROJECT,
        task_ids=[_TASK_A, _TASK_B],
        view=TaskViewConfig(model="claude-opus", effort="high"),
    )
    # task-a has two opus+high runs; task-b's opus run was medium -> excluded.
    assert len(runs) == 2
    assert all(r.task_id == _TASK_A for r in runs)


def test_runs_in_view_filters_by_since(session: Session) -> None:
    """A short since= window excludes runs older than the cutoff."""
    _seed_cohort(session)
    runs = runs_in_view(
        session,
        project_id=_PROJECT,
        task_ids=[_TASK_A, _TASK_B],
        view=TaskViewConfig(since="1d"),
    )
    # The 3-day-old a-opus-old run is excluded; the three recent runs survive.
    assert len(runs) == 3
    run_ids = {r.run_id for r in runs}
    assert "a-opus-old" not in run_ids
    assert run_ids == {"a-opus-new", "a-deep", "b-opus"}


def test_since_cutoff_rejects_out_of_range_window() -> None:
    """A malformed URL filter must not turn a listing request into a 500."""
    assert since_cutoff("999999999999999999d") is None


def test_runs_in_view_scopes_to_task_ids(session: Session) -> None:
    """A task_ids selection narrows the cohort to runs for those tasks only."""
    _seed_cohort(session)
    runs = runs_in_view(
        session,
        project_id=_PROJECT,
        task_ids=[_TASK_B],
        view=TaskViewConfig(),
    )
    # Only task-b's single opus run matches an unfiltered view scoped to [task-b].
    assert len(runs) == 1
    assert runs[0].task_id == _TASK_B
    assert runs[0].run_id == "b-opus"


def test_runs_in_view_excludes_other_projects_runs(session: Session) -> None:
    """A run with the same task_id in a different project is not in the cohort."""
    now = _seed_cohort(session)
    # same task_id, different project, in its own batch
    session.add(UserDB(id="owner-other", email="other@test", name="Other", password_hash="x"))
    session.flush()
    seed_project_for_user(session, "owner-other", project_id="proj-other")
    session.add(
        AgentTaskBatchRunDB(
            id="batch-other",
            project="proj-other",
            created_at=now,
            status="completed",
            total_tasks=1,
            task_root="/t",
            environment="default",
            selection_type="task",
        )
    )
    session.flush()
    session.add(
        AgentTaskRunDB(
            id="a-other-project",
            batch_run_id="batch-other",
            task_id=_TASK_A,
            task_path=f"/t/{_TASK_A}",
            status="passed",
            pass_result=True,
            configured_model="claude-opus",
            configured_effort="high",
            started_at=now,
            completed_at=now,
        )
    )
    session.commit()

    runs = runs_in_view(
        session,
        project_id=_PROJECT,
        task_ids=[_TASK_A, _TASK_B],
        view=TaskViewConfig(),
    )
    # The other-project run is excluded even though it shares task_a.
    assert all(r.run_id != "a-other-project" for r in runs)


def test_runs_in_view_orders_by_started_at_desc(session: Session) -> None:
    """Most recent run first — both consumers rely on this ordering."""
    _seed_cohort(session)
    runs = runs_in_view(
        session,
        project_id=_PROJECT,
        task_ids=[_TASK_A, _TASK_B],
        view=TaskViewConfig(),
    )
    started = [r.started_at for r in runs]
    assert started == sorted(started, reverse=True)  # pyright: ignore[reportArgumentType]
    # The very first row is one of the runs seeded at now - 1h (the most recent).
    assert started[0] is not None


def test_runs_in_view_returns_wide_row_shape(session: Session) -> None:
    """ViewRun carries every field any current consumer reads.

    Stats reads: status / started_at / completed_at / total_cost / pass_result
                 / total_checks / passed_checks.
    Comparison reads: run_id / task_id / status / started_at
                      / task_definition_revision_id.
    Union = 10 fields. This test pins the row shape so a future field rename
    fails loudly here, not silently in a consumer.
    """
    _seed_cohort(session)
    runs = runs_in_view(
        session,
        project_id=_PROJECT,
        task_ids=[_TASK_A],
        view=TaskViewConfig(model="deepseek", effort="low"),
    )
    assert len(runs) == 1
    run: ViewRun = runs[0]
    assert run.run_id == "a-deep"
    assert run.task_id == _TASK_A
    assert run.status == "passed"
    assert run.pass_result is True
    assert run.total_cost == 0.01
    assert run.total_checks == 1
    assert run.passed_checks == 1
    assert run.task_definition_revision_id == "d1"
    assert run.started_at is not None
    assert run.completed_at is not None
