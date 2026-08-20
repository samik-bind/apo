"""The view-scoped run cohort — the shared seam between stats and comparison.

Both ``agent_task_stats.load_run_stat_fields`` (aggregates every matching run
into project stats) and ``task_view_comparison._resolve_side`` (picks the
latest-completed run per task) answer the same domain question:

    *Which runs in this project match this view (model / effort / since),
     scoped to this selection of tasks?*

That question — the cohort — is what this module owns. The JOIN on
``AgentTaskBatchRunDB``, the project / task_ids / model / effort / since
filter conditions, the typed column handles, and the descending ``started_at``
ordering all live here. Consumers project the cohort rows into whatever shape
they need (stats sums; comparison picks) and never re-derive the filter.

Returning a single wide ``ViewRun`` is deliberate: every field any consumer
has needed so far is a scalar, so projecting the union costs microseconds on
the bounded selections comparison and stats actually serve. A JSON or
transcript column would change that calculus — none is included.
"""

# pyright: reportAny=false, reportDeprecated=false, reportPrivateUsage=false

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import cast

from sqlalchemy import desc, or_, select as sa_select
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import Session

from ..db_helpers import _as_column
from ..models.db import AgentTaskBatchRunDB, AgentTaskRunDB
from ..models.schemas import TaskViewConfig


@dataclass(frozen=True, slots=True)
class ViewRun:
    """One run in the cohort, carrying every scalar field any consumer reads.

    Fields are the union of what stats (cost / verdict counters) and
    comparison (run identity + def revision) currently need. Adding a
    consumer that needs another scalar column means adding it here —
    not re-deriving the query.
    """

    run_id: str
    task_id: str
    status: str
    started_at: datetime | None
    completed_at: datetime | None
    total_cost: float | None
    pass_result: bool | None
    total_checks: int
    passed_checks: int
    task_definition_revision_id: str | None


# Typed column handles. The explicit ``ColumnElement[T]`` (not ``[object]``)
# lets the core ``sa_select`` overloads resolve and keeps these columns out of
# the SQLModel ``select`` overload that only accepts full models.
_RUN_ID_COL: ColumnElement[str] = _as_column(cast(object, AgentTaskRunDB.id))
_RUN_TASK_ID_COL: ColumnElement[str] = _as_column(cast(object, AgentTaskRunDB.task_id))
_RUN_STATUS_COL: ColumnElement[str] = _as_column(cast(object, AgentTaskRunDB.status))
_RUN_STARTED_COL: ColumnElement[datetime | None] = _as_column(cast(object, AgentTaskRunDB.started_at))
_RUN_COMPLETED_COL: ColumnElement[datetime | None] = _as_column(cast(object, AgentTaskRunDB.completed_at))
_RUN_TOTAL_COST_COL: ColumnElement[float | None] = _as_column(cast(object, AgentTaskRunDB.total_cost))
_RUN_PASS_RESULT_COL: ColumnElement[bool | None] = _as_column(cast(object, AgentTaskRunDB.pass_result))
_RUN_TOTAL_CHECKS_COL: ColumnElement[int] = _as_column(cast(object, AgentTaskRunDB.total_checks))
_RUN_PASSED_CHECKS_COL: ColumnElement[int] = _as_column(cast(object, AgentTaskRunDB.passed_checks))
_RUN_DEF_REV_COL: ColumnElement[str | None] = _as_column(
    cast(object, AgentTaskRunDB.task_definition_revision_id)
)
_RUN_MODEL_COL: ColumnElement[str | None] = _as_column(cast(object, AgentTaskRunDB.configured_model))
_RUN_EFFORT_COL: ColumnElement[str | None] = _as_column(cast(object, AgentTaskRunDB.configured_effort))
_RUN_BATCH_COL: ColumnElement[str] = _as_column(cast(object, AgentTaskRunDB.batch_run_id))
_BATCH_ID_COL: ColumnElement[str] = _as_column(cast(object, AgentTaskBatchRunDB.id))
_BATCH_PROJECT_COL: ColumnElement[str] = _as_column(cast(object, AgentTaskBatchRunDB.project))


def since_cutoff(since: str | None) -> datetime | None:
    """Resolve a ``since`` preset to a UTC cutoff.

    Accepts ``Nh`` (hours) or ``Nd`` (days), e.g. ``"5h"``, ``"3d"``. Returns
    ``None`` for all-time (no preset / unparseable). Owned here so the cohort
    is the single authority on what a date window means.
    """
    if not since:
        return None
    try:
        if since.endswith("h"):
            return datetime.now(timezone.utc) - timedelta(hours=int(since[:-1]))
        if since.endswith("d"):
            return datetime.now(timezone.utc) - timedelta(days=int(since[:-1]))
    except ValueError:
        pass
    return None


def runs_in_view(
    session: Session,
    project_id: str,
    task_ids: list[str],
    view: TaskViewConfig,
    exclude_model: str | None = None,
) -> list[ViewRun]:
    """Return every run in ``project_id`` matching ``view``, scoped to ``task_ids``.

    The cohort is the set of runs both stats and comparison operate on. It
    is ordered by ``started_at DESC`` so consumers can rely on the first row per
    task being the most recent. Empty ``task_ids`` returns an empty list
    (matches the original guard in both consumers).

    The view filter is interpreted as: ``model`` exact match (None = any),
    ``effort`` exact match (None = any), ``since`` is a ``"Nh"``/``"Nd"``
    window over ``started_at`` (None = all time). Project scoping goes through
    the parent ``AgentTaskBatchRunDB`` so two projects' runs never mix even
    when they share a task id.

    ``exclude_model`` removes one model from an otherwise unpinned ("any
    model") cohort — the superset-vs-member comparison rule (issue #140):
    comparing "all models" against one specific model must resolve the
    unpinned side to *everything else*, or the member's latest run gets
    paired against itself. NULL-model legacy rows are kept: SQL ``!=``
    drops NULLs, so the condition is explicitly NULL-safe. It is ignored
    when ``view.model`` is set (a pinned cohort has no superset problem).
    """
    if not task_ids:
        return []

    conditions: list[ColumnElement[bool]] = [
        _RUN_TASK_ID_COL.in_(task_ids),
        _BATCH_PROJECT_COL == project_id,
    ]
    if view.model is not None:
        conditions.append(_RUN_MODEL_COL == view.model)
    elif exclude_model is not None:
        conditions.append(
            or_(
                _RUN_MODEL_COL != exclude_model,
                _RUN_MODEL_COL.is_(None),
            )
        )
    if view.effort is not None:
        conditions.append(_RUN_EFFORT_COL == view.effort)
    cutoff = since_cutoff(view.since)
    if cutoff is not None:
        conditions.append(_RUN_STARTED_COL >= cutoff)

    stmt = (
        sa_select(
            _RUN_ID_COL,
            _RUN_TASK_ID_COL,
            _RUN_STATUS_COL,
            _RUN_STARTED_COL,
            _RUN_COMPLETED_COL,
            _RUN_TOTAL_COST_COL,
            _RUN_PASS_RESULT_COL,
            _RUN_TOTAL_CHECKS_COL,
            _RUN_PASSED_CHECKS_COL,
            _RUN_DEF_REV_COL,
        )
        .join(AgentTaskBatchRunDB, _RUN_BATCH_COL == _BATCH_ID_COL)
        .where(*conditions)
        .order_by(desc(_RUN_STARTED_COL))
    )

    runs: list[ViewRun] = []
    for (
        run_id,
        task_id,
        status,
        started_at,
        completed_at,
        total_cost,
        pass_result,
        total_checks,
        passed_checks,
        def_rev,
    ) in session.execute(stmt).all():
        runs.append(
            ViewRun(
                run_id=run_id,
                task_id=task_id,
                status=status,
                started_at=started_at,
                completed_at=completed_at,
                total_cost=total_cost,
                pass_result=pass_result,
                total_checks=total_checks,
                passed_checks=passed_checks,
                task_definition_revision_id=def_rev,
            )
        )
    return runs
