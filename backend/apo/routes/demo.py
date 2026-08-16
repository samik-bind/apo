"""Demo workspace API endpoints."""

# pyright: reportCallInDefaultInitializer=false

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlmodel import Session

from ..db import get_session
from ..models.db import UserDB
from ..services.demo_workspace import (
    DEMO_PROJECT_ID,
    is_demo_read_only,
    is_demo_seeded,
    seed_demo_workspace,
    reset_demo_schedules,
)

router = APIRouter(prefix="/v1/demo", tags=["demo"])


@router.get("/status")
async def demo_status(session: Session = Depends(get_session)):
    """Check if the demo workspace is seeded and ready."""
    seeded = is_demo_seeded(session)
    return {
        "enabled": True,
        "project_id": DEMO_PROJECT_ID,
        "seeded": seeded,
        "read_only": is_demo_read_only(),
    }


@router.post("/seed")
async def seed_demo(
    request: Request,
    force: bool = Query(False, description="Re-seed by clearing existing demo data"),
    session: Session = Depends(get_session),
):
    """Seed the demo workspace with real task data. Idempotent unless force=True.

    The idempotent first-time seed stays open to any authenticated user
    (dashboard onboarding). ``force=True`` clears and reseeds the shared
    demo data, so it is limited to installation admins.
    """
    if force:
        user_id = getattr(request.state, "user_id", None)
        user = session.get(UserDB, user_id) if isinstance(user_id, str) else None
        if user is None or not user.is_admin:
            raise HTTPException(
                status_code=403,
                detail="Admin access required to re-seed the demo workspace",
            )
    reset_demo_schedules(session)
    # The synchronous seeder owns its SQLModel session and materializes an
    # async Revision bundle. Run it outside FastAPI's event loop so its
    # internal ``asyncio.run`` cannot become a nested-loop failure.
    batch_id = await asyncio.to_thread(seed_demo_workspace, force=force)
    return {
        "ok": True,
        "project_id": DEMO_PROJECT_ID,
        "batch_run_id": batch_id,
        "already_seeded": batch_id is None,
        "force": force,
    }
