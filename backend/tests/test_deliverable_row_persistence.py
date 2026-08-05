# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false
# pyright: reportAttributeAccessIssue=false, reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false

"""SPEC-162 #119: result submit persists deliverable rows, not blobs.

When a source-owned or caller run submits a result with deliverables, the
deliverables must be persisted as AgentTaskDeliverableDB rows (inline ≤64KiB,
gzip-to-store above) — not dumped onto the hot agent_task_runs row.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.middleware.base import BaseHTTPMiddleware
from sqlmodel import Session, SQLModel, create_engine, select
from sqlalchemy.pool import StaticPool

from apo.api import app
from apo.db import engine as prod_engine, get_session
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ProjectDB,
    TaskExecutionAttemptDB,
    UserDB,
    ProjectMembershipDB,
    AgentTaskDeliverableDB,
)


def _seed_leased_attempt(session, *, attempt_id="att-deliv", run_id="run-deliv"):
    from apo.services.executor_auth import create_attempt_jwt

    now = datetime.now(timezone.utc)
    batch = AgentTaskBatchRunDB(
        id="bch-deliv", project="p1", selection_type="tasks",
        status="queued", execution_target_json={"kind": "source_owned"},
        created_at=now,
    )
    session.add(batch)
    session.flush()
    run = AgentTaskRunDB(
        id=run_id, batch_run_id="bch-deliv", task_id="t", task_path="p",
        sequence_index=0, status="running",
    )
    session.add(run)
    session.flush()
    attempt = TaskExecutionAttemptDB(
        id=attempt_id, project="p1", batch_run_id="bch-deliv", task_run_id=run_id,
        sequence_index=0, target_kind="pool", assignment_kind="source_owned",
        executor_pool_id="pool-1", status="running", phase="running",
        queue_expires_at=now + timedelta(hours=24),
        queued_at=now, claimed_at=now, started_at=now,
        heartbeat_at=now, lease_generation=1,
        lease_expires_at=now + timedelta(minutes=5),
    )
    session.add(attempt)
    session.commit()
    return create_attempt_jwt(attempt=attempt, lease_generation=1, expires_in_seconds=3600)


@pytest.fixture
def isolated(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)
    import apo.db as db_module
    monkeypatch.setattr(db_module, "engine", engine)
    # The seeded attempt mints a JWT, which intentionally fails closed when
    # AUTH_SECRET is unset.
    monkeypatch.setattr("apo.services.executor_auth.AUTH_SECRET", "test-secret")
    with Session(engine) as s:
        u = UserDB(email="t@t.com", name="T", password_hash="x", is_active=True)
        s.add(u); s.commit(); s.refresh(u)
        s.add(ProjectDB(id="p1", name="P", created_by=u.id)); s.commit()
    return engine


def _client(engine) -> TestClient:
    class Inject(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            request.state.user_id = None
            return await call_next(request)
    na = FastAPI()
    na.include_router(app.router)
    na.add_middleware(Inject)
    na.dependency_overrides[get_session] = lambda: Session(engine)
    return TestClient(na)


class TestResultSubmitPersistsDeliverableRows:
    """#119: deliverables become rows, not blobs."""

    def test_small_deliverable_creates_inline_row(self, isolated, monkeypatch):
        engine = isolated
        with Session(engine) as s:
            jwt = _seed_leased_attempt(s)
        c = _client(engine)
        try:
            resp = c.post(
                "/v1/executor-protocol/v2/attempts/att-deliv/result",
                headers={"Authorization": f"Bearer {jwt}"},
                json={
                    "completion_id": "comp-1",
                    "pass_result": True,
                    "deliverables": {"verdict": {"result": "pass", "score": 42}},
                },
            )
            assert resp.status_code == 200, resp.text

            with Session(engine) as s:
                # Row exists
                rows = s.exec(
                    select(AgentTaskDeliverableDB).where(
                        AgentTaskDeliverableDB.task_run_id == "run-deliv"
                    )
                ).all()
                assert len(rows) == 1
                assert rows[0].name == "verdict"
                assert rows[0].kind == "json"
                assert rows[0].id != f"legacy:verdict"

                # Hot row does NOT carry the blob
                run = s.get(AgentTaskRunDB, "run-deliv")
                assert run.deliverables_json is None
        finally:
            app.dependency_overrides.clear()

    def test_large_deliverable_goes_to_store(self, isolated, monkeypatch):
        from apo.services.artifact_stores.local import LocalArtifactStore
        engine = isolated
        big_value = {"data": "x" * 100_000}  # > 64 KiB
        with Session(engine) as s:
            jwt = _seed_leased_attempt(s)
        c = _client(engine)
        try:
            resp = c.post(
                "/v1/executor-protocol/v2/attempts/att-deliv/result",
                headers={"Authorization": f"Bearer {jwt}"},
                json={
                    "completion_id": "comp-2",
                    "pass_result": True,
                    "deliverables": {"big": big_value},
                },
            )
            assert resp.status_code == 200, resp.text

            with Session(engine) as s:
                rows = s.exec(
                    select(AgentTaskDeliverableDB).where(
                        AgentTaskDeliverableDB.task_run_id == "run-deliv"
                    )
                ).all()
                assert len(rows) == 1
                # Large deliverable: body is null, storage key is set
                assert rows[0].inline_value_json is None
                assert rows[0].storage_key is not None
                assert rows[0].storage_backend is not None
                assert rows[0].size_bytes > 64 * 1024

                run = s.get(AgentTaskRunDB, "run-deliv")
                assert run.deliverables_json is None
        finally:
            app.dependency_overrides.clear()

    def test_no_deliverables_leaves_no_rows(self, isolated, monkeypatch):
        engine = isolated
        with Session(engine) as s:
            jwt = _seed_leased_attempt(s)
        c = _client(engine)
        try:
            resp = c.post(
                "/v1/executor-protocol/v2/attempts/att-deliv/result",
                headers={"Authorization": f"Bearer {jwt}"},
                json={"completion_id": "comp-3", "pass_result": True},
            )
            assert resp.status_code == 200

            with Session(engine) as s:
                rows = s.exec(
                    select(AgentTaskDeliverableDB).where(
                        AgentTaskDeliverableDB.task_run_id == "run-deliv"
                    )
                ).all()
                assert len(rows) == 0
        finally:
            app.dependency_overrides.clear()


def _seed_artifact_row(session, *, name="report", status="pending", run_id="run-deliv"):
    """Insert an artifact deliverable row directly for preflight tests."""
    now = datetime.now(timezone.utc)
    session.add(AgentTaskDeliverableDB(
        id=f"dlv_{name}", project="p1", task_run_id=run_id, name=name,
        kind="artifact", status=status, storage_backend="local",
        storage_key=f"test/{name}", media_type="application/octet-stream",
        display_filename=name, size_bytes=100, stored_size_bytes=100,
        sha256="a" * 64, created_at=now,
        ready_at=now if status == "ready" else None,
    ))
    session.commit()


class TestArtifactReadinessFence:
    """SPEC-172 Step 6: a result cannot terminalize while an Artifact is
    pending or failed."""

    def test_pending_artifact_blocks_result(self, isolated, monkeypatch):
        engine = isolated
        with Session(engine) as s:
            jwt = _seed_leased_attempt(s)
            _seed_artifact_row(s, name="report", status="pending")
        c = _client(engine)
        try:
            resp = c.post(
                "/v1/executor-protocol/v2/attempts/att-deliv/result",
                headers={"Authorization": f"Bearer {jwt}"},
                json={"completion_id": "comp-pending", "pass_result": True,
                      "deliverables": {"score": {"value": 1}}},
            )
            assert resp.status_code == 409, resp.text
            assert "report" in resp.text
        finally:
            app.dependency_overrides.clear()

    def test_ready_artifact_allows_result(self, isolated, monkeypatch):
        engine = isolated
        with Session(engine) as s:
            jwt = _seed_leased_attempt(s)
            _seed_artifact_row(s, name="report", status="ready")
        c = _client(engine)
        try:
            resp = c.post(
                "/v1/executor-protocol/v2/attempts/att-deliv/result",
                headers={"Authorization": f"Bearer {jwt}"},
                json={"completion_id": "comp-ready", "pass_result": True,
                      "deliverables": {"score": {"value": 1}}},
            )
            assert resp.status_code == 200, resp.text
        finally:
            app.dependency_overrides.clear()


class TestDeliverableNameCollision:
    """SPEC-172 Step 6: a JSON Deliverable name cannot collide with an
    existing Artifact name."""

    def test_json_name_collides_with_artifact(self, isolated, monkeypatch):
        engine = isolated
        with Session(engine) as s:
            jwt = _seed_leased_attempt(s)
            _seed_artifact_row(s, name="report", status="ready")
        c = _client(engine)
        try:
            resp = c.post(
                "/v1/executor-protocol/v2/attempts/att-deliv/result",
                headers={"Authorization": f"Bearer {jwt}"},
                json={"completion_id": "comp-collide", "pass_result": True,
                      "deliverables": {"report": {"value": "conflict"}}},
            )
            assert resp.status_code == 409, resp.text
            assert "report" in resp.text
        finally:
            app.dependency_overrides.clear()


class TestResultReplaySkipsDeliverablePersistence:
    """SPEC-172 step 7: a replayed result must be detected before deliverable
    persistence, not collide with existing rows."""

    def test_identical_replay_returns_success_without_collision(self, isolated, monkeypatch):
        """After a successful finalization, re-submitting the same completion
        body at the service layer returns True (replay) without attempting to
        persist deliverables again."""
        from apo.services.execution_finalization import precheck_result_replay, AttemptResultBody
        from apo.services.execution_leases import CurrentAttemptLease

        engine = isolated
        with Session(engine) as s:
            jwt = _seed_leased_attempt(s)
        c = _client(engine)
        try:
            result_body = {
                "completion_id": "comp-replay",
                "pass_result": True,
                "deliverables": {"score": {"value": 42}},
            }
            # First submission succeeds.
            resp1 = c.post(
                "/v1/executor-protocol/v2/attempts/att-deliv/result",
                headers={"Authorization": f"Bearer {jwt}"},
                json=result_body,
            )
            assert resp1.status_code == 200, resp1.text
        finally:
            app.dependency_overrides.clear()

        # Second call at the service layer: identical replay.
        with Session(engine) as s:
            lease = CurrentAttemptLease(
                attempt_id="att-deliv", lease_generation=1, executor_id="",
            )
            body = AttemptResultBody(
                completion_id="comp-replay",
                pass_result=True,
                adapter_name=None,
                trace_run_id=None,
                checks=None,
                transcript=None,
                deliverables=None,
                exit_code=None,
                stdout_tail=None,
                stderr_tail=None,
                error_message=None,
                run_configuration=None,
            )
            assert precheck_result_replay(s, lease=lease, body=body) is True


class TestProtocolV2UploadToDownload:
    """SPEC-172 step 8: full protocol-v2 upload → result → manifest → body."""

    def test_full_flow_artifact_upload_then_result_then_download(self, isolated, monkeypatch, tmp_path):
        import hashlib

        monkeypatch.setenv("APO_ARTIFACT_DIR", str(tmp_path))
        engine = isolated
        with Session(engine) as s:
            jwt = _seed_leased_attempt(s)
        c = _client(engine)
        artifact_bytes = b"PK\x03\x04fake-docx-content-for-integration-test"
        artifact_sha = hashlib.sha256(artifact_bytes).hexdigest()

        try:
            # 1. POST artifact upload intent.
            intent_resp = c.post(
                "/v1/agent-task-runs/run-deliv/artifact-uploads",
                headers={"Authorization": f"Bearer {jwt}"},
                json={
                    "name": "report",
                    "display_filename": "report.docx",
                    "media_type": "application/octet-stream",
                    "size_bytes": len(artifact_bytes),
                    "sha256": artifact_sha,
                },
            )
            assert intent_resp.status_code == 201, intent_resp.text
            upload_id = intent_resp.json()["id"]

            # 2. PUT artifact bytes.
            put_resp = c.put(
                f"/v1/agent-task-artifact-uploads/{upload_id}",
                content=artifact_bytes,
                headers={
                    "Authorization": f"Bearer {jwt}",
                    "Content-Type": "application/octet-stream",
                },
            )
            assert put_resp.status_code == 200, put_resp.text

            # 3. POST JSON-only result (artifact is ready, no collision).
            result_resp = c.post(
                "/v1/executor-protocol/v2/attempts/att-deliv/result",
                headers={"Authorization": f"Bearer {jwt}"},
                json={
                    "completion_id": "comp-e2e",
                    "pass_result": True,
                    "deliverables": {"score": {"value": 0.95}},
                },
            )
            assert result_resp.status_code == 200, result_resp.text

            # 4. Verify the deliverable manifest via DB.
            with Session(engine) as s:
                from apo.services.agent_task_deliverables import build_deliverable_manifest
                manifest = build_deliverable_manifest(s, "run-deliv")
                names = {item.name for item in manifest}
                assert "report" in names
                assert "score" in names

                # 5. Verify the artifact body is byte-for-byte identical.
                from apo.services.agent_task_deliverables import load_deliverable_for_download
                row = load_deliverable_for_download(
                    s, project="p1", deliverable_id=upload_id,
                )
                assert row is not None
                assert row.kind == "artifact"
                assert row.status == "ready"
                assert row.sha256 == artifact_sha
                assert row.size_bytes == len(artifact_bytes)

                # Read the stored bytes back through the store.
                from apo.services.artifact_stores.registry import get_store
                store = get_store(row.storage_backend)
                import asyncio

                async def _read_body():
                    chunks = []
                    async for chunk in store.open(row.storage_key):
                        chunks.append(chunk)
                    return b"".join(chunks)

                downloaded = asyncio.run(_read_body())
                assert downloaded == artifact_bytes

            # 6. Verify the task run is terminal.
            with Session(engine) as s:
                run = s.get(AgentTaskRunDB, "run-deliv")
                assert run.status == "passed"
                assert run.deliverables_json is None
        finally:
            app.dependency_overrides.clear()
