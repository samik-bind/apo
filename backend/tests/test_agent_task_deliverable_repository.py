# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportReturnType=false, reportCallIssue=false

"""AgentTaskDeliverableDB repository + projection queries.

The repository owns Deliverable identity and metadata. List/manifest queries
must select metadata columns only — never inline bodies or storage keys — so a
task-run detail or list request cannot accidentally load a multi-megabyte
Deliverable body.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlmodel import Session, select, text
from apo.db import engine, reset_apo_file_db
from apo.models.db import AgentTaskBatchRunDB, AgentTaskDeliverableDB, AgentTaskRunDB


@pytest.fixture(autouse=True)
def setup_database():
    reset_apo_file_db()
    yield
    with Session(engine) as session:
        session.execute(text("DELETE FROM agent_task_deliverables"))
        session.execute(text("DELETE FROM agent_task_runs"))
        session.execute(text("DELETE FROM agent_task_batch_runs"))
        session.commit()


def _seed_run(session: Session, run_id: str, project: str = "p1") -> None:
    """Seed a batch + task run so the deliverable FK is satisfiable."""
    session.add(
        AgentTaskBatchRunDB(
            id=f"batch-{run_id}",
            project=project,
            selection_type="manual",
            status="completed",
        )
    )
    session.add(
        AgentTaskRunDB(
            id=run_id,
            batch_run_id=f"batch-{run_id}",
            task_id="t",
            task_path="p",
            status="completed",
        )
    )
    session.flush()


def _make_deliverable(
    run_id: str = "run-1",
    project: str = "p1",
    name: str = "verdict",
    *,
    kind: str = "json",
    inline: dict[str, object] | None = None,
) -> AgentTaskDeliverableDB:
    return AgentTaskDeliverableDB(
        id=f"dlv-{name}-{run_id}",
        project=project,
        task_run_id=run_id,
        name=name,
        kind=kind,
        status="ready",
        storage_backend=None,
        storage_key=None,
        inline_value_json=inline if inline is not None else {"value": 1},
        display_filename=None,
        media_type="application/json",
        content_encoding="identity",
        size_bytes=13,
        stored_size_bytes=13,
        sha256="a" * 64,
        created_at=datetime.now(timezone.utc),
        ready_at=datetime.now(timezone.utc),
    )


class TestDeliverableRepository:
    def test_create_and_read_deliverable(self):
        with Session(engine) as session:
            _seed_run(session, "run-1")
            session.add(_make_deliverable(run_id="run-1", name="verdict"))
            session.commit()

        with Session(engine) as session:
            row = session.get(AgentTaskDeliverableDB, "dlv-verdict-run-1")
            assert row is not None
            assert row.kind == "json"
            assert row.status == "ready"
            assert row.inline_value_json == {"value": 1}

    def test_unique_name_per_task_run(self):
        """Two deliverables with the same name under one run must collide."""
        with Session(engine) as session:
            _seed_run(session, "run-1")
            session.add(_make_deliverable(run_id="run-1", name="dup"))
            session.commit()

            session.add(_make_deliverable(run_id="run-1", name="dup", inline={"v": 2}))
            with pytest.raises(Exception):
                session.commit()

    def test_same_name_allowed_across_runs(self):
        """The uniqueness scope is (project, task_run_id, name), not global."""
        with Session(engine) as session:
            _seed_run(session, "run-1")
            _seed_run(session, "run-2")
            session.add(_make_deliverable(run_id="run-1", name="verdict"))
            session.add(_make_deliverable(run_id="run-2", name="verdict"))
            session.commit()

        with Session(engine) as session:
            rows = session.exec(
                select(AgentTaskDeliverableDB).where(
                    AgentTaskDeliverableDB.name == "verdict"
                )
            ).all()
            assert {r.task_run_id for r in rows} == {"run-1", "run-2"}

    def test_projection_query_selects_metadata_only(self):
        """A manifest projection must not load inline_value_json or storage_key."""
        with Session(engine) as session:
            _seed_run(session, "run-1")
            session.add(_make_deliverable(run_id="run-1", name="big"))
            session.commit()

        with Session(engine) as session:
            # The manifest projection: metadata columns only.
            cols = (
                AgentTaskDeliverableDB.id,
                AgentTaskDeliverableDB.name,
                AgentTaskDeliverableDB.kind,
                AgentTaskDeliverableDB.status,
                AgentTaskDeliverableDB.media_type,
                AgentTaskDeliverableDB.display_filename,
                AgentTaskDeliverableDB.size_bytes,
                AgentTaskDeliverableDB.sha256,
            )
            row = session.exec(
                select(*cols).where(AgentTaskDeliverableDB.task_run_id == "run-1")
            ).one()
            # 8 metadata columns returned, none of them bodies.
            assert len(row) == 8
            assert row[1] == "big"

    def test_list_by_project_is_scoped(self):
        """The project index supports direct project-scoped listing."""
        with Session(engine) as session:
            _seed_run(session, "run-a", project="alpha")
            _seed_run(session, "run-b", project="beta")
            session.add(_make_deliverable(run_id="run-a", project="alpha", name="v1"))
            session.add(_make_deliverable(run_id="run-b", project="beta", name="v2"))
            session.commit()

        with Session(engine) as session:
            alpha = session.exec(
                select(AgentTaskDeliverableDB.id).where(
                    AgentTaskDeliverableDB.project == "alpha"
                )
            ).all()
            assert alpha == ["dlv-v1-run-a"]
