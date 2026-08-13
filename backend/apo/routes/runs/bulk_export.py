# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false

"""Bulk export query and serialization for runs.

The route handler owns HTTP concerns (format dispatch, JSONResponse
wrapping, CSV header). Everything from the DB fetch through the per-run
serialization lives here so it is testable without going through
FastAPI.
"""

import csv
import json
from io import StringIO
from typing import cast

from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import asc
from sqlmodel import Session, select

from ...models import LoggedCall, LoggedCallDB, Run, RunMetric, RunMetricDB, RunDB
from .columns import (
    LOGGED_CALL_CREATED_AT_COL,
    LOGGED_CALL_PROJECT_COL,
    LOGGED_CALL_RUN_ID_COL,
    LOGGED_CALL_STEP_INDEX_COL,
    RUN_ID_COL,
    RUN_METRIC_PROJECT_COL,
    RUN_METRIC_RUN_ID_COL,
    RUN_PROJECT_COL,
)

_CSV_COLUMNS = [
    "Run ID",
    "Project",
    "Flow Name",
    "Task ID",
    "Version",
    "Environment",
    "Created At",
    "Completed At",
    "Duration (ms)",
    "Call Count",
    "Tags",
    "Metrics Count",
]


class BulkExportRequest(BaseModel):
    run_ids: list[str]
    format: str = "json"


def export_runs(
    session: Session,
    run_ids: list[str],
    project: str,
    fmt: str,
) -> JSONResponse:
    if not run_ids:
        return JSONResponse(
            status_code=400,
            content={"detail": "No run IDs provided"},
        )

    runs_data = collect_runs_for_export(session, run_ids, project)

    if fmt == "csv":
        return _render_csv(runs_data, len(run_ids))
    return _render_json(runs_data, len(run_ids))


def collect_runs_for_export(
    session: Session,
    run_ids: list[str],
    project: str,
) -> list[dict[str, object]]:
    """Fetch runs + related metrics/calls and serialize to export dicts.

    Runs are returned in the order of ``run_ids``; ids not found in the
    database (or outside ``project``) are silently skipped — matching the
    original route handler's behaviour.
    """
    runs_in_db = session.exec(
        select(RunDB).where(RUN_ID_COL.in_(run_ids), RUN_PROJECT_COL == project)
    ).all()
    run_id_map = {r.id: r for r in runs_in_db}
    export_run_ids = [rid for rid in run_ids if rid in run_id_map]

    metrics_by_run = _load_metrics_by_run(session, export_run_ids, project)
    calls_by_run = _load_calls_by_run(session, export_run_ids, project)

    return [
        {
            "run": Run.model_validate(run_id_map[rid]).model_dump(by_alias=True),
            "metrics": [
                RunMetric.model_validate(m).model_dump(by_alias=True)
                for m in metrics_by_run.get(rid, [])
            ],
            "calls": [
                LoggedCall.model_validate(c, from_attributes=True).model_dump(
                    by_alias=True
                )
                for c in calls_by_run.get(rid, [])
            ],
        }
        for rid in export_run_ids
    ]


def _load_metrics_by_run(
    session: Session, run_ids: list[str], project: str
) -> dict[str, list[RunMetricDB]]:
    if not run_ids:
        return {}
    rows = session.exec(
        select(RunMetricDB).where(
            RUN_METRIC_RUN_ID_COL.in_(run_ids),
            RUN_METRIC_PROJECT_COL == project,
        )
    ).all()
    result: dict[str, list[RunMetricDB]] = {}
    for m in rows:
        if m.run_id is not None:
            result.setdefault(m.run_id, []).append(m)
    return result


def _load_calls_by_run(
    session: Session, run_ids: list[str], project: str
) -> dict[str, list[LoggedCallDB]]:
    if not run_ids:
        return {}
    rows = session.exec(
        select(LoggedCallDB)
        .where(
            LOGGED_CALL_RUN_ID_COL.in_(run_ids),
            LOGGED_CALL_PROJECT_COL == project,
        )
        .order_by(
            asc(LOGGED_CALL_STEP_INDEX_COL).nulls_last(),
            asc(LOGGED_CALL_CREATED_AT_COL),
        )
    ).all()
    result: dict[str, list[LoggedCallDB]] = {}
    for c in rows:
        if c.run_id is not None:
            result.setdefault(c.run_id, []).append(c)
    return result


def _render_csv(
    runs_data: list[dict[str, object]], count: int
) -> JSONResponse:
    output = StringIO()
    writer = csv.writer(output)
    writer.writerow(_CSV_COLUMNS)

    for run_item in runs_data:
        run = cast(dict[str, object], run_item["run"])
        metrics = cast(list[object], run_item["metrics"])
        tags_value = run.get("tags")
        tags: list[object] = (
            cast(list[object], tags_value) if isinstance(tags_value, list) else []
        )
        writer.writerow(
            [
                run.get("id"),
                run.get("project"),
                run.get("flow_name") or "",
                run.get("task_id") or "",
                run.get("version") or "",
                run.get("environment") or "",
                run.get("created_at") or "",
                run.get("completed_at") or "",
                run.get("duration_ms") or "",
                run.get("call_count") or 0,
                ",".join(str(tag) for tag in tags),
                len(metrics),
            ]
        )

    return JSONResponse(
        content={
            "data": output.getvalue(),
            "filename": f"runs_export_{count}_runs.csv",
            "media_type": "text/csv",
        }
    )


def _render_json(
    runs_data: list[dict[str, object]], count: int
) -> JSONResponse:
    return JSONResponse(
        content={
            "data": json.dumps(runs_data, indent=2, default=str),
            "filename": f"runs_export_{count}_runs.json",
            "media_type": "application/json",
        }
    )
