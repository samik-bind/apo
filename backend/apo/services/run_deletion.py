"""Manual Task Run / Batch Run deletion.

The route-facing orchestration for the DELETE endpoints: remove stored
objects first (Deliverable artifacts, Task Revision bundles) while their
storage keys are still resolvable — a store failure raises a retryable 503
so rows are never orphaned — then drop rows through the shared cascade in
``retention`` (children first, pragma-independent), delete the trace a run
owns, and finally fix up the parent Batches (rollup recompute, removal of
emptied Batches).

Task Definition Revisions are deliberately NOT deleted: they are
content-addressed and deduplicated across runs — the run's FK column dies
with the run row, the shared revision stays.
"""

from __future__ import annotations

from typing import Any, cast

# pyright: reportAny=false, reportDeprecated=false, reportExplicitAny=false, reportImplicitStringConcatenation=false, reportPrivateLocalImportUsage=false, reportUnusedCallResult=false

from sqlalchemy import bindparam, text
from sqlalchemy.engine import CursorResult
from sqlmodel import Session

from fastapi import HTTPException

from ..db_helpers import table_exists
from ..models.db import AgentTaskBatchRunDB, AgentTaskRunDB
from .retention import (
    delete_agent_task_rows,
    delete_batch_rows,
    delete_deliverable_objects_for_runs,
)


def _exec_in(session: Session, sql: str, params: dict[str, Any]) -> int:
    """Run one ``IN :ids`` statement (expanding bindparam) and return rowcount."""
    stmt = text(sql).bindparams(bindparam("ids", expanding=True))
    result = cast(CursorResult[Any], session.execute(stmt, params))
    return result.rowcount or 0


def _delete_trace_projection(
    session: Session, project: str, run_ids: list[str], trace_ids: list[str]
) -> dict[str, int]:
    """Delete the trace a Task Run owns: ``runs`` and all its children.

    Scoped by project so a shared OTel trace id cannot delete another
    project's metrics or calls (mirrors the ``/v1/runs/bulk-delete`` guard).
    The run link (``runs.task_run_id``) and the run row's own backlink
    (``agent_task_runs.trace_run_id``) are both followed — either may be
    missing on legacy rows.
    """
    if not run_ids and not trace_ids:
        return {"deleted_traces": 0, "deleted_calls": 0}

    # Resolve the full trace-id set from both links before any row goes.
    resolved = set(trace_ids)
    if run_ids:
        rows = session.execute(
            text(
                "SELECT id FROM runs WHERE project = :p AND task_run_id IN :ids"
            ).bindparams(bindparam("ids", expanding=True)),
            {"p": project, "ids": run_ids},
        ).all()
        resolved.update(row[0] for row in rows)
    if not resolved:
        # No trace id anywhere: still drop the soft ingest reference and any
        # projection row linked only by task_run_id.
        traces = _exec_in(
            session,
            "DELETE FROM runs WHERE project = :p AND task_run_id IN :ids",
            {"p": project, "ids": run_ids},
        )
        _exec_in(
            session,
            "UPDATE otlp_ingest_batches SET verified_task_run_id = NULL "
            "WHERE verified_task_run_id IN :ids",
            {"ids": run_ids},
        )
        return {"deleted_traces": traces, "deleted_calls": 0}

    trace_id_list = sorted(resolved)
    calls = 0
    if table_exists(session, "call_metrics"):
        calls += _exec_in(
            session,
            "DELETE FROM call_metrics WHERE project = :p AND call_id IN "
            "(SELECT id FROM logged_calls WHERE project = :p AND run_id IN :ids)",
            {"p": project, "ids": trace_id_list},
        )
    if table_exists(session, "logged_calls"):
        calls += _exec_in(
            session,
            "DELETE FROM logged_calls WHERE project = :p AND run_id IN :ids",
            {"p": project, "ids": trace_id_list},
        )
    if table_exists(session, "run_metrics"):
        _exec_in(
            session,
            "DELETE FROM run_metrics WHERE project = :p AND run_id IN :ids",
            {"p": project, "ids": trace_id_list},
        )
    if table_exists(session, "otlp_spans"):
        _exec_in(
            session,
            "DELETE FROM otlp_spans WHERE project_id = :p AND trace_id IN :ids",
            {"p": project, "ids": trace_id_list},
        )
    traces = _exec_in(
        session,
        "DELETE FROM runs WHERE project = :p AND id IN :ids",
        {"p": project, "ids": trace_id_list},
    )
    if run_ids:
        traces += _exec_in(
            session,
            "DELETE FROM runs WHERE project = :p AND task_run_id IN :ids",
            {"p": project, "ids": run_ids},
        )
        _exec_in(
            session,
            "UPDATE otlp_ingest_batches SET verified_task_run_id = NULL "
            "WHERE verified_task_run_id IN :ids",
            {"ids": run_ids},
        )
    return {"deleted_traces": traces, "deleted_calls": calls}


async def _delete_deliverable_objects_guarded(
    session: Session, run_ids: list[str]
) -> None:
    """Object cleanup first; a store failure keeps every row for retry."""
    if not run_ids:
        return
    try:
        await delete_deliverable_objects_for_runs(session, run_ids)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "artifact storage cleanup failed; the run was kept — retry deletion"
            ),
        ) from exc


async def delete_task_runs(
    session: Session, task_runs: list[AgentTaskRunDB]
) -> dict[str, int]:
    """Delete Task Runs and their traces outright, then fix up their Batches.

    The caller has already authorized the action and verified each run is
    terminal or cancelled. Batches whose last run goes away are removed with
    their Revision bundles; partially-emptied Batches get their rollups
    recomputed from the remaining runs.
    """
    if not task_runs:
        return {
            "deleted_runs": 0,
            "deleted_traces": 0,
            "deleted_calls": 0,
            "deleted_batches": 0,
        }

    run_ids = [run.id for run in task_runs]
    batches = {
        run.batch_run_id: session.get(AgentTaskBatchRunDB, run.batch_run_id)
        for run in task_runs
    }
    live_batches = [batch for batch in batches.values() if batch is not None]
    if not live_batches:
        raise ValueError("Task run has no live Batch row; refusing blind delete")
    project = live_batches[0].project

    await _delete_deliverable_objects_guarded(session, run_ids)

    trace_ids = [run.trace_run_id for run in task_runs if run.trace_run_id]
    trace_counts = _delete_trace_projection(session, project, run_ids, trace_ids)
    _ = delete_agent_task_rows(session, run_ids)

    deleted_batches = 0
    from .agent_task_runner import update_batch_run_status
    from .task_revisions import delete_task_revision_bundles_for_batches

    for batch_id, batch in batches.items():
        if batch is None:
            continue
        remaining = session.execute(
            text("SELECT COUNT(*) FROM agent_task_runs WHERE batch_run_id = :b"),
            {"b": batch_id},
        ).scalar()
        if remaining == 0:
            await delete_task_revision_bundles_for_batches(session, [batch_id])
            # delete_batch_rows detaches schedule references itself.
            deleted_batches += delete_batch_rows(session, [batch_id])
        else:
            update_batch_run_status(session, batch)

    session.commit()
    return {
        "deleted_runs": len(run_ids),
        "deleted_batches": deleted_batches,
        **trace_counts,
    }


async def delete_batch_runs(
    session: Session, batches: list[AgentTaskBatchRunDB]
) -> dict[str, int]:
    """Delete whole Batch Runs: every Task Run, trace, and bundle they own.

    The caller has already authorized the action and verified each batch is
    terminal or cancelled.
    """
    if not batches:
        return {
            "deleted_runs": 0,
            "deleted_traces": 0,
            "deleted_calls": 0,
            "deleted_batches": 0,
        }

    batch_ids = [batch.id for batch in batches]
    project = batches[0].project

    run_rows = session.execute(
        text(
            "SELECT id, trace_run_id FROM agent_task_runs WHERE batch_run_id IN :ids"
        ).bindparams(bindparam("ids", expanding=True)),
        {"ids": batch_ids},
    ).all()
    run_ids = [row[0] for row in run_rows]
    trace_ids = [row[1] for row in run_rows if row[1]]

    from .task_revisions import delete_task_revision_bundles_for_batches

    await _delete_deliverable_objects_guarded(session, run_ids)
    await delete_task_revision_bundles_for_batches(session, batch_ids)

    trace_counts = _delete_trace_projection(session, project, run_ids, trace_ids)
    _ = delete_agent_task_rows(session, run_ids)
    _ = delete_batch_rows(session, batch_ids)

    session.commit()
    return {
        "deleted_runs": len(run_ids),
        "deleted_batches": len(batch_ids),
        **trace_counts,
    }
