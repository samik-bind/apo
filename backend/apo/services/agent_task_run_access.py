"""SPEC-140 ticket 04: reusable Task Run access authorization.

One helper owns the Project-derivation + own-service-token rule so every
Deliverable upload, download, lookup, and the touched Task Run detail/result
routes apply identical scoping. A content feature must not preserve
cross-Project lookup by globally opaque ID as an implicit authorization
strategy.

The Project is ALWAYS derived through ``AgentTaskBatchRunDB`` — never from
request JSON or query parameters.

- service token: ``request.state.project`` must equal the batch Project and
  ``service_task_run_id`` must equal the Task Run ID;
- API key / dashboard cookie / open-dev: the batch Project is trusted; the
  demo Project rejects writes via the existing ``require_project_not_demo``.
"""

from __future__ import annotations

from fastapi import HTTPException, Request
from sqlmodel import Session

from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB
from apo.services.demo_workspace import require_project_not_demo


def require_task_run_access(
    request: Request,
    session: Session,
    task_run: AgentTaskRunDB,
    *,
    write: bool,
) -> str:
    """Authorize and return the Task Run's Project.

    Raises 404 (not 403) when a service token targets a different run, so a
    cross-run guess cannot infer the existence of another run. Writes against
    the demo Project are rejected with 403.
    """
    batch = session.get(AgentTaskBatchRunDB, task_run.batch_run_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Task run not found")
    project = batch.project

    auth_method = getattr(request.state, "auth_method", None)
    if auth_method == "service_token":
        token_project = getattr(request.state, "project", None)
        token_run_id = getattr(request.state, "service_task_run_id", None)
        # A service token is bound to one Task Run; any mismatch is a cross-run
        # attempt. Report 404 so the caller cannot confirm the other run exists.
        if token_run_id != task_run.id or token_project != project:
            raise HTTPException(status_code=404, detail="Task run not found")

    if write:
        require_project_not_demo(project)

    _ = session  # session is reserved for future API-key scope checks
    return project
