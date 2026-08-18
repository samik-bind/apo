"""Archiving models out of the dashboard's filter dropdowns.

The model palette on the Runs and Tasks pages is derived from the distinct
``configured_model`` values on runs, so it only ever grows. A project member can
retire one from those lists.

The invariants worth pinning are the ones that keep archiving a *display*
decision: an archived model's runs still exist, still count, and are still
reachable by ``?model=``; and a fresh run of an archived model un-archives it.
"""

# pyright: reportAny=false, reportMissingParameterType=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnnecessaryTypeIgnoreComment=false, reportUnusedCallResult=false

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Connection
from sqlmodel import Session, create_engine, select

from apo.db import (
    LATEST_SCHEMA_VERSION,
    _SCHEMA_MIGRATIONS,
    _migrate_archived_model_schema,
)
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ArchivedModelDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
    UserDB,
)
from tests.conftest import seed_project_for_user

_PROJECT = "proj-archive"
_OWNER = "owner-archive"
_OUTSIDER = "outsider-archive"
_TASK = "evals/task-a"
_LIVE = "claude-opus-5"
_DEAD = "pi:claude-opus-5"


def _seed(session: Session) -> None:
    now = datetime.now(timezone.utc)
    session.add(UserDB(id=_OWNER, email="owner-archive@test", name="Owner", password_hash="x"))
    session.flush()
    seed_project_for_user(session, _OWNER, project_id=_PROJECT)
    session.add(
        ProjectTaskSourceDB(
            id="src-archive",
            project=_PROJECT,
            source_type="filesystem",
            status="ready",
            last_synced_at=now,
        )
    )
    session.flush()
    session.add(
        ProjectTaskInventoryDB(
            project=_PROJECT,
            task_source_id="src-archive",
            task_id=_TASK,
            display_name="Task A",
            folder_path="evals",
            task_path=f"/tasks/{_TASK}",
            source_type="filesystem",
        )
    )
    session.add(
        AgentTaskBatchRunDB(
            id="batch-archive",
            project=_PROJECT,
            created_at=now,
            status="completed",
            total_tasks=2,
            task_root="/tasks",
            environment="default",
            selection_type="task",
        )
    )
    for run_id, model in [("run-live", _LIVE), ("run-dead", _DEAD)]:
        session.add(
            AgentTaskRunDB(
                id=run_id,
                batch_run_id="batch-archive",
                task_id=_TASK,
                task_path=f"/tasks/{_TASK}",
                status="passed",
                pass_result=True,
                configured_model=model,
                configured_effort="medium",
                started_at=now,
                completed_at=now,
            )
        )
    session.commit()


@pytest.fixture(name="client")
def client_fixture(session: Session, make_authed_client):
    _seed(session)
    return make_authed_client(_OWNER, session)


def _archive(client: TestClient, model: str, archived: bool = True):
    return client.put(
        f"/v1/projects/{_PROJECT}/archived-models",
        json={"model": model, "archived": archived},
    )


def _task_facets(client: TestClient) -> dict[str, dict[str, object]]:
    resp = client.get(f"/v1/projects/{_PROJECT}/agent-task-run-config-facets")
    assert resp.status_code == 200
    return {f["model"]: f for f in resp.json()}


def _runs_facets(client: TestClient) -> dict[str, dict[str, object]]:
    resp = client.get("/v1/agent-task-batch-runs", params={"project": _PROJECT})
    assert resp.status_code == 200
    return {f["model"]: f for f in resp.json()["model_facets"]}


# ---------------------------------------------------------------------------
# The flag reaches both dropdowns
# ---------------------------------------------------------------------------

def test_models_start_unarchived_on_both_pages(client: TestClient) -> None:
    for facets in (_task_facets(client), _runs_facets(client)):
        assert set(facets) == {_LIVE, _DEAD}
        assert all(f["archived"] is False for f in facets.values())


def test_archiving_flags_the_model_on_both_pages(client: TestClient) -> None:
    """One PUT, and both the Tasks and Runs palettes report it."""
    assert _archive(client, _DEAD).status_code == 200

    for facets in (_task_facets(client), _runs_facets(client)):
        # Still returned — the client hides it, so it can also reveal it to
        # un-archive and can keep rendering it while a filter selects it.
        assert set(facets) == {_LIVE, _DEAD}
        assert facets[_DEAD]["archived"] is True
        assert facets[_LIVE]["archived"] is False


def test_unarchiving_restores_the_model(client: TestClient) -> None:
    _archive(client, _DEAD)
    assert _archive(client, _DEAD, archived=False).status_code == 200
    assert _task_facets(client)[_DEAD]["archived"] is False


def test_archiving_is_idempotent_in_both_directions(client: TestClient) -> None:
    for _ in range(2):
        assert _archive(client, _DEAD).status_code == 200
    assert _task_facets(client)[_DEAD]["archived"] is True

    for _ in range(2):
        assert _archive(client, _DEAD, archived=False).status_code == 200
    assert _task_facets(client)[_DEAD]["archived"] is False


def test_archiving_an_unseen_model_is_accepted(client: TestClient) -> None:
    """There is no model table to validate against, and refusing a name with no
    runs yet would just race ingestion."""
    assert _archive(client, "gpt-6-unreleased").status_code == 200
    # It has no runs, so it isn't in the palette to be flagged.
    assert "gpt-6-unreleased" not in _task_facets(client)


def test_blank_model_is_rejected(client: TestClient) -> None:
    assert _archive(client, "   ").status_code == 422


# ---------------------------------------------------------------------------
# Archiving hides an option, never data
# ---------------------------------------------------------------------------

def test_archived_model_is_still_filterable(client: TestClient) -> None:
    """Invariant: ``?model=`` ignores the archive table, so a shared link or a
    saved view pinned to an archived model keeps working."""
    _archive(client, _DEAD)
    resp = client.get(
        "/v1/agent-task-batch-runs", params={"project": _PROJECT, "model": _DEAD}
    )
    assert resp.status_code == 200
    assert [b["id"] for b in resp.json()["data"]] == ["batch-archive"]


def test_archiving_does_not_change_run_stats(client: TestClient) -> None:
    """Invariant: the runs still count toward all-models stats."""
    before = client.get(f"/v1/projects/{_PROJECT}/agent-task-run-stats").json()
    _archive(client, _DEAD)
    after = client.get(f"/v1/projects/{_PROJECT}/agent-task-run-stats").json()
    assert after == before
    assert after[_TASK]["total_runs"] == 2


def test_archiving_keeps_the_effort_breakdown(client: TestClient) -> None:
    """An archived facet is a full facet — the client still renders it."""
    _archive(client, _DEAD)
    facet = _task_facets(client)[_DEAD]
    assert facet["count"] == 1
    efforts = facet["efforts"]
    assert isinstance(efforts, list)
    assert [e["effort"] for e in efforts] == ["medium"]  # pyright: ignore[reportUnknownVariableType, reportUnknownArgumentType]


# ---------------------------------------------------------------------------
# Scope and access
# ---------------------------------------------------------------------------

def test_archiving_is_shared_across_the_project(
    client: TestClient, session: Session, make_authed_client
) -> None:
    """Archiving is a project decision, not a personal one — a second member
    sees the same palette."""
    _archive(client, _DEAD)
    session.add(
        UserDB(id="member-2", email="member-2@test", name="Member", password_hash="x")
    )
    session.commit()
    seed_project_for_user(session, "member-2", project_id=_PROJECT)
    session.commit()

    other = make_authed_client("member-2", session)
    resp = other.get(f"/v1/projects/{_PROJECT}/agent-task-run-config-facets")
    assert resp.status_code == 200
    assert {f["model"]: f["archived"] for f in resp.json()}[_DEAD] is True


def test_archiving_does_not_leak_across_projects(
    client: TestClient, session: Session, make_authed_client
) -> None:
    session.add(
        UserDB(id="owner-2", email="owner-2@test", name="Owner 2", password_hash="x")
    )
    session.flush()
    seed_project_for_user(session, "owner-2", project_id="proj-other")
    session.commit()
    _archive(client, _DEAD)

    other = make_authed_client("owner-2", session)
    resp = other.get("/v1/projects/proj-other/agent-task-run-config-facets")
    assert resp.status_code == 200
    assert resp.json() == []
    rows = session.exec(select(ArchivedModelDB)).all()
    assert [(r.project_id, r.model) for r in rows] == [(_PROJECT, _DEAD)]


def test_non_member_cannot_archive(session: Session, make_authed_client) -> None:
    _seed(session)
    session.add(
        UserDB(id=_OUTSIDER, email="outsider@test", name="Outsider", password_hash="x")
    )
    session.commit()
    outsider = make_authed_client(_OUTSIDER, session)
    resp = outsider.put(
        f"/v1/projects/{_PROJECT}/archived-models",
        json={"model": _DEAD, "archived": True},
    )
    assert resp.status_code == 403


def test_archiving_records_who_did_it(client: TestClient, session: Session) -> None:
    _archive(client, _DEAD)
    row = session.exec(select(ArchivedModelDB)).one()
    assert row.archived_by_user_id == _OWNER


# ---------------------------------------------------------------------------
# Auto-unarchive on a fresh run
# ---------------------------------------------------------------------------

def test_a_new_run_unarchives_its_model(client: TestClient, session: Session) -> None:
    """Otherwise you would run an archived model and have no way to filter for
    it without knowing to go un-archive it first."""
    from apo.models.schemas import AgentTaskRunConfiguration
    from apo.services.agent_task_runner import finalize_task_run_with_result

    _archive(client, _DEAD)
    assert _task_facets(client)[_DEAD]["archived"] is True

    batch = session.get(AgentTaskBatchRunDB, "batch-archive")
    assert batch is not None
    run = AgentTaskRunDB(
        id="run-dead-again",
        batch_run_id="batch-archive",
        task_id=_TASK,
        task_path=f"/tasks/{_TASK}",
        status="running",
        started_at=datetime.now(timezone.utc),
    )
    session.add(run)
    session.commit()

    finalize_task_run_with_result(
        session,
        run,
        batch,
        adapter_name="test",
        pass_result=True,
        trace_run_id=None,
        checks=[],
        transcript=None,
        deliverables=None,
        run_configuration=AgentTaskRunConfiguration(model=_DEAD, effort="medium"),
    )
    session.commit()

    assert session.exec(select(ArchivedModelDB)).all() == []
    assert _task_facets(client)[_DEAD]["archived"] is False


def test_a_run_leaves_other_archived_models_alone(
    client: TestClient, session: Session
) -> None:
    """Only the model that ran comes back."""
    from apo.models.schemas import AgentTaskRunConfiguration
    from apo.services.agent_task_runner import finalize_task_run_with_result

    _archive(client, _DEAD)
    _archive(client, _LIVE)

    batch = session.get(AgentTaskBatchRunDB, "batch-archive")
    assert batch is not None
    run = AgentTaskRunDB(
        id="run-live-again",
        batch_run_id="batch-archive",
        task_id=_TASK,
        task_path=f"/tasks/{_TASK}",
        status="running",
        started_at=datetime.now(timezone.utc),
    )
    session.add(run)
    session.commit()

    finalize_task_run_with_result(
        session,
        run,
        batch,
        adapter_name="test",
        pass_result=True,
        trace_run_id=None,
        checks=[],
        transcript=None,
        deliverables=None,
        run_configuration=AgentTaskRunConfiguration(model=_LIVE, effort="medium"),
    )
    session.commit()

    facets = _task_facets(client)
    assert facets[_LIVE]["archived"] is False
    assert facets[_DEAD]["archived"] is True


# ---------------------------------------------------------------------------
# Migration
# ---------------------------------------------------------------------------

def test_latest_schema_version_has_registered_migration() -> None:
    assert LATEST_SCHEMA_VERSION in _SCHEMA_MIGRATIONS


def test_migration_creates_the_table_and_is_idempotent() -> None:
    eng = create_engine("sqlite://")
    with eng.begin() as conn:
        _seed_referenced_tables(conn)
        _migrate_archived_model_schema(conn)
        _migrate_archived_model_schema(conn)
        cols = {
            r[1]
            for r in conn.exec_driver_sql("PRAGMA table_info(archived_model)").all()
        }
    assert {"id", "project_id", "model", "archived_by_user_id"} <= cols


def test_migration_enforces_one_row_per_project_and_model() -> None:
    from sqlalchemy.exc import IntegrityError

    eng = create_engine("sqlite://")
    with eng.begin() as conn:
        _seed_referenced_tables(conn)
        _migrate_archived_model_schema(conn)
        conn.exec_driver_sql(
            "INSERT INTO archived_model (id, project_id, model) VALUES ('a', 'p', 'm')"
        )
        with pytest.raises(IntegrityError):
            conn.exec_driver_sql(
                "INSERT INTO archived_model (id, project_id, model) VALUES ('b', 'p', 'm')"
            )


def _seed_referenced_tables(conn: Connection) -> None:
    """The FK targets, so the CREATE TABLE resolves on a bare engine."""
    conn.exec_driver_sql("CREATE TABLE projects (id VARCHAR PRIMARY KEY)")
    conn.exec_driver_sql("CREATE TABLE users (id VARCHAR PRIMARY KEY)")
