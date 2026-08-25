"""SPEC-185 route: manual test result corrections.

``POST /v1/agent-task-runs/{task_run_id}/test-result-corrections`` — a
project member records a human decision about one recorded top-level Test:
effective PASS/FAIL, or clear back to the recorded result. Evidence (Check
Report, assertions, judge responses, judgments) is never rewritten.

Authorization mirrors the judgments route (Run → Batch → Project, opaque 404
for inaccessible runs) with one extra gate corrections add: the actor must
be human — session member, full-scope project API key, or open-dev. Ingest
keys and runtime capability credentials (service / Attempt / Executor
tokens) are refused with distinct 403s because a correction is review, not
execution.
"""

# pyright: reportAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false, reportPrivateUsage=false

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlmodel import Session

from apo.db import get_session
from apo.models.db import AgentTaskRunDB, UserDB
from apo.models.schemas import CorrectTestResultRequest, CorrectedTestResult
from apo.services.agent_task_run_access import require_task_run_access
from apo.services.test_result_corrections import (
    CorrectionActor,
    CorrectionError,
    correct_test_result,
)

router = APIRouter(prefix="/v1", tags=["agent-tasks"])

_ERROR_STATUS: dict[str, int] = {
    "test_result_not_found": status.HTTP_404_NOT_FOUND,
    "run_not_correctable": status.HTTP_409_CONFLICT,
    "ambiguous_test_id": status.HTTP_409_CONFLICT,
    "no_active_correction": status.HTTP_409_CONFLICT,
    "reason_required": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "invalid_action": status.HTTP_422_UNPROCESSABLE_ENTITY,
}


@router.post(
    "/agent-task-runs/{task_run_id}/test-result-corrections",
    response_model=CorrectedTestResult,
)
async def correct_run_test_result(
    task_run_id: str,
    body: CorrectTestResultRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> CorrectedTestResult:
    """Record one human correction on a terminal, verdict-bearing Run."""
    task_run = _load_task_run(session, task_run_id)
    project = require_task_run_access(request, session, task_run, write=True)
    actor = _derive_actor(request, session)

    try:
        return correct_test_result(
            session,
            task_run=task_run,
            project=project,
            test_id=body.test_id,
            action=body.action,
            reason=body.reason,
            actor=actor,
        )
    except CorrectionError as exc:
        code = _ERROR_STATUS.get(exc.kind, status.HTTP_409_CONFLICT)
        raise HTTPException(code, detail={"kind": exc.kind, "msg": str(exc)}) from exc


def _load_task_run(session: Session, task_run_id: str) -> AgentTaskRunDB:
    task_run = session.get(AgentTaskRunDB, task_run_id)
    if task_run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Task run not found")
    return task_run


def _derive_actor(request: Request, session: Session) -> CorrectionActor:
    """Human-only actor derivation with the spec's distinct 403 contract."""
    auth_method = getattr(request.state, "auth_method", None)

    if auth_method in ("service_token", "attempt_token"):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={
                "kind": "human_review_required",
                "msg": "runtime capability credentials cannot correct results; use a session or full API key",
            },
        )

    user_id = getattr(request.state, "user_id", None)

    if auth_method == "api_key":
        scope = getattr(request.state, "api_key_scope", "full")
        if scope != "full":
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail={
                    "kind": "full_scope_required",
                    "msg": "ingest-scoped API keys cannot correct results",
                },
            )
        label = _user_email(session, user_id)
        return CorrectionActor(
            user_id=user_id,
            label=label,
            via="api_key",
            api_key_id=getattr(request.state, "api_key_id", None),
        )

    if auth_method == "cookie":
        return CorrectionActor(
            user_id=user_id,
            label=_user_email(session, user_id),
            via="session",
            api_key_id=None,
        )

    # Open-dev (no auth_method): development bypass identity.
    return CorrectionActor(
        user_id=user_id,
        label=_user_email(session, user_id),
        via="open_dev",
        api_key_id=None,
    )


def _user_email(session: Session, user_id: str | None) -> str | None:
    if user_id is None:
        return None
    user = session.get(UserDB, user_id)
    return user.email if user is not None else None
