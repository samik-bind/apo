"""Attempt JWT authorization for trace and Artifact transport."""

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
            id="run-auth",
            batch_run_id="batch-auth",
            task_id="task-auth",
            task_path="task-auth",
            status="running",
            started_at=_now(),
        )
    )
    session.flush()
    attempt = TaskExecutionAttemptDB(
        id="attempt-auth",
        project="attempt-auth",
        batch_run_id="batch-auth",
        task_run_id="run-auth",
        task_revision_id="revision-auth",
        sequence_index=0,
        target_kind="caller",
        status="running",
        lease_generation=1,
        lease_expires_at=_now() + timedelta(minutes=5),
        queue_expires_at=_now() + timedelta(hours=1),
        started_at=_now(),
    )
    session.add(attempt)
    session.commit()
    return attempt


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
