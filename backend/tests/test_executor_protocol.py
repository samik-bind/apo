# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownLambdaType=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUntypedFunctionDecorator=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false, reportMissingTypeArgument=false, reportArgumentType=false

"""SPEC-143: registered-route scene + authorization tests.

Drives the protocol through the real TestClient: enroll an executor, claim an
attempt, start/heartbeat, finalize a result, then assert Attempt/Task Run/Batch
rollup. Plus the cross-attempt authorization invariant.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ExecutorPoolDB,
    ProjectDB,
    ProjectMembershipDB,
    TaskExecutionAttemptDB,
    TaskRevisionDB,
    UserDB,
)
from apo.models.execution import ExecutorCapabilities, ProjectActor
from apo.services import executor_auth
from apo.services.execution_pools import create_executor_pool
from sqlmodel import Session


def _seed_owner_project(session: Session) -> str:
    user = UserDB(email="owner@test", name="owner", password_hash="x", is_active=True)
    session.add(user)
    session.commit()
    session.refresh(user)
    session.add(ProjectDB(id="proj-px", name="proj-px", created_by=user.id, created_at=datetime.now(timezone.utc)))
    session.add(ProjectMembershipDB(
        project_id="proj-px", user_id=user.id, role="owner",
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    ))
    session.commit()
    return user.id


def _capabilities() -> ExecutorCapabilities:
    return ExecutorCapabilities(
        protocol_version=1, executor_version="apo-exec-1.0", driver_kinds=["subprocess"],
        os="linux", architecture="x86_64", runtimes={"node": "20"}, max_concurrency=1,
    )


def _seed_queued_attempt(session: Session, *, pool_id: str) -> TaskExecutionAttemptDB:
    session.add(AgentTaskBatchRunDB(
        id="bpx", project="proj-px", selection_type="single", status="queued",
        created_at=datetime.now(timezone.utc),
    ))
    session.flush()
    session.add(TaskRevisionDB(
        id="revpx", project="proj-px", batch_run_id="bpx", materialization="bundled",
        source_type="filesystem", content_sha256="c" * 64, file_count=1,
        uncompressed_size_bytes=1, manifest_summary_json={"fileCount": 1},
        created_at=datetime.now(timezone.utc),
    ))
    session.flush()
    session.add(AgentTaskRunDB(
        id="rpx", batch_run_id="bpx", task_id="tpx", task_path="tpx",
        sequence_index=0, status="pending", created_at=datetime.now(timezone.utc),
    ))
    session.flush()
    att = TaskExecutionAttemptDB(
        id="apx", project="proj-px", batch_run_id="bpx", task_run_id="rpx",
        task_revision_id="revpx", sequence_index=0, target_kind="pool",
        executor_pool_id=pool_id, status="queued",
        queue_expires_at=datetime.now(timezone.utc).timestamp() and datetime.now(timezone.utc),
        queued_at=datetime.now(timezone.utc),
    )
    from datetime import timedelta
    att.queue_expires_at = datetime.now(timezone.utc) + timedelta(hours=1)
    session.add(att)
    session.commit()
    return att


@pytest.fixture
def auth_secret(monkeypatch: pytest.MonkeyPatch) -> str:
    # The protocol mints/decodes task_execution_attempt JWTs with the module-level
    # AUTH_SECRET; patch it so the scene works without a deployment secret.
    monkeypatch.setattr(executor_auth, "AUTH_SECRET", "test-scene-secret")
    return "test-scene-secret"


def test_executor_protocol_end_to_end_scene(
    client: "object", session: Session, auth_secret: str
) -> None:
    user_id = _seed_owner_project(session)
    pool = create_executor_pool(
        session, project_id="proj-px", actor=ProjectActor("proj-px", user_id, "owner"),
        name="Scene Pool", kind="connected",
    )
    raw_token, _ = executor_auth.generate_enrollment_token(
        session, scope_kind="pool", project_id="proj-px", pool_id=pool.id,
        created_by_user_id=user_id,
    )
    _seed_queued_attempt(session, pool_id=pool.id)

    # 1. enroll
    r = client.post("/v1/executor-protocol/v1/enroll", json={
        "token": raw_token, "name": "exec-scene", "capabilities": _capabilities().model_dump(),
    })
    assert r.status_code == 200, r.text
    enroll = r.json()
    assert enroll["credential"].startswith("apo_ex_")
    cred = enroll["credential"]
    exe_headers = {"Authorization": f"Bearer {cred}"}

    # 2. claim
    r = client.post("/v1/executor-protocol/v1/claims",
                    json={"available_slots": 1, "accepted_driver_kinds": ["subprocess"]},
                    headers=exe_headers)
    assert r.status_code == 200, r.text
    claim = r.json()
    assert claim["attempt_id"] == "apx"
    attempt_jwt = claim["attempt_jwt"]
    att_headers = {"Authorization": f"Bearer {attempt_jwt}"}

    # 3. start
    r = client.post("/v1/executor-protocol/v1/attempts/apx/start",
                    json={"driver_kind": "subprocess", "runtime": {"node": "20"}}, headers=att_headers)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "running"

    # 4. heartbeat
    r = client.post("/v1/executor-protocol/v1/attempts/apx/heartbeat",
                    json={"phase": "running"}, headers=att_headers)
    assert r.status_code == 200, r.text
    assert r.json()["cancel_requested"] is False

    # 5. result (pass)
    r = client.post("/v1/executor-protocol/v1/attempts/apx/result", json={
        "completion_id": "comp-1", "pass_result": True, "adapter_name": "openai",
        "checks": [{"name": "c1", "pass": True}],
    }, headers=att_headers)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "succeeded"

    # rollup
    att = session.get(TaskExecutionAttemptDB, "apx")
    assert att is not None and att.status == "succeeded"
    run = session.get(AgentTaskRunDB, "rpx")
    assert run is not None and run.status == "passed"
    batch = session.get(AgentTaskBatchRunDB, "bpx")
    assert batch is not None and batch.passed_tasks == 1 and batch.total_tasks == 1


def test_attempt_token_rejected_on_other_attempt(
    client: "object", session: Session, auth_secret: str
) -> None:
    user_id = _seed_owner_project(session)
    pool = create_executor_pool(
        session, project_id="proj-px", actor=ProjectActor("proj-px", user_id, "owner"),
        name="Pool 2", kind="connected",
    )
    raw_token, _ = executor_auth.generate_enrollment_token(
        session, scope_kind="pool", project_id="proj-px", pool_id=pool.id,
        created_by_user_id=user_id,
    )
    _seed_queued_attempt(session, pool_id=pool.id)
    r = client.post("/v1/executor-protocol/v1/enroll", json={
        "token": raw_token, "name": "e", "capabilities": _capabilities().model_dump(),
    })
    cred = r.json()["credential"]
    claim = client.post("/v1/executor-protocol/v1/claims",
                        json={"available_slots": 1, "accepted_driver_kinds": ["subprocess"]},
                        headers={"Authorization": f"Bearer {cred}"}).json()
    attempt_jwt = claim["attempt_jwt"]

    # Use this attempt's token against a DIFFERENT attempt id -> 403.
    r = client.post("/v1/executor-protocol/v1/attempts/other-attempt/start",
                    json={"driver_kind": "subprocess", "runtime": {}},
                    headers={"Authorization": f"Bearer {attempt_jwt}"})
    assert r.status_code == 403


def test_invalid_executor_credential_rejected(
    client: "object", session: Session, auth_secret: str
) -> None:
    r = client.post("/v1/executor-protocol/v1/claims",
                    json={"available_slots": 1, "accepted_driver_kinds": ["subprocess"]},
                    headers={"Authorization": "Bearer apo_ex_bogus"})
    assert r.status_code == 401


def test_empty_claim_returns_retry_after(
    client: "object", session: Session, auth_secret: str
) -> None:
    user_id = _seed_owner_project(session)
    pool = create_executor_pool(
        session, project_id="proj-px", actor=ProjectActor("proj-px", user_id, "owner"),
        name="Empty Pool", kind="connected",
    )
    raw_token, _ = executor_auth.generate_enrollment_token(
        session, scope_kind="pool", project_id="proj-px", pool_id=pool.id,
        created_by_user_id=user_id,
    )
    cred = client.post("/v1/executor-protocol/v1/enroll", json={
        "token": raw_token, "name": "e", "capabilities": _capabilities().model_dump(),
    }).json()["credential"]
    # No attempts queued -> 204 + Retry-After.
    r = client.post("/v1/executor-protocol/v1/claims",
                    json={"available_slots": 1, "accepted_driver_kinds": ["subprocess"]},
                    headers={"Authorization": f"Bearer {cred}"})
    assert r.status_code == 204
    assert r.headers.get("retry-after") == "2"
