"""SPEC-174 — evidence view comparison + saved-view routes.

Comparison: POST creates an immutable snapshot (resolves both sides, freezes
run ids + revisions + coverage); GET reads one by its short opaque id.

Saved views: GET lists the caller's tabs for a project; POST/PATCH/DELETE
manage them so derived tabs persist across refresh / cross-device.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session, select

from ..db import get_session
from ..models.db import ProjectDB, TaskViewDB
from ..models.schemas import (
    TaskViewComparisonRequest,
    TaskViewComparisonSnapshot,
    TaskViewCreateRequest,
    TaskViewResponse,
    TaskViewUpdateRequest,
)
from ..services.project_memberships import require_project_member
from ..services.task_view_comparison import create_comparison, get_comparison, to_snapshot

router = APIRouter(prefix="/v1/projects/{project_id}", tags=["task-views"])


def _get_user_id(request: Request) -> str:
    user_id = cast(str | None, getattr(request.state, "user_id", None))
    if user_id:
        return user_id
    raise HTTPException(status_code=401, detail="Authentication required")


def _authorize(session: Session, project_id: str, request: Request) -> None:
    """404 if the project is missing, 403 if the caller is not a member."""
    project = session.get(ProjectDB, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    require_project_member(session, project_id, _get_user_id(request))


def _to_response(row: TaskViewDB) -> TaskViewResponse:
    return TaskViewResponse(
        id=row.id,
        project_id=row.project_id,
        label=row.label,
        model=row.model,
        effort=row.effort,
        since=row.since,
    )


# ---------------------------------------------------------------------------
# Comparison snapshots
# ---------------------------------------------------------------------------

@router.post("/task-view-comparisons", response_model=TaskViewComparisonSnapshot, status_code=201)
async def create_task_view_comparison(
    project_id: str,
    body: TaskViewComparisonRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> TaskViewComparisonSnapshot:
    """Resolve + freeze a selection-scoped comparison, return the snapshot."""
    _authorize(session, project_id, request)
    try:
        return create_comparison(
            session,
            project_id=project_id,
            task_ids=body.task_ids,
            view_a=body.view_a,
            view_b=body.view_b,
            created_by=_get_user_id(request),
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/task-view-comparisons/{comparison_id}", response_model=TaskViewComparisonSnapshot)
async def get_task_view_comparison(
    project_id: str,
    comparison_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> TaskViewComparisonSnapshot:
    """Read a snapshot by id (shareable, reload-stable). Scoped to its project."""
    _authorize(session, project_id, request)
    row = get_comparison(session, project_id, comparison_id)
    if row is None or row.project_id != project_id:
        raise HTTPException(status_code=404, detail="Comparison not found")
    return to_snapshot(row)


# ---------------------------------------------------------------------------
# Saved evidence views (persistent tabs)
# ---------------------------------------------------------------------------

@router.get("/task-views", response_model=list[TaskViewResponse])
async def list_task_views(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> list[TaskViewResponse]:
    """List the caller's saved evidence-view tabs for the project."""
    _authorize(session, project_id, request)
    user_id = _get_user_id(request)
    rows = session.exec(
        select(TaskViewDB)
        .where(TaskViewDB.project_id == project_id, TaskViewDB.user_id == user_id)
        .order_by("created_at")
    ).all()
    return [_to_response(r) for r in rows]


@router.post("/task-views", response_model=TaskViewResponse, status_code=201)
async def create_task_view(
    project_id: str,
    body: TaskViewCreateRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> TaskViewResponse:
    """Create a saved evidence-view tab."""
    _authorize(session, project_id, request)
    user_id = _get_user_id(request)
    row = TaskViewDB(
        project_id=project_id,
        user_id=user_id,
        label=body.label,
        model=body.model,
        effort=body.effort,
        since=body.since,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return _to_response(row)


@router.patch("/task-views/{view_id}", response_model=TaskViewResponse)
async def update_task_view(
    project_id: str,
    view_id: str,
    body: TaskViewUpdateRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> TaskViewResponse:
    """Update a saved evidence-view tab (label / model / effort / since)."""
    _authorize(session, project_id, request)
    user_id = _get_user_id(request)
    row = session.get(TaskViewDB, view_id)
    if row is None or row.project_id != project_id or row.user_id != user_id:
        raise HTTPException(status_code=404, detail="View not found")
    for field in ("label", "model", "effort", "since"):
        val = getattr(body, field)
        if val is not None:
            setattr(row, field, val)
    row.updated_at = datetime.now(timezone.utc)
    session.add(row)
    session.commit()
    session.refresh(row)
    return _to_response(row)


@router.delete("/task-views/{view_id}", status_code=204)
async def delete_task_view(
    project_id: str,
    view_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> None:
    """Delete a saved evidence-view tab."""
    _authorize(session, project_id, request)
    user_id = _get_user_id(request)
    row = session.get(TaskViewDB, view_id)
    if row is None or row.project_id != project_id or row.user_id != user_id:
        raise HTTPException(status_code=404, detail="View not found")
    session.delete(row)
    session.commit()
