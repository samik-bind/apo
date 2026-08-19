"""
Agent Task Runs API endpoints.

Provides endpoints for managing batch runs and inspecting individual task runs.
"""

# pyright: reportAny=false, reportArgumentType=false, reportCallInDefaultInitializer=false, reportUnusedCallResult=false, reportUnusedImport=false

import os
from collections.abc import Sequence
from datetime import datetime, timezone
from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel
from sqlalchemy import asc, desc
from sqlalchemy.orm import defer
from sqlmodel import Session, col, select

from ..db import get_session
from ..db_helpers import as_column
from ..models import (
    AgentTaskBatchRunDB,
    AgentTaskBatchRunDetail,
    AgentTaskRunDB,
    AgentTaskRunDetail,
    AgentTaskRunTrigger,
    AgentTaskRunSummary,
    CreateAgentTaskBatchRunRequest,
    GenerationExecutionSummary,
    LoggedCallDB,
    ReportAgentTaskRunResultRequest,
    RunDB,
)
from ..models.db import ProjectMembershipDB
from ..services.agent_task_configuration import configuration_from_row
from ..services.agent_task_batch_listing import (
    BatchRunListFilters,
    BatchRunListPagination,
    PaginatedBatchRunSummary,
    list_batch_run_summaries,
)
from ..services.agent_task_deliverables import derive_deliverables_json
from ..services.check_report_storage import load_check_report
from ..services.agent_task_outcome import classify_run_outcome
from ..services.agent_task_run_access import require_task_run_access
from ..services.agent_task_projection import (
    parse_trigger,
    to_batch_run_detail,
    to_task_run_summary,
)
from ..services.demo_workspace import require_project_not_demo
from ..services.project_task_sources import get_task_source_db
from ..services.agent_task_runner import (
    create_batch_run,
    finalize_external_task_run,
    prepare_external_batch_runs,

)
from ..services.project_task_source_sync import SyncError
from ..services.project_memberships import (
    authorize_project_request,
    enforce_project_role_from_request,
    readable_project_ids_for_request,
)

router = APIRouter(prefix="/v1", tags=["agent-tasks"])


# Defer the heavy JSON columns on list/summary paths that only read scalars.
_TASK_RUN_LIGHT = (
    defer(AgentTaskRunDB.transcript_json),
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
            as_column(cast(object, AgentTaskBatchRunDB.id)).in_(unique_ids)
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
            as_column(cast(object, RunDB.id)).in_(unique_trace_ids),
            as_column(cast(object, RunDB.project)) == project,
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
        # the "agent-task" run-loop CHAIN are not LLM models, and
        # "unknown" means the SDK never captured a model — both skipped.
        calls = session.exec(
            select(LoggedCallDB)
            .where(
                as_column(cast(object, LoggedCallDB.run_id)).in_(missing),
                as_column(cast(object, LoggedCallDB.project)) == project,
            )
            .order_by(
                # GENERATION first (0), everything else after (1).
                as_column(cast(object, LoggedCallDB.observation_type)) != "GENERATION",
                asc(as_column(cast(object, LoggedCallDB.created_at))),
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


def _build_task_run_detail(
    session: Session,
    task_run: AgentTaskRunDB,
    *,
    trigger: AgentTaskRunTrigger | None = None,
    include_transcript: bool = False,
    task_definition: dict[str, object] | None = None,
    deliverables_json: dict[str, object] | None = None,
) -> AgentTaskRunDetail:
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
        unpriced_call_count=task_run.unpriced_call_count,
        generation_execution=(
            GenerationExecutionSummary.model_validate(
                task_run.generation_execution_json
            )
            if task_run.generation_execution_json is not None
            else None
        ),
        total_tokens=task_run.total_tokens,
        total_checks=task_run.total_checks,
        passed_checks=task_run.passed_checks,
        failed_checks=task_run.failed_checks,
        trigger=trigger,
        checks_json=load_check_report(session, task_run.id),
        transcript_json=task_run.transcript_json if include_transcript else None,
        deliverables_json=deliverables_json,
        error_category=classify_run_outcome(
            task_run.status,
            task_run.error_message,
            task_run.trace_persistence_status,
        ),
        run_configuration=configuration_from_row(
            task_run.configured_model, task_run.configured_effort
        ),
        task_definition=task_definition,
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
    body: CreateAgentTaskBatchRunRequest,
    http_request: Request,
    session: Session = Depends(get_session),
):
    """Create a source-owned Batch from exact catalog Task IDs.

    the dashboard Batch is source-owned by definition. The
    authenticated User is always the owner/target; no Pool, path, root,
    grep, or execution_target field is accepted.
    """
    require_project_not_demo(body.project)
    membership = enforce_project_role_from_request(
        http_request,
        session,
        body.project,
        minimum_role="member",
    )

    # Source-owned routing requires a real authenticated User; the legacy
    # open-dev "dev" sentinel must never be persisted into User foreign keys.
    acting_user_id = cast(str | None, getattr(http_request.state, "user_id", None))
    membership_user_id = getattr(membership, "user_id", None)
    if (
        not acting_user_id
        or not membership_user_id
        or str(acting_user_id) != str(membership_user_id)
    ):
        raise HTTPException(
            status_code=401,
            detail="source-owned execution requires an authenticated project member",
        )

    from apo.services.execution_queue import (
        SourceOwnedSelectionError,
        create_source_owned_batch_run,
    )

    try:
        batch = create_source_owned_batch_run(
            session,
            project_id=body.project,
            user_id=str(acting_user_id),
            task_ids=body.task_ids,
            environment=body.environment,
            run_metadata=body.run_metadata,
        )
    except SourceOwnedSelectionError as error:
        status_code = (
            409
            if error.kind in ("task_catalog_missing", "task_not_in_catalog")
            else 422
        )
        raise HTTPException(
            status_code=status_code,
            detail={"kind": error.kind, "msg": str(error)},
        ) from error
    except Exception as error:
        # bounded 500 for unexpected database transaction failures.
        # Roll back, log server-side, and return a safe response without SQL/schema details.
        import logging

        logging.getLogger(__name__).exception("Batch creation failed")
        session.rollback()
        raise HTTPException(
            status_code=500,
            detail={
                "kind": "batch_creation_failed",
                "msg": "Could not create the run. Check the server logs.",
            },
        ) from error

    task_runs = session.exec(
        select(AgentTaskRunDB).where(AgentTaskRunDB.batch_run_id == batch.id)
    ).all()
    from apo.models.db import TaskExecutionAttemptDB

    attempts = session.exec(
        select(TaskExecutionAttemptDB).where(
            TaskExecutionAttemptDB.batch_run_id == batch.id
        )
    ).all()
    return to_batch_run_detail(batch, task_runs, attempts=attempts)


# ============================================================================
# Cancellation routes (idempotent; must precede any catch-all)
# ============================================================================


@router.post("/agent-task-runs/{task_run_id}/cancel")
async def cancel_agent_task_run(
    task_run_id: str,
    http_request: Request,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Cancel one Task Run's Attempt. Idempotent."""
    from apo.models.db import TaskExecutionAttemptDB
    from apo.services.execution_leases import request_cancellation

    task_run = session.get(AgentTaskRunDB, task_run_id)
    if task_run is None:
        raise HTTPException(status_code=404, detail="Task run not found")
    batch = session.get(AgentTaskBatchRunDB, task_run.batch_run_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Batch run not found")
    _ = enforce_project_role_from_request(
        http_request, session, batch.project, minimum_role="member"
    )
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
    http_request: Request,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Cancel a Batch: future queued/leased Attempts cancel immediately; a
    running Attempt records a cancellation request. Idempotent."""
    from apo.models.db import TaskExecutionAttemptDB
    from apo.services.execution_leases import request_cancellation

    batch = session.get(AgentTaskBatchRunDB, batch_run_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Batch run not found")
    _ = enforce_project_role_from_request(
        http_request, session, batch.project, minimum_role="member"
    )
    attempts = session.exec(
        select(TaskExecutionAttemptDB).where(TaskExecutionAttemptDB.batch_run_id == batch_run_id)
    ).all()
    for attempt in attempts:
        request_cancellation(session, attempt_id=attempt.id)
    return {"ok": True, "cancelled": len(attempts)}


# ============================================================================
# Cancellation routes (idempotent; must precede any catch-all)
# ============================================================================
# Caller Executor create-and-claim
# ============================================================================


class CallerCreateRequest(BaseModel):
    project: str
    task: "CallerTaskDescriptorBody"
    environment: str = "default"
    run_metadata: dict[str, object] | None = None
    source_attestation: "CallerSourceAttestationBody"
    caller_identity: "CallerIdentityBody"
    task_definition: dict[str, object]


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
    http_request: Request,
    session: Session = Depends(get_session),
) -> CallerCreateResponse:
    """Atomically create one Batch + Task Run + attested Revision +
    leased caller Attempt, and return the Attempt JWT the CLI uses for
    /start, heartbeat, and result. The caller owns execution; no Executor
    process is enrolled."""
    require_project_not_demo(request.project)
    _ = enforce_project_role_from_request(
        http_request, session, request.project, minimum_role="member"
    )
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
            task_definition=request.task_definition,
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


@router.get("/agent-task-batch-runs", response_model=PaginatedBatchRunSummary)
async def list_agent_task_batch_runs(
    request: Request,
    project: str | None = Query(default=None),
    status: str | None = Query(default=None),
    q: str | None = Query(default=None),
    model: str | None = Query(default=None),
    effort: str | None = Query(default=None),
    since: str | None = Query(default=None),
    page: int = Query(0, ge=0),
    page_size: int = Query(20, ge=1, le=100),
    session: Session = Depends(get_session),
):
    """List batch runs with server-side filtering and pagination.

    SPEC-178: the list is scoped to the caller's readable Projects. An
    explicit ``project`` is authorized before use; omitting it returns
    only the caller's membership Projects.
    """
    if project:
        authorize_project_request(request, session, project)
        project_ids: list[str] | None = [project]
    else:
        project_ids = readable_project_ids_for_request(request, session)

    model_list = [m.strip() for m in model.split(",") if m.strip()] if model else []
    effort_list = [e.strip() for e in effort.split(",") if e.strip()] if effort else []

    return list_batch_run_summaries(
        session,
        BatchRunListFilters(
            project_ids=project_ids,
            status=status,
            search=q,
            since=since,
            models=model_list,
            efforts=effort_list,
        ),
        BatchRunListPagination(page=page, page_size=page_size),
    )


@router.get(
    "/agent-task-batch-runs/{batch_run_id}",
    response_model=AgentTaskBatchRunDetail,
)
async def get_agent_task_batch_run(
    request: Request,
    batch_run_id: str,
    session: Session = Depends(get_session),
):
    """Get batch run details including all contained task runs."""
    batch = session.get(AgentTaskBatchRunDB, batch_run_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Batch run not found")

    # SPEC-178: authorize after load — deny cross-Project access with 404.
    try:
        authorize_project_request(request, session, batch.project, minimum_role="member")
    except HTTPException as exc:
        if exc.status_code == 403:
            raise HTTPException(status_code=404, detail="Batch run not found") from exc
        raise

    task_runs = session.exec(
        select(AgentTaskRunDB).options(*_TASK_RUN_LIGHT).where(AgentTaskRunDB.batch_run_id == batch_run_id)
    ).all()

    model_map = _load_primary_models(session, task_runs, batch.project)
    from apo.services.task_revisions import get_revision_summary_for_batch

    task_revision = get_revision_summary_for_batch(session, batch_run_id)
    from apo.models.db import ExecutorDB, ExecutorPoolDB, TaskExecutionAttemptDB

    attempts = session.exec(
        select(TaskExecutionAttemptDB).where(
            TaskExecutionAttemptDB.batch_run_id == batch_run_id
        )
    ).all()
    executor_ids = {
        attempt.executor_id
        for attempt in attempts
        if attempt.executor_id is not None
    }
    executors: Sequence[ExecutorDB] = (
        session.exec(
            select(ExecutorDB).where(
                col(ExecutorDB.id).in_(executor_ids)
            )
        ).all()
        if executor_ids
        else []
    )
    executor_names = {executor.id: executor.name for executor in executors}
    pool_name: str | None = None
    target = batch.execution_target_json or {}
    pool_id = target.get("pool_id")
    if isinstance(pool_id, str):
        pool = session.get(ExecutorPoolDB, pool_id)
        pool_name = pool.name if pool is not None else None
    return to_batch_run_detail(
        batch,
        task_runs,
        model_map=model_map,
        task_revision=task_revision,
        attempts=attempts,
        executor_names=executor_names,
        executor_pool_name=pool_name,
    )


# ============================================================================
# Task Run Endpoints
# ============================================================================


@router.get("/agent-task-runs", response_model=list[AgentTaskRunSummary])
async def list_agent_task_runs(
    request: Request,
    project: str | None = Query(default=None),
    status: str | None = Query(default=None),
    task_id: str | None = Query(default=None),
    batch_run_id: str | None = Query(default=None),
    model: list[str] | None = Query(default=None),
    effort: list[str] | None = Query(default=None),
    session: Session = Depends(get_session),
):
    """List all task runs, optionally filtered.

    ``model``/``effort`` are repeatable and exact/case-sensitive.
    Repeated values within one dimension OR; the two dimensions AND. A run
    with an unreported configuration (NULL columns) never matches.

    SPEC-178: the list is scoped to the caller's readable Projects. An
    explicit ``project`` is authorized before use; omitting it returns
    only the caller's membership Projects (or is unrestricted in
    development open-dev mode).
    """
    # Derive the Project scope (SPEC-178 §List scoping).
    if project:
        authorize_project_request(request, session, project)
        project_ids: list[str] | None = [project]
    else:
        project_ids = readable_project_ids_for_request(request, session)

    query = select(AgentTaskRunDB).options(*_TASK_RUN_LIGHT)

    if project_ids is not None:
        query = query.join(AgentTaskBatchRunDB).where(
            col(AgentTaskBatchRunDB.project).in_(project_ids)
        )
    elif project:
        query = query.join(AgentTaskBatchRunDB).where(
            AgentTaskBatchRunDB.project == project
        )
    if status:
        query = query.where(AgentTaskRunDB.status == status)
    if task_id:
        query = query.where(AgentTaskRunDB.task_id == task_id)
    if batch_run_id:
        query = query.where(AgentTaskRunDB.batch_run_id == batch_run_id)
    if model:
        query = query.where(col(AgentTaskRunDB.configured_model).in_(model))
    if effort:
        query = query.where(col(AgentTaskRunDB.configured_effort).in_(effort))

    query = query.order_by(desc(as_column(cast(object, AgentTaskRunDB.started_at))))
    task_runs = session.exec(query).all()
    triggers = _load_batch_triggers(session, [tr.batch_run_id for tr in task_runs])
    return [to_task_run_summary(tr, triggers.get(tr.batch_run_id)) for tr in task_runs]


@router.get("/agent-task-runs/{task_run_id}", response_model=AgentTaskRunDetail)
async def get_agent_task_run(
    request: Request,
    task_run_id: str,
    include: str | None = Query(default=None),
    session: Session = Depends(get_session),
):
    """Get detailed information about a single task run."""
    task_run = session.get(AgentTaskRunDB, task_run_id)
    if task_run is None:
        raise HTTPException(status_code=404, detail="Task run not found")

    # SPEC-178: authorize after load — derive Project through batch and deny
    # cross-Project access with an opaque 404.
    batch = session.get(AgentTaskBatchRunDB, task_run.batch_run_id)
    if batch is not None:
        try:
            authorize_project_request(request, session, batch.project, minimum_role="member")
        except HTTPException as exc:
            if exc.status_code == 403:
                raise HTTPException(status_code=404, detail="Task run not found") from exc
            raise

    trigger = _load_batch_triggers(session, [task_run.batch_run_id]).get(
        task_run.batch_run_id
    )

    task_definition_summary: dict[str, object] | None = None
    if task_run.task_definition_revision_id:
        from apo.models.db import TaskDefinitionRevisionDB
        from apo.services.task_definition_revisions import to_definition_summary
        def_rev = session.get(TaskDefinitionRevisionDB, task_run.task_definition_revision_id)
        if def_rev is not None:
            task_definition_summary = to_definition_summary(def_rev)

    return _build_task_run_detail(
        session,
        task_run,
        trigger=trigger,
        include_transcript=bool(include and "transcript" in include),
        task_definition=task_definition_summary,
        deliverables_json=await derive_deliverables_json(session, task_run),
    )


@router.post(
    "/agent-task-runs/{task_run_id}/result",
    response_model=AgentTaskRunDetail,
)
async def report_agent_task_run_result(
    task_run_id: str,
    payload: ReportAgentTaskRunResultRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    """Finalize a task run from an external executor (Issue #4).

    Companion to ``POST /v1/agent-task-batch-runs/external``: the external
    executor (typically ``apo task run --local``) reports the verdict,
    checks, transcript, and deliverables back after running the task on its
    own machine.

    Authorization (SPEC-178): the Project is derived through the Batch and
    the caller must hold authority over it — a service/Attempt token must
    match this exact run; a session/API-key caller must be a member.
    Cross-Project reports are opaque 404s, before any verdict, transcript,
    or Deliverable is written or read back.

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

    _ = require_task_run_access(request, session, task_run, write=True)

    # SPEC-179 phase 1: inline JSON deliverables persist as canonical
    # AgentTaskDeliverableDB rows (SPEC-172 placement rules apply: inline
    # under the threshold, gzip+store above, name collisions rejected).
    # The legacy ``deliverables_json`` column write below continues during
    # the transition so the detail response field keeps working.
    if payload.deliverables:
        from ..services.agent_task_deliverables import persist_json_deliverable
        from ..services.artifact_stores.registry import get_store

        batch = session.get(AgentTaskBatchRunDB, task_run.batch_run_id)
        if batch is None:
            raise HTTPException(status_code=404, detail="Task run not found")
        store = get_store(None)
        try:
            for name, value in payload.deliverables.items():
                await persist_json_deliverable(
                    session,
                    project=batch.project,
                    task_run_id=task_run_id,
                    name=name,
                    value=value,
                    store=store,
                )
            session.flush()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        finalize_external_task_run(
            session,
            task_run,
            pass_result=payload.pass_result,
            adapter_name=payload.adapter_name,
            trace_run_id=payload.trace_run_id,
            checks=payload.checks,
            transcript=payload.transcript,
            deliverables=None,  # rows persisted above (SPEC-179 phase 2)
            errored=payload.errored,
            error_message=payload.error_message,
            run_configuration=payload.run_configuration,
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

    return _build_task_run_detail(
        session,
        task_run,
        trigger=trigger,
        deliverables_json=await derive_deliverables_json(session, task_run),
    )
