# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportReturnType=false, reportCallIssue=false

"""Legacy Task Run readability during the compat window.

Rows written previously have ``deliverables_json`` / ``transcript_json``
populated and no ``AgentTaskDeliverableDB`` rows. They must stay readable via
the detail and manifest endpoints, and the manifest synthesizes from the
legacy column — with no write or backfill occurring.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session
from apo.api import app
from apo.db import get_session
from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB


@pytest.fixture
def client(session: Session) -> Iterator[TestClient]:
    def _override() -> Session:
        return session

    app.dependency_overrides[get_session] = _override
    yield TestClient(app)
    app.dependency_overrides.clear()


def _seed_legacy_run(session: Session, run_id: str = "legacy-1") -> None:
    session.add(
        AgentTaskBatchRunDB(
            id=f"batch-{run_id}", project="default", selection_type="manual", status="completed"
        )
    )
    session.add(
        AgentTaskRunDB(
            id=run_id, batch_run_id=f"batch-{run_id}", task_id="t", task_path="p", status="passed",
            transcript_json={"turns": [{"userAction": {"content": "hi"}}]},
            deliverables_json={"verdict": {"reward": 1}, "log": "legacy body"},
        )
    )
    session.commit()


class TestLegacyReadability:
    def test_detail_still_returns_legacy_columns(self, client: TestClient, session: Session):
        _seed_legacy_run(session)
        resp = client.get("/v1/agent-task-runs/legacy-1")
        assert resp.status_code == 200
        body = resp.json()
        # Legacy columns remain accessible for old callers.
        assert body["deliverables_json"] == {"verdict": {"reward": 1}, "log": "legacy body"}
        assert body["transcript_json"] is not None

    def test_manifest_synthesizes_from_legacy_json(self, client: TestClient, session: Session):
        _seed_legacy_run(session)
        resp = client.get("/v1/agent-task-runs/legacy-1/deliverables")
        assert resp.status_code == 200
        items = resp.json()["items"]
        names = {i["name"] for i in items}
        assert names == {"verdict", "log"}
        # Synthesized rows are metadata-only; no body leaks into the manifest.
        for item in items:
            assert "storage_key" not in item
            assert "inline_value_json" not in item

    def test_legacy_body_round_trips_from_manifest_id(self, client: TestClient, session: Session):
        """Issue #105: the manifest mints ``legacy:<name>`` ids advertised as
        ``status: "ready"``; the body endpoint must resolve that scheme back to
        the inline ``deliverables_json`` body, not 404."""
        _seed_legacy_run(session)
        manifest = client.get("/v1/agent-task-runs/legacy-1/deliverables").json()
        verdict_item = next(i for i in manifest["items"] if i["name"] == "verdict")
        assert verdict_item["id"] == "legacy:verdict"
        assert verdict_item["status"] == "ready"

        body_resp = client.get(
            f"/v1/agent-task-runs/legacy-1/deliverables/{verdict_item['id']}"
        )
        assert body_resp.status_code == 200
        assert body_resp.headers["content-type"] == "application/json; charset=utf-8"
        assert body_resp.json() == {"reward": 1}

    def test_legacy_body_404_for_unknown_name(self, client: TestClient, session: Session):
        _seed_legacy_run(session)
        resp = client.get("/v1/agent-task-runs/legacy-1/deliverables/legacy:missing")
        assert resp.status_code == 404
        assert resp.json()["detail"] == "Deliverable not found"

    def test_new_rows_leave_legacy_columns_null(self, client: TestClient, session: Session):
        session.add(
            AgentTaskBatchRunDB(
                id="b-new", project="default", selection_type="manual", status="completed"
            )
        )
        session.add(
            AgentTaskRunDB(
                id="new-1", batch_run_id="b-new", task_id="t", task_path="p", status="passed",
            )
        )
        session.commit()
        resp = client.get("/v1/agent-task-runs/new-1")
        assert resp.status_code == 200
        body = resp.json()
        assert body["deliverables_json"] is None
        assert body["transcript_json"] is None
        # Empty manifest, no synthesized items.
        manifest = client.get("/v1/agent-task-runs/new-1/deliverables").json()
        assert manifest["items"] == []
