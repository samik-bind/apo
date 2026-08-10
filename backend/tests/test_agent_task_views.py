"""Saved evidence-view persistence tests."""

from typing import cast

from sqlmodel import Session
from starlette.requests import Request
from starlette.types import Scope

from apo.models.db import TaskViewDB, UserDB
from apo.models.schemas import TaskViewUpdateRequest
from apo.routes.agent_task_views import update_task_view
from tests.conftest import seed_project_for_user

_PROJECT = "proj-task-views"
_OWNER = "owner-task-views"


async def test_explicit_null_clears_saved_date_filter(session: Session) -> None:
    session.add(
        UserDB(
            id=_OWNER,
            email="owner-task-views@test",
            name="Owner",
            password_hash="x",
        )
    )
    session.flush()
    _ = seed_project_for_user(session, _OWNER, project_id=_PROJECT)
    saved_view = TaskViewDB(
        project_id=_PROJECT,
        user_id=_OWNER,
        label="Opus",
        model="claude-opus",
        effort="high",
        since="7d",
    )
    session.add(saved_view)
    session.commit()

    request = Request(cast(Scope, {"type": "http"}))
    request.state.user_id = _OWNER
    updated = await update_task_view(
        _PROJECT,
        saved_view.id,
        TaskViewUpdateRequest(since=None),
        request,
        session,
    )

    assert updated.since is None
    assert updated.model == "claude-opus"
    assert updated.effort == "high"
    session.expire_all()
    persisted = session.get(TaskViewDB, saved_view.id)
    assert persisted is not None
    assert persisted.since is None
