# pyright: reportCallInDefaultInitializer=false, reportPrivateUsage=false, reportUnusedCallResult=false

from datetime import datetime, timezone
from typing import cast
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import asc, delete
from sqlmodel import Session, select

from ...db import get_session
from ...auth.deps import require_api_key_scope
from ...services.project_memberships import (
    enforce_project_read_from_request,
    enforce_project_role_from_request,
    list_readable_projects_from_request,
)
from ...db_helpers import _as_column, _ensure_utc_datetime
from ...models import (
    AgentTaskRunDB,
    RunDB,
    RunMetricDB,
    LoggedCallDB,
    Run,
    RunMetric,
    RunDetail,
    CreateRunRequest,
    UpdateRunRequest,
    LoggedCall,
    CorrectionRequest,
)
from ...metrics import calculate_and_store_aggregate_metrics
from ...services.demo_workspace import require_project_not_demo, require_run_not_demo
from .bulk_export import BulkExportRequest, export_runs
from .columns import (
    CALL_LIGHT,
    LOGGED_CALL_CREATED_AT_COL,
    LOGGED_CALL_STEP_INDEX_COL,
    RUN_ID_COL,
    RUN_METRIC_PROJECT_COL,
    RUN_PROJECT_COL,
)
from .list_query import (
    PaginatedRunSummary,
    RunListFilters,
    RunListPagination,
    list_run_summaries,
)
from .metrics import calculate_run_metrics_from_calls

router = APIRouter(prefix="/v1/runs", tags=["runs"])


@router.patch("/{run_id}/bookmark")
def toggle_bookmark(run_id: str, http_request: Request, session: Session = Depends(get_session)):
    """Toggle bookmark state for a run."""
    run = require_run_not_demo(session, run_id)
    # SPEC-178: require member on the derived Project.
    enforce_project_read_from_request(http_request, session, run.project)
    run.bookmarked = not run.bookmarked
    session.commit()
    session.refresh(run)

    return {"id": run.id, "bookmarked": run.bookmarked}


@router.post("", response_model=Run)
def create_run(request: CreateRunRequest, http_request: Request, session: Session = Depends(get_session)):
    require_project_not_demo(request.project)
    # SPEC-178: require member on the target Project.
    enforce_project_read_from_request(http_request, session, request.project)
    run_id = str(uuid4())

    run = RunDB(
        id=run_id,
        project=request.project,
        task_id=request.task_id,
        flow_name=request.flow_name,
        version=request.version,
        user_id=request.user_id,
        session_id=request.session_id,
        environment=request.environment,
        external_id=request.external_id,
        tags=request.tags or [],
        run_metadata=request.run_metadata,
        primary_model=request.primary_model,
    )

    session.add(run)
    session.commit()
    session.refresh(run)

    return Run.model_validate(run)


@router.patch("/{run_id}", response_model=Run)
def update_run(
    run_id: str,
    request: UpdateRunRequest,
    http_request: Request,
    session: Session = Depends(get_session),
):
    run = require_run_not_demo(session, run_id)

    _validate_trace_write_access(http_request, session, run_id, run.project)
    # SPEC-178: for non-service-token callers, require member on the derived Project.
    if getattr(http_request.state, "auth_method", None) != "service_token":
        enforce_project_read_from_request(http_request, session, run.project)

    if request.completed:
        run.completed_at = datetime.now(timezone.utc)
        if run.created_at:
            duration = (
                _ensure_utc_datetime(run.completed_at)
                - _ensure_utc_datetime(run.created_at)
            ).total_seconds() * 1000
            run.duration_ms = duration

        aggregate_metrics = calculate_and_store_aggregate_metrics(session, run.id, run.project)
        for metric in aggregate_metrics:
            session.add(metric)

    if request.call_count is not None:
        run.call_count = request.call_count

    session.commit()
    session.refresh(run)

    return Run.model_validate(run)


def _validate_trace_write_access(
    request: Request, session: Session, run_id: str, run_project: str
) -> None:
    if getattr(request.state, "auth_method", None) != "service_token":
        return
    token_project = getattr(request.state, "project", None)
    if token_project != run_project:
        raise HTTPException(status_code=403, detail="Service token project mismatch")
    # SPEC-178: the token is a capability for ONE task run, not a Project-wide
    # write pass. The run being patched must be the trace that task run
    # claimed at ingestion.
    token_task_run_id = getattr(request.state, "service_task_run_id", None)
    task_run = (
        session.get(AgentTaskRunDB, token_task_run_id)
        if isinstance(token_task_run_id, str)
        else None
    )
    if task_run is None or task_run.trace_run_id != run_id:
        raise HTTPException(status_code=403, detail="Service token run mismatch")


def _enforce_project_read(request: Request, session: Session, project: str) -> None:
    """Scope a read to a project the caller belongs to.

    The runs/trace read endpoints accept a caller-supplied ``project`` query
    param and filter by it, but previously only checked API-key *scope* — so
    any authenticated user (dashboard or API key) could read another
    project's traces by passing ``?project=<other>``. This mirrors the
    membership enforcement the agent-task-run endpoints already apply.
    Dev/open mode (no ``user_id`` on the request) stays permissive, as the
    membership helper does elsewhere.
    """
    _ = enforce_project_read_from_request(request, session, project)


def _caller_project_scope(request: Request, session: Session) -> list[str] | None:
    """The project ids a caller may read across, or ``None`` for unscoped.

    Returns ``None`` in dev/open mode (no ``user_id`` on the request), where
    the membership system is not active — matching the permissive fallback in
    ``enforce_project_role_from_request``. Otherwise returns exactly the
    projects the caller is a member of, so an unscoped list/aggregate can't
    span tenants.
    """
    return list_readable_projects_from_request(request, session)


def _split_csv(value: str | None) -> list[str]:
    return [s.strip() for s in (value or "").split(",") if s.strip()]


@router.get("", response_model=PaginatedRunSummary)
def list_runs(
    http_request: Request,
    project: str | None = None,
    flow_name: str | None = Query(None, description="Comma-separated flow_name list"),
    page: int = Query(0, ge=0, description="Page number (0-indexed)"),
    page_size: int = Query(
        40, ge=1, le=100, description="Number of items per page (max 100)"
    ),
    environment: str | None = Query(None, description="Comma-separated environment list"),
    session_id: str | None = Query(None, description="Comma-separated session ID list"),
    user_id: str | None = Query(None, description="Comma-separated user ID list"),
    tags: str | None = Query(None, description="Comma-separated tag list"),
    models: str | None = Query(None, description="Comma-separated model list"),
    metric_name: str | None = Query(None, description="Filter by metric name"),
    min_score: float | None = Query(None, description="Minimum metric score"),
    max_score: float | None = Query(None, description="Maximum metric score"),
    search: str | None = Query(None, description="Search by run_id or external_id"),
    min_duration_ms: float | None = None,
    max_duration_ms: float | None = None,
    created_after: str | None = Query(None, description="ISO 8601 datetime"),
    created_before: str | None = Query(None, description="ISO 8601 datetime"),
    sort_by: str | None = Query(None, description="Sort field: created_at, duration_ms, call_count"),
    sort_order: str | None = Query("desc", description="Sort direction: asc or desc"),
    status: str | None = Query(None, description="Comma-separated status list: success, warning, error"),
    bookmarked: bool | None = Query(None, description="Filter bookmarked traces"),
    session: Session = Depends(get_session),
    _: None = Depends(require_api_key_scope("full")),
):
    # Auth: pin to one project (membership-checked) or restrict to the caller's
    # readable projects. Dev/open mode (no user_id) stays unscoped.
    if project:
        _enforce_project_read(http_request, session, project)
        allowed_projects: list[str] | None = None
    else:
        allowed_projects = _caller_project_scope(http_request, session)

    return list_run_summaries(
        session,
        RunListFilters(
            project=project,
            allowed_projects=allowed_projects,
            flow_names=_split_csv(flow_name),
            environments=_split_csv(environment),
            session_ids=_split_csv(session_id),
            user_ids=_split_csv(user_id),
            models=_split_csv(models),
            tags=tags,
            search=search,
            metric_name=metric_name,
            min_score=min_score,
            max_score=max_score,
            min_duration_ms=min_duration_ms,
            max_duration_ms=max_duration_ms,
            created_after=created_after,
            created_before=created_before,
            status_values=_split_csv(status),
            bookmarked=bookmarked,
        ),
        RunListPagination(
            page=page, page_size=page_size, sort_by=sort_by, sort_order=sort_order
        ),
    )


# The distinct-* endpoints power the dashboard's global filter dropdowns and
# previously scanned every tenant's rows unscoped, leaking the full list of
# project names, task ids, models, and metric names to any authenticated
# caller. They now aggregate only over the caller's own projects (unscoped in
# dev/open mode, where the membership system is inactive).


@router.get("/distinct-projects")
def get_distinct_projects(
    http_request: Request, session: Session = Depends(get_session)
):
    allowed = _caller_project_scope(http_request, session)
    if allowed is not None:
        return sorted(allowed)
    # session.exec(select(col)) yields scalars, so index [0] would return the
    # first character of each name — return the values themselves.
    return list(session.exec(select(RunDB.project).distinct()).all())


@router.get("/distinct-tasks")
def get_distinct_tasks(
    http_request: Request, session: Session = Depends(get_session)
):
    allowed = _caller_project_scope(http_request, session)
    statement = select(RunDB.task_id).distinct().where(RunDB.task_id != None)
    if allowed is not None:
        statement = statement.where(RUN_PROJECT_COL.in_(allowed))
    tasks = session.exec(statement).all()
    return [task_id for task_id in tasks if task_id is not None]


@router.get("/distinct-models")
def get_distinct_models(
    http_request: Request, session: Session = Depends(get_session)
):
    allowed = _caller_project_scope(http_request, session)
    statement = (
        select(RunDB.primary_model).distinct().where(RunDB.primary_model != None)
    )
    if allowed is not None:
        statement = statement.where(RUN_PROJECT_COL.in_(allowed))
    models = session.exec(statement).all()
    return [model for model in models if model is not None]


@router.get("/distinct-metrics")
def get_distinct_metrics(
    http_request: Request, session: Session = Depends(get_session)
):
    allowed = _caller_project_scope(http_request, session)
    statement = select(RunMetricDB.metric_name).distinct()
    if allowed is not None:
        statement = statement.where(RUN_METRIC_PROJECT_COL.in_(allowed))
    # Scalars, not rows — see get_distinct_projects.
    return list(session.exec(statement).all())


@router.get("/{run_id}")
def get_run_details(
    run_id: str,
    http_request: Request,
    project: str = "default",
    include: str | None = Query(default=None),
    session: Session = Depends(get_session),
    _: None = Depends(require_api_key_scope("full")),
):
    _enforce_project_read(http_request, session, project)
    run = session.exec(
        select(RunDB).where(RunDB.id == run_id, RunDB.project == project)
    ).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    calls_query = select(
        LoggedCallDB
    ).where(
        LoggedCallDB.run_id == run_id,
        LoggedCallDB.project == project,
    ).order_by(
        asc(LOGGED_CALL_STEP_INDEX_COL).nulls_last(),
        asc(LOGGED_CALL_CREATED_AT_COL),
    )

    # Issue #142/#143 audit: the trace DETAIL page renders call messages
    # in expand panels, not all at once. Defer the heaviest columns so they
    # lazy-load only when a panel is opened. This cuts the base payload from
    # MB-scale (50-200 calls × full input/output/messages/tool_result) to
    # scalar-level metadata.
    if not (include and "messages" in include):
        calls_query = calls_query.options(*CALL_LIGHT)

    calls = session.exec(calls_query).all()

    stored_metrics = session.exec(
        select(RunMetricDB).where(
            RunMetricDB.run_id == run_id,
            RunMetricDB.project == project,
        )
    ).all()

    aggregate_metrics = calculate_run_metrics_from_calls(list(calls), run_id)

    metrics_dict: dict[str, RunMetricDB] = {}
    for metric in stored_metrics:
        metrics_dict[metric.metric_name] = metric
    for metric in aggregate_metrics:
        metrics_dict[metric.metric_name] = metric

    all_metrics = list(metrics_dict.values())

    calls_models: list[LoggedCall] = [
        LoggedCall.model_validate(call, from_attributes=True) for call in calls
    ]

    # `messages` duplicates content already present in each call's input/output
    # (the projector copies input.messages + output.messages verbatim), which
    # roughly doubles the response for agentic traces. Ship it only on opt-in
    # (?include=messages — the CLI's `traces show --verbose` uses it); the
    # dashboard renders from input/output and never reads it.
    exclude = (
        None
        if include and "messages" in include
        else {"calls": {"__all__": {"messages"}}}
    )

    return RunDetail(
        run=Run.model_validate(run),
        metrics=[RunMetric.model_validate(m) for m in all_metrics],
        calls=calls_models,
    ).model_dump(by_alias=True, exclude=exclude)


class CustomMetricResult(BaseModel):
    name: str
    score: float
    error: str | None = None


class PostCustomMetricsRequest(BaseModel):
    metrics: list[CustomMetricResult]


@router.post("/{run_id}/custom-metrics")
async def post_custom_metrics(
    run_id: str,
    request: PostCustomMetricsRequest,
    http_request: Request,
    session: Session = Depends(get_session),
):
    _run = require_run_not_demo(session, run_id)
    # SPEC-178: require member on the derived Project.
    enforce_project_read_from_request(http_request, session, _run.project)

    results_count = 0
    errors: list[dict[str, str]] = []
    for metric_result in request.metrics:
        try:
            metric_db = RunMetricDB(
                run_id=run_id,
                # SPEC-178: stamp the derived Project — the column default
                # would silently file the metric under "default".
                project=_run.project,
                metric_name=metric_result.name,
                metric_type="quality",
                score=metric_result.score,
                data_type="NUMERIC",
                source="API",
                reasoning=None
                if not metric_result.error
                else f"Error: {metric_result.error}",
                meta={"sdk_custom": True, "error": metric_result.error}
                if metric_result.error
                else {"sdk_custom": True},
            )
            session.add(metric_db)
            results_count += 1
        except Exception as e:
            errors.append({"name": metric_result.name, "error": str(e)})

    session.commit()

    return {
        "status": "success" if not errors else "partial",
        "run_id": run_id,
        "metrics_stored": results_count,
        "errors": errors if errors else None,
    }


@router.patch("/{run_id}/calls/{call_id}/correction")
def set_corrected_output(
    run_id: str,
    call_id: str,
    request: CorrectionRequest,
    http_request: Request,
    project: str = "default",
    session: Session = Depends(get_session),
):
    """Set or clear the corrected output for a call."""
    # SPEC-178: require member on the target Project.
    enforce_project_read_from_request(http_request, session, project)
    _run = require_run_not_demo(session, run_id, project)
    call = session.exec(
        select(LoggedCallDB).where(
            LoggedCallDB.id == call_id, LoggedCallDB.project == project
        )
    ).first()
    if not call:
        raise HTTPException(status_code=404, detail="Call not found")
    if call.run_id != run_id:
        raise HTTPException(status_code=400, detail="Call does not belong to this run")

    call.corrected_output = request.corrected_output
    session.commit()
    session.refresh(call)

    return {"id": call.id, "corrected_output": call.corrected_output}


class BulkDeleteRequest(BaseModel):
    run_ids: list[str]


@router.post("/bulk-delete")
def bulk_delete_runs(
    request: BulkDeleteRequest,
    http_request: Request,
    project: str = "default",
    session: Session = Depends(get_session),
):
    # SPEC-178: require admin for bulk destructive operations.
    enforce_project_role_from_request(http_request, session, project, minimum_role="admin")
    if not request.run_ids:
        raise HTTPException(status_code=400, detail="No run IDs provided")

    existing_runs = session.exec(
        select(RunDB).where(
            RUN_ID_COL.in_(request.run_ids), RUN_PROJECT_COL == project
        )
    ).all()

    run_id_map = {r.id: r for r in existing_runs}
    missing_run_ids = set(request.run_ids) - set(run_id_map)

    if missing_run_ids:
        raise HTTPException(
            status_code=404, detail=f"Runs not found: {', '.join(missing_run_ids)}"
        )

    for run in existing_runs:
        require_project_not_demo(run.project)

    # Scope cascade deletes by project so a shared OTel id cannot delete another
    # project's metrics/calls.
    deleted_metrics = session.exec(
        delete(RunMetricDB).where(
            _as_column(cast(object, RunMetricDB.run_id)).in_(request.run_ids),
            _as_column(cast(object, RunMetricDB.project)) == project,
        )
    )

    deleted_calls = session.exec(
        delete(LoggedCallDB).where(
            _as_column(cast(object, LoggedCallDB.run_id)).in_(request.run_ids),
            _as_column(cast(object, LoggedCallDB.project)) == project,
        )
    )

    _ = session.exec(
        delete(RunDB).where(RUN_ID_COL.in_(request.run_ids), RUN_PROJECT_COL == project)
    )

    session.commit()

    return {
        "deleted_runs": len(request.run_ids),
        "deleted_metrics": deleted_metrics.rowcount if deleted_metrics else 0,
        "deleted_calls": deleted_calls.rowcount if deleted_calls else 0,
    }


@router.post("/bulk-export")
def bulk_export_runs(
    request: BulkExportRequest,
    http_request: Request,
    project: str = "default",
    session: Session = Depends(get_session),
):
    # SPEC-178: require member on the target Project.
    enforce_project_read_from_request(http_request, session, project)
    return export_runs(session, request.run_ids, project, request.format)


# ── Replay / re-projection ─────────────────────────


@router.post("/{run_id}/reproject")
def reproject_run(
    run_id: str,
    http_request: Request,
    project: str = "default",
    session: Session = Depends(get_session),
):
    """Re-project a trace's canonical spans through the normalizer.

    Reads canonical spans from ``OtlpSpanDB`` and re-projects them into
    ``RunDB`` / ``LoggedCallDB``. Use this after a mapper change to update
    the product tables without re-ingesting the raw payload.

    Criterion #2: "The same raw canonical span can be replayed to
    produce a new Trace Projection after a mapper change."

    The ``project`` query parameter specifies which project the trace belongs
    to (required because canonical spans are scoped by project).
    """
    # SPEC-178: require member on the target Project.
    enforce_project_read_from_request(http_request, session, project)
    from ...models.db import OtlpSpanDB as _OtlpSpanDB
    from ...services.reproject import reproject_trace

    # Resolve the canonical span scoped by ``(trace_id, project)`` so two
    # projects sharing an OTel id each re-project their own trace.
    canonical = session.exec(
        select(_OtlpSpanDB).where(
            _OtlpSpanDB.trace_id == run_id, _OtlpSpanDB.project_id == project
        ).limit(1)
    ).first()
    if canonical is None:
        raise HTTPException(status_code=404, detail="Trace not found in canonical store")

    count = reproject_trace(run_id, project_id=project)
    return {"trace_id": run_id, "project": project, "reprojected_spans": count}
