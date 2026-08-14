# pyright: reportAny=false, reportArgumentType=false, reportCallIssue=false, reportImplicitStringConcatenation=false, reportMissingParameterType=false, reportMissingTypeArgument=false, reportPrivateUsage=false, reportReturnType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedImport=false, reportUnusedParameter=false

"""Deliverable routes and request-size middleware.

Exercises the registered HTTP routes end-to-end through the TestClient:
manifest fetch (metadata-only), JSON body fetch, two-phase Artifact upload,
and the request-size middleware that rejects oversized bodies before Pydantic
materializes them.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session
from apo.api import app
from apo.db import get_session
from apo.models.db import AgentTaskBatchRunDB, AgentTaskDeliverableDB, AgentTaskRunDB
from apo.services.agent_task_deliverables import INLINE_THRESHOLD_BYTES


@pytest.fixture
def client(session: Session) -> Iterator[TestClient]:
    def _override() -> Session:
        return session

    app.dependency_overrides[get_session] = _override
    yield TestClient(app)
    app.dependency_overrides.clear()


def _seed(session: Session, run_id: str = "run-1", project: str = "default") -> None:
    session.add(
        AgentTaskBatchRunDB(
            id=f"batch-{run_id}", project=project, selection_type="manual", status="running"
        )
    )
    session.add(
        AgentTaskRunDB(
            id=run_id, batch_run_id=f"batch-{run_id}", task_id="t", task_path="p",
            status="running",
        )
    )
    session.commit()


def _add_inline_deliverable(
    session: Session, run_id: str, name: str, value: object, project: str = "default"
) -> AgentTaskDeliverableDB:
    import json

    body = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    row = AgentTaskDeliverableDB(
        id=f"dlv-{name}-{run_id}",
        project=project,
        task_run_id=run_id,
        name=name,
        kind="json",
        status="ready",
        storage_backend=None,
        storage_key=None,
        inline_value_json={"value": value},
        media_type="application/json",
        content_encoding="identity",
        size_bytes=len(body),
        stored_size_bytes=len(body),
        sha256=hashlib.sha256(body).hexdigest(),
        created_at=datetime.now(timezone.utc),
        ready_at=datetime.now(timezone.utc),
    )
    session.add(row)
    session.commit()
    return row


class TestDeliverableRoutes:
    def test_manifest_returns_metadata_only(self, client: TestClient, session: Session):
        _seed(session)
        _add_inline_deliverable(session, "run-1", "verdict", {"reward": 1})

        resp = client.get("/v1/agent-task-runs/run-1/deliverables")
        assert resp.status_code == 200
        body = resp.json()
        assert body["task_run_id"] == "run-1"
        assert len(body["items"]) == 1
        item = body["items"][0]
        assert item["name"] == "verdict"
        assert item["kind"] == "json"
        # The response never leaks storage internals or bodies.
        assert "storage_key" not in item
        assert "inline_value_json" not in item
        assert "value" not in item

    def test_json_body_round_trips(self, client: TestClient, session: Session):
        _seed(session)
        row = _add_inline_deliverable(session, "run-1", "report", {"k": "v", "n": 3})

        resp = client.get("/v1/agent-task-runs/run-1/deliverables/dlv-report-run-1")
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "application/json; charset=utf-8"
        assert resp.json() == {"k": "v", "n": 3}
        assert resp.headers["etag"].strip('"') == row.sha256

    def test_unknown_run_404(self, client: TestClient):
        resp = client.get("/v1/agent-task-runs/missing/deliverables")
        assert resp.status_code == 404

    def test_unknown_deliverable_404(self, client: TestClient, session: Session):
        _seed(session)
        resp = client.get("/v1/agent-task-runs/run-1/deliverables/dlv-missing")
        assert resp.status_code == 404

    def test_two_phase_artifact_upload_round_trip(
        self, client: TestClient, session: Session, tmp_path, monkeypatch
    ):
        # Point the local store at a writable tmp dir.
        monkeypatch.setenv("APO_ARTIFACT_DIR", str(tmp_path / "artifacts"))
        _seed(session)
        data = b"artifact contents here"
        digest = hashlib.sha256(data).hexdigest()

        intent = client.post(
            "/v1/agent-task-runs/run-1/artifact-uploads",
            json={
                "name": "log",
                "display_filename": "verifier.log",
                "media_type": "text/plain",
                "size_bytes": len(data),
                "sha256": digest,
            },
        )
        assert intent.status_code == 201, intent.text
        upload_id = intent.json()["id"]
        assert intent.json()["deliverable"]["status"] == "pending"

        upload = client.put(
            f"/v1/agent-task-artifact-uploads/{upload_id}",
            content=data,
            headers={"Content-Type": "application/octet-stream"},
        )
        assert upload.status_code == 200, upload.text
        assert upload.json()["status"] == "ready"

        # Download the artifact back.
        resp = client.get(f"/v1/agent-task-runs/run-1/deliverables/{upload_id}")
        assert resp.status_code == 200
        assert resp.content == data
        assert resp.headers["content-type"].startswith("text/plain")
        assert resp.headers["x-content-type-options"] == "nosniff"
        assert "attachment" in resp.headers["content-disposition"]

    def test_digest_mismatch_returns_422(
        self, client: TestClient, session: Session, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("APO_ARTIFACT_DIR", str(tmp_path / "artifacts"))
        _seed(session)
        declared = b"correct bytes"  # 13 bytes
        digest = hashlib.sha256(declared).hexdigest()
        intent = client.post(
            "/v1/agent-task-runs/run-1/artifact-uploads",
            json={
                "name": "log", "display_filename": "v.log", "media_type": "text/plain",
                "size_bytes": len(declared), "sha256": digest,
            },
        )
        assert intent.status_code == 201
        upload_id = intent.json()["id"]

        upload = client.put(
            f"/v1/agent-task-artifact-uploads/{upload_id}",
            content=b"XXXXXXXXXXXXX",  # 13 bytes, different content -> digest mismatch
            headers={"Content-Type": "application/octet-stream"},
        )
        assert upload.status_code == 422

    def test_terminal_run_rejects_new_upload_409(
        self, client: TestClient, session: Session, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("APO_ARTIFACT_DIR", str(tmp_path / "artifacts"))
        _seed(session)
        run = session.get(AgentTaskRunDB, "run-1")
        assert run is not None
        run.status = "passed"
        session.add(run)
        session.commit()

        intent = client.post(
            "/v1/agent-task-runs/run-1/artifact-uploads",
            json={
                "name": "log", "display_filename": "v.log", "media_type": "text/plain",
                "size_bytes": 10, "sha256": hashlib.sha256(b"x" * 10).hexdigest(),
            },
        )
        assert intent.status_code == 409


class TestRequestSizeMiddleware:
    def test_result_body_over_limit_rejected_before_pydantic(
        self, client: TestClient, session: Session, monkeypatch
    ):
        _seed(session)
        # A result body over 10 MiB is rejected with 413 before JSON parsing.
        big = {"x": "a" * (11 * 1024 * 1024)}
        resp = client.post("/v1/agent-task-runs/run-1/result", json=big)
        assert resp.status_code == 413

    def test_result_body_under_limit_accepted_for_parsing(
        self, client: TestClient, session: Session
    ):
        _seed(session)
        # A small body passes the size gate (it may still 4xx on validation).
        resp = client.post(
            "/v1/agent-task-runs/run-1/result",
            json={"pass_result": True},
        )
        # Authorization/semantics may reject, but NOT with 413.
        assert resp.status_code != 413
