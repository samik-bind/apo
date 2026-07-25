"""Regression coverage for task-detail run-history routing."""

from datetime import datetime, timezone

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.api import app
from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB


def test_task_run_collection_filters_hierarchical_task_id(
    client: TestClient,
    session: Session,
) -> None:
    now = datetime.now(timezone.utc)
    session.add_all(
        [
            _batch("batch-target", "project-1", now),
            _batch("batch-other-task", "project-1", now),
            _batch("batch-other-project", "project-2", now),
        ]
    )
    session.add_all(
        [
            _run(
                "run-target",
                "batch-target",
                "real-agent/documents/data-extraction",
                now,
            ),
            _run("run-other-task", "batch-other-task", "other-task", now),
            _run(
                "run-other-project",
                "batch-other-project",
                "real-agent/documents/data-extraction",
                now,
            ),
        ]
    )
    session.commit()

    response = client.get(
        "/v1/agent-task-runs",
        params={
            "task_id": "real-agent/documents/data-extraction",
            "project": "project-1",
        },
    )

    assert response.status_code == 200
    assert [run["id"] for run in response.json()] == ["run-target"]


def test_task_detail_catch_all_has_no_competing_runs_route() -> None:
    route_paths = {
        route.path for route in app.routes if isinstance(route, APIRoute)
    }

    assert "/v1/agent-tasks/{task_id:path}" in route_paths
    assert "/v1/agent-tasks/{task_id:path}/runs" not in route_paths


def test_batch_list_projects_configuration_summary(
    client: TestClient,
    session: Session,
) -> None:
    """SPEC-148: batch list derives uniform/mixed/partial/unknown from children."""
    now = datetime.now(timezone.utc)
    session.add_all(
        [
            _batch("batch-uniform", "p", now),
            _batch("batch-mixed", "p", now),
            _batch("batch-partial", "p", now),
            _batch("batch-unknown", "p", now),
        ]
    )
    session.add_all(
        [
            _configured_run("u1", "batch-uniform", "terra", "high", now),
            _configured_run("u2", "batch-uniform", "terra", "high", now),
            _configured_run("m1", "batch-mixed", "terra", "low", now),
            _configured_run("m2", "batch-mixed", "opus", "high", now),
            _configured_run("p1", "batch-partial", "terra", "high", now),
            _configured_run("p2", "batch-partial", None, None, now),
            _configured_run("k1", "batch-unknown", None, None, now),
        ]
    )
    session.commit()

    response = client.get("/v1/agent-task-batch-runs", params={"project": "p"})
    assert response.status_code == 200
    by_id = {b["id"]: b for b in response.json()}

    uniform = by_id["batch-uniform"]["configuration"]
    assert uniform["state"] == "uniform"
    assert uniform["reported_task_runs"] == 2
    assert {(c["model"], c["effort"], c["task_runs"]) for c in uniform["configurations"]} == {
        ("terra", "high", 2)
    }

    mixed = by_id["batch-mixed"]["configuration"]
    assert mixed["state"] == "mixed"
    assert {(c["model"], c["effort"], c["task_runs"]) for c in mixed["configurations"]} == {
        ("terra", "low", 1),
        ("opus", "high", 1),
    }

    partial = by_id["batch-partial"]["configuration"]
    assert partial["state"] == "partial"
    assert partial["reported_task_runs"] == 1
    assert partial["total_task_runs"] == 2

    unknown = by_id["batch-unknown"]["configuration"]
    assert unknown["state"] == "unknown"
    assert unknown["configurations"] == []


def test_task_run_list_projects_nested_run_configuration(
    client: TestClient,
    session: Session,
) -> None:
    """SPEC-148: task run list carries nested run_configuration per row."""
    now = datetime.now(timezone.utc)
    session.add_all([_batch("batch-cfg", "p", now)])
    session.add_all(
        [
            _configured_run("cfg-reported", "batch-cfg", "claude-opus-4.1", "high", now),
            _configured_run("cfg-unknown", "batch-cfg", None, None, now),
        ]
    )
    session.commit()

    response = client.get("/v1/agent-task-runs", params={"project": "p"})
    assert response.status_code == 200
    by_id = {r["id"]: r for r in response.json()}

    reported = by_id["cfg-reported"]["run_configuration"]
    assert reported == {"model": "claude-opus-4.1", "effort": "high"}

    assert by_id["cfg-unknown"]["run_configuration"] is None


def _configured_run(
    run_id: str,
    batch_id: str,
    configured_model: str | None,
    configured_effort: str | None,
    started_at: datetime,
) -> AgentTaskRunDB:
    run = _run(run_id, batch_id, "task-1", started_at)
    run.configured_model = configured_model
    run.configured_effort = configured_effort
    return run


# ============================================================================
# SPEC-148: model/effort query filters
# ============================================================================


def test_task_run_list_filters_model_with_or_within_dimension(
    client: TestClient,
    session: Session,
) -> None:
    """Repeated ?model= values OR; a run matches if its model is any of them."""
    now = datetime.now(timezone.utc)
    session.add_all([_batch("b", "proj-filter", now)])
    session.add_all(
        [
            _configured_run("r-terra", "b", "gpt-5.6-terra", "high", now),
            _configured_run("r-opus", "b", "claude-opus-4.1", "high", now),
            _configured_run("r-other", "b", "gemini-2.5", "high", now),
        ]
    )
    session.commit()

    resp = client.get(
        "/v1/agent-task-runs",
        params=[("project", "proj-filter"), ("model", "gpt-5.6-terra"), ("model", "claude-opus-4.1")],
    )
    assert resp.status_code == 200
    ids = {r["id"] for r in resp.json()}
    assert ids == {"r-terra", "r-opus"}


def test_task_run_list_filters_model_and_effort_with_and_across_dimensions(
    client: TestClient,
    session: Session,
) -> None:
    """model and effort AND: only runs matching both dimensions return."""
    now = datetime.now(timezone.utc)
    session.add_all([_batch("b", "proj-filter", now)])
    session.add_all(
        [
            _configured_run("r-th", "b", "terra", "high", now),
            _configured_run("r-tl", "b", "terra", "low", now),
            _configured_run("r-oh", "b", "opus", "high", now),
        ]
    )
    session.commit()

    resp = client.get(
        "/v1/agent-task-runs",
        params={"project": "proj-filter", "model": "terra", "effort": "high"},
    )
    assert resp.status_code == 200
    ids = {r["id"] for r in resp.json()}
    assert ids == {"r-th"}


def test_task_run_list_filter_is_exact_and_case_sensitive(
    client: TestClient,
    session: Session,
) -> None:
    now = datetime.now(timezone.utc)
    session.add_all([_batch("b", "proj-filter", now)])
    session.add_all([_configured_run("r", "b", "Terra", "High", now)])
    session.commit()

    # Wrong case does not match.
    assert {r["id"] for r in client.get("/v1/agent-task-runs", params={"project": "proj-filter", "model": "terra"}).json()} == set()
    # Exact case matches.
    assert {r["id"] for r in client.get("/v1/agent-task-runs", params={"project": "proj-filter", "model": "Terra"}).json()} == {"r"}


def test_batch_run_list_filter_matches_only_when_one_child_satisfies_all_dimensions(
    client: TestClient,
    session: Session,
) -> None:
    """SPEC-148: a batch matches ?model=X&effort=Y only if ONE child has BOTH.

    Never model from one child and effort from another — that would invent a
    configuration that never ran.
    """
    now = datetime.now(timezone.utc)
    session.add_all(
        [
            _batch("b-split", "proj-filter", now),  # terra/low + opus/high
            _batch("b-real", "proj-filter", now),   # terra/high (real pair)
        ]
    )
    session.add_all(
        [
            _configured_run("s1", "b-split", "terra", "low", now),
            _configured_run("s2", "b-split", "opus", "high", now),
            _configured_run("r1", "b-real", "terra", "high", now),
        ]
    )
    session.commit()

    resp = client.get(
        "/v1/agent-task-batch-runs",
        params={"project": "proj-filter", "model": "terra", "effort": "high"},
    )
    assert resp.status_code == 200
    ids = {b["id"] for b in resp.json()}
    # b-split has terra (s1) and high (s2) but no single child with terra+high.
    assert ids == {"b-real"}


def _batch(
    batch_id: str,
    project: str,
    created_at: datetime,
) -> AgentTaskBatchRunDB:
    return AgentTaskBatchRunDB(
        id=batch_id,
        project=project,
        selection_type="task",
        selection_query=None,
        task_root="/tmp/tasks",
        environment="default",
        status="completed",
        total_tasks=1,
        created_at=created_at,
    )


def _run(
    run_id: str,
    batch_id: str,
    task_id: str,
    started_at: datetime,
) -> AgentTaskRunDB:
    return AgentTaskRunDB(
        id=run_id,
        batch_run_id=batch_id,
        task_id=task_id,
        task_path=f"/tmp/tasks/{task_id}",
        status="passed",
        pass_result=True,
        started_at=started_at,
        completed_at=started_at,
    )
