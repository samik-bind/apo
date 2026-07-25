"""
Agent Task Runs API endpoints.

Provides endpoints for discovering tasks, managing batch runs,
and inspecting individual task runs.
"""

# pyright: reportCallInDefaultInitializer=false

import os
from collections.abc import Sequence
from datetime import datetime, timezone
from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import asc, desc
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import Session, col, select
from sqlmodel.sql.expression import SelectOfScalar

from ..db import get_session
from ..db_helpers import _as_column
from ..models import (
    AgentTaskBatchRunDB,
    AgentTaskBatchRunDetail,
    AgentTaskBatchRunExternalDetail,
    AgentTaskBatchRunSummary,
    AgentTaskDetail,
    AgentTaskRunDB,
    AgentTaskRunDetail,
    AgentTaskRunExternalSummary,
    AgentTaskRunTrigger,
    AgentTaskRunSummary,
    AgentTaskSummary,
    CreateAgentTaskBatchRunRequest,
    LoggedCallDB,
    ReportAgentTaskRunResultRequest,
    RunDB,
)
from ..services.agent_task_discovery import (
    DiscoveredAgentTask,
    discover_agent_task_by_id,
    discover_agent_tasks,
)
from ..services.agent_task_outcome import classify_run_outcome
from ..services.agent_task_projection import (
    parse_trigger,
    to_batch_run_detail,
    to_batch_run_summary,
    to_task_run_summary,
)
from ..services.agent_task_stats import (
    compute_run_stats,
    load_run_stat_fields,
)
from ..services.demo_workspace import require_project_not_demo
from ..services.project_task_sources import get_task_source_db
from ..services.agent_task_runner import (
    create_batch_run,
    finalize_external_task_run,
    prepare_external_batch_runs,

)
from ..services.project_task_source_sync import SyncError

router = APIRouter(prefix="/v1", tags=["agent-tasks"])


AGENT_TASK_BATCH_RUN_CREATED_AT_COL: ColumnElement[object] = _as_column(
    cast(object, AgentTaskBatchRunDB.created_at)
)


def _format_task_summary(task: object) -> AgentTaskSummary:
    t = cast(DiscoveredAgentTask, task)
    return AgentTaskSummary(
        id=t.id,
        task_path=t.task_path,
        folder_path=t.folder_path,
        display_name=t.display_name,
        adapter_name=t.adapter_name,
        has_checks=t.has_checks,
        has_user_simulator=t.has_user_simulator,
        tags=t.tags,
    )


def _apply_project_filter_to_task_runs(
    query: SelectOfScalar[AgentTaskRunDB],
    project: str | None,
) -> SelectOfScalar[AgentTaskRunDB]:
    if not project:
        return query

    return query.join(AgentTaskBatchRunDB).where(
        AgentTaskBatchRunDB.project == project
    )


def _load_batch_triggers(
    session: Session,
    batch_run_ids: Sequence[str],
) -> dict[str, AgentTaskRunTrigger | None]:
    unique_ids = list(dict.fromkeys(batch_run_ids))
    if not unique_ids:
        return {}

    batches = session.exec(
        select(AgentTaskBatchRunDB).where(
            _as_column(cast(object, AgentTaskBatchRunDB.id)).in_(unique_ids)
        )
    ).all()
    return {batch.id: parse_trigger(batch.run_metadata) for batch in batches}


def _load_primary_models(
    session: Session,
    task_runs: Sequence[AgentTaskRunDB],
    project: str,
) -> dict[str, str]:
    """Build a ``{trace_run_id: primary_model}`` map for the given task runs.

    Each agent task run links to its trace via ``trace_run_id``. The model
    the run executed under is read from ``RunDB.primary_model``; when that
    is null (legacy runs whose traces never populated it — currently the
    common case) we fall back to the model of the run's first logged call
    by creation time. This mirrors the one-time backfill in ``db.py`` so
    every existing run resolves to a model without a migration.

    ``project`` scopes the lookups so two task runs in different Projects
    cannot pick up each other's model if they happen to share an OTel id.
    """
    trace_ids = [tr.trace_run_id for tr in task_runs if tr.trace_run_id]
    unique_trace_ids = list(dict.fromkeys(trace_ids))
    if not unique_trace_ids:
        return {}

    runs = session.exec(
        select(RunDB).where(
            _as_column(cast(object, RunDB.id)).in_(unique_trace_ids),
            _as_column(cast(object, RunDB.project)) == project,
        )
    ).all()
    model_map: dict[str, str] = {
        run.id: run.primary_model
        for run in runs
        if isinstance(run.primary_model, str)
    }

    # Fill the gaps from logged calls. Only query for runs still missing a
    # model — keeps the fallback cheap when most runs already carry one.
    missing = [rid for rid in unique_trace_ids if rid not in model_map]
    if missing:
        # Prefer GENERATION calls (actual LLM invocations) and order by
        # created_at so the first real model wins. Structural spans like
        # the "agent-task" simulator-loop CHAIN are not LLM models, and
        # "unknown" means the SDK never captured a model — both skipped.
        calls = session.exec(
            select(LoggedCallDB)
            .where(
                _as_column(cast(object, LoggedCallDB.run_id)).in_(missing),
                _as_column(cast(object, LoggedCallDB.project)) == project,
            )
            .order_by(
                # GENERATION first (0), everything else after (1).
                _as_column(cast(object, LoggedCallDB.observation_type)) != "GENERATION",
                asc(_as_column(cast(object, LoggedCallDB.created_at))),
            )
        ).all()
        structural_models = {"agent-task", "unknown", ""}
        for call in calls:
            if (
                call.run_id is not None
                and call.run_id not in model_map
                and call.model not in structural_models
            ):
                model_map[call.run_id] = call.model

    return model_map


# ============================================================================
# Task Discovery Endpoints
# ============================================================================


@router.get("/agent-tasks", response_model=list[AgentTaskSummary])
async def list_agent_tasks(
    task_root: str | None = Query(default=None),
    grep: str | None = Query(default=None),
    project: str | None = Query(default=None),
    session: Session = Depends(get_session),
):
    """List discovered agent tasks from the filesystem with run stats."""
    tasks = discover_agent_tasks(task_root, grep)
    summaries = [_format_task_summary(t) for t in tasks]

    if not project:
        return summaries

    task_ids = [s.id for s in summaries]
    if not task_ids:
        return summaries

    runs_by_task = load_run_stat_fields(session, project, task_ids)

    for summary in summaries:
        task_runs = runs_by_task.get(summary.id, [])
        if not task_runs:
            continue

        summary.run_stats = compute_run_stats(task_runs)

    return summaries


@router.get("/agent-tasks/{task_id:path}", response_model=AgentTaskDetail)
async def get_agent_task(
    task_id: str,
    task_root: str | None = Query(default=None),
    project: str | None = Query(default=None),
    session: Session = Depends(get_session),
):
    """Get details for a single agent task including latest run."""
    task = discover_agent_task_by_id(task_root, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    latest_run = None
    if project:
        latest_query: SelectOfScalar[AgentTaskRunDB] = (
            select(AgentTaskRunDB)
            .where(AgentTaskRunDB.task_id == task_id)
            .order_by(desc(_as_column(cast(object, AgentTaskRunDB.started_at))))
            .limit(1)
        )
        latest_query = _apply_project_filter_to_task_runs(latest_query, project)
        tr = session.exec(latest_query).first()
        if tr:
            trigger = _load_batch_triggers(session, [tr.batch_run_id]).get(tr.batch_run_id)
            latest_run = to_task_run_summary(tr, trigger)

    return AgentTaskDetail(
        id=task.id,
        task_path=task.task_path,
        folder_path=task.folder_path,
        display_name=task.display_name,
        adapter_name=task.adapter_name,
        has_checks=task.has_checks,
        has_user_simulator=task.has_user_simulator,
        tags=task.tags,
        latest_run=latest_run,
    )


# ============================================================================
# Batch Run Endpoints
# ============================================================================


@router.post(
    "/agent-task-batch-runs",
    response_model=AgentTaskBatchRunDetail,
    status_code=201,
)
async def create_agent_task_batch_run(
    request: CreateAgentTaskBatchRunRequest,
    session: Session = Depends(get_session),
):
    """Create a new batch run from a task selection.

    SPEC-146: when an explicit ``execution_target`` Pool is supplied, the Batch
    is created as durable queued Attempts (no Control-Plane subprocess). The
    Project default Pool is used when available; otherwise the legacy in-process
    path runs during the transition.
    """
    require_project_not_demo(request.project)
    task_source = get_task_source_db(session, request.project)

    explicit_pool_id_raw = (
        request.execution_target.get("pool_id")
        if request.execution_target and request.execution_target.get("kind") == "pool"
        else None
    )
    explicit_pool_id = str(explicit_pool_id_raw) if explicit_pool_id_raw else None
    use_pooled = explicit_pool_id is not None or _project_has_default_pool(session, request.project)

    if use_pooled:
        from apo.services.execution_queue import PoolResolutionError, create_pooled_batch_run

        try:
            batch = await create_pooled_batch_run(
                session,
                project_id=request.project,
                pool_id=explicit_pool_id,
                selection_type=request.selection_type,
                task_paths=request.task_paths or None,
                task_root=request.task_root,
                grep=request.grep,
                environment=request.environment,
                run_metadata=request.run_metadata,
                task_source=task_source,
            )
        except PoolResolutionError as e:
            raise HTTPException(status_code=409, detail={"kind": e.kind, "msg": str(e)})
        except ValueError as e:
            raise HTTPException(status_code=409, detail=str(e))
        except SyncError as e:
            raise HTTPException(status_code=422, detail=str(e))

        task_runs = session.exec(
            select(AgentTaskRunDB).where(AgentTaskRunDB.batch_run_id == batch.id)
        ).all()
        return to_batch_run_detail(batch, task_runs)

    # Legacy in-process path (transition; removed once every project has a Pool).
    try:
        batch = create_batch_run(
            session=session,
            project=request.project,
            selection_type=request.selection_type,
            task_paths=request.task_paths,
            task_root=request.task_root,
            grep=request.grep,
            environment=request.environment,
            run_metadata=request.run_metadata,
            task_source=task_source,
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except SyncError as e:
        raise HTTPException(status_code=422, detail=str(e))

    task_runs = session.exec(
        select(AgentTaskRunDB).where(AgentTaskRunDB.batch_run_id == batch.id)
    ).all()


    return to_batch_run_detail(batch, task_runs)


def _project_has_default_pool(session: Session, project_id: str) -> bool:
    from apo.models.db import ProjectDB

    project = session.get(ProjectDB, project_id)
    return project is not None and project.default_executor_pool_id is not None


# ============================================================================
# SPEC-146: Cancellation routes (idempotent; must precede any catch-all)
# ============================================================================


@router.post("/agent-task-runs/{task_run_id}/cancel")
async def cancel_agent_task_run(
    task_run_id: str,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Cancel one Task Run's Attempt (SPEC-143 semantics). Idempotent."""
    from apo.models.db import TaskExecutionAttemptDB
    from apo.services.execution_leases import request_cancellation

    attempt = session.exec(
        select(TaskExecutionAttemptDB).where(TaskExecutionAttemptDB.task_run_id == task_run_id)
    ).first()
    if attempt is None:
        # No attempt (legacy/historical run): nothing to cancel.
        return {"ok": True, "attempt_id": None, "status": None}
    request_cancellation(session, attempt_id=attempt.id)
    session.refresh(attempt)
    return {"ok": True, "attempt_id": attempt.id, "status": attempt.status}


@router.post("/agent-task-batch-runs/{batch_run_id}/cancel")
async def cancel_agent_task_batch_run(
    batch_run_id: str,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Cancel a Batch: future queued/leased Attempts cancel immediately; a
    running Attempt records a cancellation request. Idempotent."""
    from apo.models.db import TaskExecutionAttemptDB
    from apo.services.execution_leases import request_cancellation

    attempts = session.exec(
        select(TaskExecutionAttemptDB).where(TaskExecutionAttemptDB.batch_run_id == batch_run_id)
    ).all()
    for attempt in attempts:
        request_cancellation(session, attempt_id=attempt.id)
    return {"ok": True, "cancelled": len(attempts)}


@router.post(
    "/agent-task-batch-runs/external",
    response_model=AgentTaskBatchRunExternalDetail,
    status_code=201,
)
async def create_external_agent_task_batch_run(
    request: CreateAgentTaskBatchRunRequest,
    session: Session = Depends(get_session),
):
    """Create a batch run whose tasks execute out-of-band (Issue #4).

    For tasks that cannot run inside the backend container (they need
    dev-machine credentials, a VPC tunnel, a personal stage, etc.), the
    external executor — typically ``apo task run --local`` — runs the task
    on its own machine and reports the result back via
    ``POST /v1/agent-task-runs/{id}/result``.

    This endpoint creates the batch + task run rows, marks them ``running``,
    and returns a scoped trace token per task run. The token's ``sub`` is
    the task run id; the executor presents it as ``APO_AUTH_TOKEN`` so trace
    ingestion claims the run via the existing SPEC-128/129 path.

    No subprocess is spawned — the caller owns execution.
    """
    require_project_not_demo(request.project)
    task_source = get_task_source_db(session, request.project)
    try:
        batch = create_batch_run(
            session=session,
            project=request.project,
            selection_type=request.selection_type,
            task_paths=request.task_paths,
            task_root=request.task_root,
            grep=request.grep,
            environment=request.environment,
            run_metadata=request.run_metadata,
            task_source=task_source,
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except SyncError as e:
        raise HTTPException(status_code=422, detail=str(e))

    pairs = prepare_external_batch_runs(session, batch)

    return AgentTaskBatchRunExternalDetail(
        id=batch.id,
        project=batch.project,
        status=batch.status,
        task_runs=[
            AgentTaskRunExternalSummary(
                id=task_run.id,
                task_id=task_run.task_id,
                task_path=task_run.task_path,
                status=task_run.status,
                started_at=task_run.started_at,
                trace_token=token,
            )
            for task_run, token in pairs
        ],
    )


# ============================================================================
# SPEC-145: Caller Executor create-and-claim
# ============================================================================


class CallerCreateRequest(BaseModel):
    project: str
    task: "CallerTaskDescriptorBody"
    environment: str = "default"
    run_metadata: dict[str, object] | None = None
    source_attestation: "CallerSourceAttestationBody"
    caller_identity: "CallerIdentityBody"


class CallerTaskDescriptorBody(BaseModel):
    task_id: str
    task_path: str
    display_name: str
    adapter_name: str | None = None
    has_checks: bool = False


class CallerSourceAttestationBody(BaseModel):
    source_type: str = "caller_worktree"
    repository_url: str | None = None
    base_commit_sha: str | None = None
    dirty: bool
    content_sha256: str
    task_root_label: str
    file_count: int
    uncompressed_size_bytes: int


class CallerIdentityBody(BaseModel):
    client: str
    client_version: str
    hostname_hash: str | None = None
    ci_provider: str | None = None
    ci_job_id: str | None = None
    git_branch: str | None = None
    os: str
    architecture: str


class CallerCreateResponse(BaseModel):
    batch_run_id: str
    task_run_id: str
    attempt_id: str
    lease_generation: int
    lease_expires_at: datetime
    attempt_jwt: str
    trace_endpoint: str
    trace_project: str
    trace_required: bool = True


@router.post(
    "/agent-task-batch-runs/caller",
    response_model=CallerCreateResponse,
    status_code=201,
)
async def create_caller_batch_run_route(
    request: CallerCreateRequest,
    session: Session = Depends(get_session),
) -> CallerCreateResponse:
    """SPEC-145: atomically create one Batch + Task Run + attested Revision +
    leased caller Attempt, and return the Attempt JWT the CLI uses for
    /start, heartbeat, and result. The caller owns execution; no Executor
    process is enrolled."""
    require_project_not_demo(request.project)
    from apo.models.execution import (
        CallerIdentity,
        CallerSourceAttestation,
        CallerTaskDescriptor,
    )
    from apo.services.execution_queue import (
        CallerExecutionError,
        create_caller_batch_run,
    )

    try:
        result = create_caller_batch_run(
            session,
            project_id=request.project,
            task=CallerTaskDescriptor(
                task_id=request.task.task_id,
                task_path=request.task.task_path,
                display_name=request.task.display_name,
                adapter_name=request.task.adapter_name,
                has_checks=request.task.has_checks,
            ),
            environment=request.environment,
            run_metadata=request.run_metadata,
            attestation=CallerSourceAttestation(
                source_type="caller_worktree",
                repository_url=request.source_attestation.repository_url,
                base_commit_sha=request.source_attestation.base_commit_sha,
                dirty=request.source_attestation.dirty,
                content_sha256=request.source_attestation.content_sha256,
                task_root_label=request.source_attestation.task_root_label,
                file_count=request.source_attestation.file_count,
                uncompressed_size_bytes=request.source_attestation.uncompressed_size_bytes,
            ),
            caller_identity=CallerIdentity(
                client=request.caller_identity.client,
                client_version=request.caller_identity.client_version,
                hostname_hash=request.caller_identity.hostname_hash,
                ci_provider=request.caller_identity.ci_provider,
                ci_job_id=request.caller_identity.ci_job_id,
                git_branch=request.caller_identity.git_branch,
                os=request.caller_identity.os,
                architecture=request.caller_identity.architecture,
            ),
        )
    except CallerExecutionError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))

    backend_url = os.environ.get("APO_BACKEND_URL", "http://127.0.0.1:8000")
    return CallerCreateResponse(
        batch_run_id=result.batch.id,
        task_run_id=result.task_run.id,
        attempt_id=result.attempt.id,
        lease_generation=result.attempt.lease_generation,
        lease_expires_at=result.attempt.lease_expires_at or datetime.now(timezone.utc),
        attempt_jwt=result.attempt_jwt,
        trace_endpoint=os.environ.get("AGENT_TASK_TRACE_ENDPOINT", backend_url),
        trace_project=request.project,
        trace_required=True,
    )


@router.get("/agent-task-batch-runs", response_model=list[AgentTaskBatchRunSummary])
async def list_agent_task_batch_runs(
    project: str | None = Query(default=None),
    status: str | None = Query(default=None),
    session: Session = Depends(get_session),
):
    """List batch runs, optionally filtered by project and status."""
    query = select(AgentTaskBatchRunDB)

    if project:
        query = query.where(AgentTaskBatchRunDB.project == project)
    if status:
        query = query.where(AgentTaskBatchRunDB.status == status)

    query = query.order_by(desc(AGENT_TASK_BATCH_RUN_CREATED_AT_COL))
    batches = session.exec(query).all()

    batch_ids = [br.id for br in batches]
    cost_by_batch: dict[str, float] = {}
    if batch_ids:
        all_task_runs = session.exec(
            select(AgentTaskRunDB).where(col(AgentTaskRunDB.batch_run_id).in_(batch_ids))
        ).all()
        for tr in all_task_runs:
            cost_by_batch[tr.batch_run_id] = cost_by_batch.get(tr.batch_run_id, 0.0) + (
                tr.total_cost or 0.0
            )

    return [to_batch_run_summary(br, cost_by_batch.get(br.id)) for br in batches]


@router.get(
    "/agent-task-batch-runs/{batch_run_id}",
    response_model=AgentTaskBatchRunDetail,
)
async def get_agent_task_batch_run(
    batch_run_id: str,
    session: Session = Depends(get_session),
):
    """Get batch run details including all contained task runs."""
    batch = session.get(AgentTaskBatchRunDB, batch_run_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Batch run not found")

    task_runs = session.exec(
        select(AgentTaskRunDB).where(AgentTaskRunDB.batch_run_id == batch_run_id)
    ).all()

    model_map = _load_primary_models(session, task_runs, batch.project)
    from apo.services.task_revisions import get_revision_summary_for_batch

    task_revision = get_revision_summary_for_batch(session, batch_run_id)
    return to_batch_run_detail(batch, task_runs, model_map=model_map, task_revision=task_revision)


# ============================================================================
# Task Run Endpoints
# ============================================================================


@router.get("/agent-task-runs", response_model=list[AgentTaskRunSummary])
async def list_agent_task_runs(
    project: str | None = Query(default=None),
    status: str | None = Query(default=None),
    task_id: str | None = Query(default=None),
    batch_run_id: str | None = Query(default=None),
    session: Session = Depends(get_session),
):
    """List all task runs, optionally filtered by project, status, task, or batch."""
    query = select(AgentTaskRunDB)

    if project:
        query = query.join(AgentTaskBatchRunDB).where(
            AgentTaskBatchRunDB.project == project
        )
    if status:
        query = query.where(AgentTaskRunDB.status == status)
    if task_id:
        query = query.where(AgentTaskRunDB.task_id == task_id)
    if batch_run_id:
        query = query.where(AgentTaskRunDB.batch_run_id == batch_run_id)

    query = query.order_by(desc(_as_column(cast(object, AgentTaskRunDB.started_at))))
    task_runs = session.exec(query).all()
    triggers = _load_batch_triggers(session, [tr.batch_run_id for tr in task_runs])
    return [to_task_run_summary(tr, triggers.get(tr.batch_run_id)) for tr in task_runs]


@router.get("/agent-task-runs/{task_run_id}", response_model=AgentTaskRunDetail)
async def get_agent_task_run(
    task_run_id: str,
    session: Session = Depends(get_session),
):
    """Get detailed information about a single task run."""
    task_run = session.get(AgentTaskRunDB, task_run_id)
    if task_run is None:
        raise HTTPException(status_code=404, detail="Task run not found")
    trigger = _load_batch_triggers(session, [task_run.batch_run_id]).get(
        task_run.batch_run_id
    )

    return AgentTaskRunDetail(
        id=task_run.id,
        batch_run_id=task_run.batch_run_id,
        task_id=task_run.task_id,
        task_path=task_run.task_path,
        adapter_name=task_run.adapter_name,
        status=task_run.status,
        pass_result=task_run.pass_result,
        started_at=task_run.started_at,
        completed_at=task_run.completed_at,
        trace_run_id=task_run.trace_run_id,
        task_source_commit_sha=task_run.task_source_commit_sha,
        error_message=task_run.error_message,
        trace_persistence_status=task_run.trace_persistence_status,
        trace_error_message=task_run.trace_error_message,
        total_cost=task_run.total_cost,
        total_tokens=task_run.total_tokens,
        total_checks=len(task_run.checks_json or []),
        passed_checks=sum(
            1
            for result in (task_run.checks_json or [])
            if result.get("pass") is True
        ),
        failed_checks=sum(
            1
            for result in (task_run.checks_json or [])
            if result.get("pass") is not True
        ),
        trigger=trigger,
        checks_json=task_run.checks_json,
        transcript_json=task_run.transcript_json,
        deliverables_json=task_run.deliverables_json,
        error_category=classify_run_outcome(
            task_run.status,
            task_run.error_message,
            task_run.trace_persistence_status,
        ),
    )


@router.post(
    "/agent-task-runs/{task_run_id}/result",
    response_model=AgentTaskRunDetail,
)
async def report_agent_task_run_result(
    task_run_id: str,
    request: ReportAgentTaskRunResultRequest,
    session: Session = Depends(get_session),
):
    """Finalize a task run from an external executor (Issue #4).

    Companion to ``POST /v1/agent-task-batch-runs/external``: the external
    executor (typically ``apo task run --local``) reports the verdict,
    checks, transcript, and deliverables back after running the task on its
    own machine.

    Idempotency: reporting against an already-terminal run returns 409.

    Error reporting (Issue #13): ``errored=true`` with an ``error_message``
    finalizes the run as ``status: error`` (executor threw before producing
    a verdict), mirroring the in-process ``except Exception`` path. A
    ``trace_run_id`` of ``None`` is accepted even when the run already owns
    a trace claimed from the live OTLP stream — the backend trusts its own
    claim, since the executor may not know the id (e.g. it errored early).
    """
    task_run = session.get(AgentTaskRunDB, task_run_id)
    if task_run is None:
        raise HTTPException(status_code=404, detail="Task run not found")

    batch = session.get(AgentTaskBatchRunDB, task_run.batch_run_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Batch run not found")
    require_project_not_demo(batch.project)

    try:
        finalize_external_task_run(
            session,
            task_run,
            pass_result=request.pass_result,
            adapter_name=request.adapter_name,
            trace_run_id=request.trace_run_id,
            checks=request.checks,
            transcript=request.transcript,
            deliverables=request.deliverables,
            errored=request.errored,
            error_message=request.error_message,
        )
    except ValueError as e:
        msg = str(e)
        status_code = 409 if "already terminal" in msg else 400
        raise HTTPException(status_code=status_code, detail=msg) from e
    except RuntimeError as e:
        # reconcile_trace_id raises when the reported trace id disagrees with
        # the one already claimed at ingestion — surface it as 409 conflict.
        raise HTTPException(status_code=409, detail=str(e)) from e

    session.refresh(task_run)
    trigger = _load_batch_triggers(session, [task_run.batch_run_id]).get(
        task_run.batch_run_id
    )

    return AgentTaskRunDetail(
        id=task_run.id,
        batch_run_id=task_run.batch_run_id,
        task_id=task_run.task_id,
        task_path=task_run.task_path,
        adapter_name=task_run.adapter_name,
        status=task_run.status,
        pass_result=task_run.pass_result,
        started_at=task_run.started_at,
        completed_at=task_run.completed_at,
        trace_run_id=task_run.trace_run_id,
        task_source_commit_sha=task_run.task_source_commit_sha,
        error_message=task_run.error_message,
        trace_persistence_status=task_run.trace_persistence_status,
        trace_error_message=task_run.trace_error_message,
        total_cost=task_run.total_cost,
        total_tokens=task_run.total_tokens,
        total_checks=len(task_run.checks_json or []),
        passed_checks=sum(
            1
            for result in (task_run.checks_json or [])
            if result.get("pass") is True
        ),
        failed_checks=sum(
            1
            for result in (task_run.checks_json or [])
            if result.get("pass") is not True
        ),
        trigger=trigger,
        checks_json=task_run.checks_json,
        transcript_json=task_run.transcript_json,
        deliverables_json=task_run.deliverables_json,
        error_category=classify_run_outcome(
            task_run.status,
            task_run.error_message,
            task_run.trace_persistence_status,
        ),
    )
