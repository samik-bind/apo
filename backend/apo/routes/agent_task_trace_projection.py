"""Task-Run-scoped Trace Projection read endpoint.

``GET /v1/agent-task-runs/{task_run_id}/trace-projection``

Primarily an internal execution boundary: the agent-task runner polls this
after flushing its execution Trace to read back the immutable projection
snapshot it will evaluate against. It is NOT the dashboard's canonical
Trace detail API.

Security:
  - Service/Attempt tokens: the token subject MUST equal ``{task_run_id}``,
    and Project comes from the verified token — never query parameters or
    telemetry.
  - Session / API-key / open-dev callers (issue #159 rejudge replay reads
    the same canonical snapshot): authorized as project members through
    ``require_task_run_access``; non-member access is an opaque 404.
  - The route resolves the Trace through ``AgentTaskRunDB.trace_run_id``;
    callers cannot supply or read an arbitrary Trace ID.

Responses:
  200 — claimed Trace completely projected -> ``TraceProjectionSnapshot``
  202 — claim/export/projection not ready -> ``{"status":"pending"}`` + Retry-After
  403 — token subject or Project does not own this Task Run
  404 — Task Run does not exist in the caller's Project
  409 — Task Run completed without a Trace claim
"""

# pyright: reportCallInDefaultInitializer=false

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlmodel import Session, col, select

from ..db import get_session
from ..models.db import AgentTaskBatchRunDB, AgentTaskRunDB
from ..models.trace_projection import TraceProjectionSnapshot
from ..services.agent_task_run_access import require_task_run_access
from ..services.trace_repository import get_trace_repository

router = APIRouter(prefix="/v1", tags=["agent-tasks"])

# Bounded backoff hint for a not-yet-projected trace. The SDK reader applies
# its own exponential backoff up to a configurable deadline; this just seeds
# the first retry interval.
_RETRY_AFTER_SECONDS = "2"


def _require_read_access(
    request: Request,
    session: Session,
    task_run_id: str,
) -> AgentTaskRunDB:
    """Authorize the read and return the loaded Task Run.

    Service/attempt tokens stay exact-run-scoped (subject must equal the path
    id — mismatch is 403 so a token cannot infer another run's existence).
    Every other caller (session, API key, open-dev) goes through the canonical
    Project policy with an opaque 404 for non-members, mirroring the Run
    detail route.
    """
    auth_method = getattr(request.state, "auth_method", None)
    if auth_method in ("service_token", "attempt_token"):
        project = getattr(request.state, "project", None)
        token_run_id = getattr(request.state, "service_task_run_id", None)
        if not isinstance(project, str) or not isinstance(token_run_id, str):
            raise HTTPException(status_code=403, detail="Not authorized for this task run")
        # Cross-run read attempt — checked BEFORE the load so a mismatch is
        # 403 and cannot leak another run's existence via 404.
        if token_run_id != task_run_id:
            raise HTTPException(status_code=403, detail="Not authorized for this task run")
        return _load_task_run(session, project=project, task_run_id=task_run_id)

    task_run = session.get(AgentTaskRunDB, task_run_id)
    if task_run is None:
        raise HTTPException(status_code=404, detail="Task run not found")
    _ = require_task_run_access(request, session, task_run, write=False)
    return task_run


def _load_task_run(
    session: Session,
    *,
    project: str,
    task_run_id: str,
) -> AgentTaskRunDB:
    """Load a task run scoped to the token's project (via its batch run).

    Raises 404 if the task run does not exist in that project.
    """
    stmt = (
        select(AgentTaskRunDB)
        .join(AgentTaskBatchRunDB)
        .where(
            col(AgentTaskRunDB.id) == task_run_id,
            col(AgentTaskBatchRunDB.project) == project,
        )
    )
    task_run = session.exec(stmt).first()
    if task_run is None:
        raise HTTPException(status_code=404, detail="Task run not found")
    return task_run


def _run_project(session: Session, task_run: AgentTaskRunDB) -> str:
    """Derive the Run's Project through its Batch (never request input)."""
    batch = session.get(AgentTaskBatchRunDB, task_run.batch_run_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Task run not found")
    return batch.project


@router.get(
    "/agent-task-runs/{task_run_id}/trace-projection",
    response_model=TraceProjectionSnapshot,
)
async def get_task_run_trace_projection(
    task_run_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> TraceProjectionSnapshot | JSONResponse:
    """Read the projection snapshot for a task run's claimed Trace.

    Service/attempt tokens must be scoped to this exact task run; project
    members may read their own Run's snapshot (issue #159 rejudge replay).
    The Trace is resolved through ``AgentTaskRunDB.trace_run_id`` — never a
    caller-supplied Trace ID.
    """
    task_run = _require_read_access(request, session, task_run_id)

    project = _run_project(session, task_run)

    if task_run.trace_run_id is None:
        # Completed (or otherwise) without a Trace claim.
        raise HTTPException(status_code=409, detail="Task run has no trace")

    repo = get_trace_repository(project)
    snapshot = repo.get_projection_snapshot(
        session,
        project_id=project,
        trace_id=task_run.trace_run_id,
    )
    # Not-ready responses use the spec's {"status":"pending"} body (not the
    # HTTPException {"detail":...} shape) plus a Retry-After header.
    if snapshot is None or not snapshot.trace.complete:
        return JSONResponse(
            status_code=202,
            content={"status": "pending"},
            headers={"Retry-After": _RETRY_AFTER_SECONDS},
        )
    return snapshot
