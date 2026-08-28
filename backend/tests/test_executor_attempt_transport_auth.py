"""Attempt JWT authorization for trace and Artifact transport."""

# pyright: reportUnknownArgumentType=false, reportUnknownParameterType=false

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from _pytest.monkeypatch import MonkeyPatch
from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.auth import middleware as auth_middleware
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ProjectDB,
    TaskExecutionAttemptDB,
    TaskRevisionDB,
)
from apo.services import executor_auth


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _seed_running_attempt(session: Session) -> TaskExecutionAttemptDB:
    return _seed_attempt(session, status="running")


def _seed_attempt(
    session: Session,
    *,
    status: str = "running",
    lease_expires_at: datetime | None = None,
    run_id: str = "run-auth",
    attempt_id: str = "attempt-auth",
) -> TaskExecutionAttemptDB:
    if lease_expires_at is None:
        lease_expires_at = _now() + timedelta(minutes=5)
    session.add(ProjectDB(id="attempt-auth", name="attempt-auth", created_at=_now()))
    session.add(
        AgentTaskBatchRunDB(
            id="batch-auth",
            project="attempt-auth",
            selection_type="single",
            status="running",
            created_at=_now(),
            started_at=_now(),
        )
    )
    session.flush()
    session.add(
        TaskRevisionDB(
            id="revision-auth",
            project="attempt-auth",
            batch_run_id="batch-auth",
            materialization="attested",
            source_type="caller",
            content_sha256="a" * 64,
            file_count=1,
            uncompressed_size_bytes=1,
            manifest_summary_json={"fileCount": 1},
            created_at=_now(),
        )
    )
    session.add(
        AgentTaskRunDB(
            id=run_id,
            batch_run_id="batch-auth",
            task_id="task-auth",
            task_path="task-auth",
            status="running",
            started_at=_now(),
        )
    )
    session.flush()
    attempt = TaskExecutionAttemptDB(
        id=attempt_id,
        project="attempt-auth",
        batch_run_id="batch-auth",
        task_run_id=run_id,
        task_revision_id="revision-auth",
        sequence_index=0,
        target_kind="caller",
        status=status,
        lease_generation=1,
        lease_expires_at=lease_expires_at,
        queue_expires_at=_now() + timedelta(hours=1),
        started_at=_now() if status != "leased" else None,
    )
    session.add(attempt)
    session.commit()
    return attempt


def _mint_token(attempt: TaskExecutionAttemptDB, generation: int = 1) -> str:
    return executor_auth.create_attempt_jwt(
        attempt=attempt,
        lease_generation=generation,
        expires_in_seconds=300,
    )


def _post_intent(client: TestClient, run_id: str, headers: dict) -> tuple[int, str]:  # pyright: ignore[reportMissingTypeArgument]
    artifact = b"abc"
    resp = client.post(
        f"/v1/agent-task-runs/{run_id}/artifact-uploads",
        json={
            "name": "output",
            "display_filename": "output.txt",
            "media_type": "text/plain",
            "size_bytes": len(artifact),
            "sha256": hashlib.sha256(artifact).hexdigest(),
        },
        headers=headers,
    )
    return resp.status_code, resp.text


@pytest.mark.real_auth
def test_attempt_token_allows_current_trace_and_artifact_but_stale_is_rejected(
    client: TestClient,
    session: Session,
    monkeypatch: MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(auth_middleware, "engine", session.get_bind())
    monkeypatch.setattr(executor_auth, "AUTH_SECRET", "attempt-transport-secret")
    monkeypatch.setenv("APO_ARTIFACT_DIR", str(tmp_path))
    attempt = _seed_running_attempt(session)
    token = executor_auth.create_attempt_jwt(
        attempt=attempt,
        lease_generation=1,
        expires_in_seconds=300,
    )
    headers = {"Authorization": f"Bearer {token}"}

    trace_response = client.post(
        "/api/public/otel/v1/traces",
        json={"resourceSpans": []},
        headers=headers,
    )
    assert trace_response.status_code == 200, trace_response.text

    artifact = b"abc"
    intent_response = client.post(
        "/v1/agent-task-runs/run-auth/artifact-uploads",
        json={
            "name": "output",
            "display_filename": "output.txt",
            "media_type": "text/plain",
            "size_bytes": len(artifact),
            "sha256": hashlib.sha256(artifact).hexdigest(),
        },
        headers=headers,
    )
    assert intent_response.status_code == 201, intent_response.text

    attempt.lease_generation = 2
    session.add(attempt)
    session.commit()
    stale_response = client.put(
        f"/v1/agent-task-artifact-uploads/{intent_response.json()['id']}",
        content=artifact,
        headers=headers,
    )
    assert stale_response.status_code == 401


@pytest.mark.real_auth
def test_attempt_token_can_read_own_trace_projection(
    client: TestClient,
    session: Session,
    monkeypatch: MonkeyPatch,
) -> None:
    """Regression: the bundled executor hands the runner an attempt JWT as
    ``APO_AUTH_TOKEN``, and the runner polls its own trace-projection endpoint
    to read back the canonical snapshot. That GET used to be allow-listed only
    for ``service_token``, so an attempt token got 403 ("Not authorized for
    this route") and the runner fell back to an empty local tee — every
    trajectory check then reported "evidence unavailable". The attempt token
    must reach the route (which scopes it to its own task run).
    """
    monkeypatch.setattr(auth_middleware, "engine", session.get_bind())
    monkeypatch.setattr(executor_auth, "AUTH_SECRET", "attempt-transport-secret")
    attempt = _seed_running_attempt(session)
    token = executor_auth.create_attempt_jwt(
        attempt=attempt,
        lease_generation=1,
        expires_in_seconds=300,
    )
    headers = {"Authorization": f"Bearer {token}"}

    # Own run: auth must pass. run-auth has no claimed trace, so the route
    # returns 409 "Task run has no trace" — the point is it is NOT 403.
    own = client.get("/v1/agent-task-runs/run-auth/trace-projection", headers=headers)
    assert own.status_code != 403, own.text
    assert own.status_code == 409, own.text

    # Cross-run read is still rejected: a different task_run_id in the path
    # must not be readable with this token.
    other = client.get(
        "/v1/agent-task-runs/some-other-run/trace-projection", headers=headers
    )
    assert other.status_code == 403, other.text


# ---------------------------------------------------------------------------
# Only a currently running, live Attempt may upload artifacts.
# ---------------------------------------------------------------------------


@pytest.mark.real_auth
def test_running_attempt_can_create_artifact_intent(
    client: TestClient,
    session: Session,
    monkeypatch: MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The happy path: a running attempt with a valid token creates an intent."""
    monkeypatch.setattr(auth_middleware, "engine", session.get_bind())
    monkeypatch.setattr(executor_auth, "AUTH_SECRET", "attempt-transport-secret")
    monkeypatch.setenv("APO_ARTIFACT_DIR", str(tmp_path))
    attempt = _seed_running_attempt(session)
    token = _mint_token(attempt)

    code, body = _post_intent(client, "run-auth", {"Authorization": f"Bearer {token}"})
    assert code == 201, body


@pytest.mark.real_auth
def test_leased_attempt_cannot_upload(
    client: TestClient,
    session: Session,
    monkeypatch: MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A leased (not-yet-started) attempt must not upload artifacts — the task
    code hasn't started, so no artifact can exist yet."""
    monkeypatch.setattr(auth_middleware, "engine", session.get_bind())
    monkeypatch.setattr(executor_auth, "AUTH_SECRET", "attempt-transport-secret")
    monkeypatch.setenv("APO_ARTIFACT_DIR", str(tmp_path))
    attempt = _seed_attempt(session, status="leased")
    token = _mint_token(attempt)

    code, body = _post_intent(client, "run-auth", {"Authorization": f"Bearer {token}"})
    assert code in (401, 403), f"leased attempt should be rejected, got {code}: {body}"


@pytest.mark.real_auth
def test_expired_lease_cannot_upload(
    client: TestClient,
    session: Session,
    monkeypatch: MonkeyPatch,
    tmp_path: Path,
) -> None:
    """An attempt whose lease has expired must not upload artifacts."""
    monkeypatch.setattr(auth_middleware, "engine", session.get_bind())
    monkeypatch.setattr(executor_auth, "AUTH_SECRET", "attempt-transport-secret")
    monkeypatch.setenv("APO_ARTIFACT_DIR", str(tmp_path))
    attempt = _seed_attempt(
        session, status="running", lease_expires_at=_now() - timedelta(minutes=1)
    )
    token = _mint_token(attempt)

    code, body = _post_intent(client, "run-auth", {"Authorization": f"Bearer {token}"})
    assert code in (401, 403), f"expired attempt should be rejected, got {code}: {body}"


@pytest.mark.real_auth
def test_lost_attempt_cannot_upload(
    client: TestClient,
    session: Session,
    monkeypatch: MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A lost attempt must not upload artifacts."""
    monkeypatch.setattr(auth_middleware, "engine", session.get_bind())
    monkeypatch.setattr(executor_auth, "AUTH_SECRET", "attempt-transport-secret")
    monkeypatch.setenv("APO_ARTIFACT_DIR", str(tmp_path))
    attempt = _seed_attempt(session, status="lost")
    token = _mint_token(attempt)

    code, body = _post_intent(client, "run-auth", {"Authorization": f"Bearer {token}"})
    assert code in (401, 403), f"lost attempt should be rejected, got {code}: {body}"


@pytest.mark.real_auth
def test_cross_run_token_cannot_upload(
    client: TestClient,
    session: Session,
    monkeypatch: MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A token bound to run-auth must not create uploads for a different run."""
    monkeypatch.setattr(auth_middleware, "engine", session.get_bind())
    monkeypatch.setattr(executor_auth, "AUTH_SECRET", "attempt-transport-secret")
    monkeypatch.setenv("APO_ARTIFACT_DIR", str(tmp_path))
    attempt = _seed_running_attempt(session)
    token = _mint_token(attempt)

    # Seed a second run that the token is NOT bound to.
    session.add(
        AgentTaskRunDB(
            id="run-other",
            batch_run_id="batch-auth",
            task_id="task-other",
            task_path="task-other",
            status="running",
            started_at=_now(),
        )
    )
    session.commit()

    code, body = _post_intent(client, "run-other", {"Authorization": f"Bearer {token}"})
    assert code in (401, 403, 404), f"cross-run should be rejected, got {code}: {body}"
