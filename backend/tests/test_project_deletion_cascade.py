# pyright: reportAny=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUnusedImport=false, reportUnusedVariable=false
# pyright: reportAttributeAccessIssue=false, reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false

"""SPEC-169 #96: project deletion survives caller-created execution state.

Two defects:
1. agent_task_runs deleted before task_execution_attempts (FK violation).
2. task_definition_revisions missing from the cascade (FK violation on
   the final project delete).
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlmodel import Session, SQLModel, create_engine, select
from sqlalchemy.pool import StaticPool

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ApiKeyDB,
    ProjectDB,
    ProjectMembershipDB,
    TaskDefinitionRevisionDB,
    TaskExecutionAttemptDB,
    UserDB,
)
from apo.services.project_deletion import delete_project_data


@pytest.fixture
def session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def _seed_project_with_caller_run(session):
    """Create a project with a caller-created Attempt + Definition Revision."""
    u = UserDB(email="t@t.com", name="T", password_hash="x", is_active=True)
    session.add(u)
    session.commit()
    session.refresh(u)

    session.add(ProjectDB(id="p1", name="P", created_by=u.id))
    session.commit()

    now = datetime.now(timezone.utc)
    session.add(ProjectMembershipDB(
        project_id="p1", user_id=u.id, role="owner", created_at=now, updated_at=now,
    ))

    # Definition Revision (SPEC-169)
    rev = TaskDefinitionRevisionDB(
        project="p1", task_id="demo",
        schema_version=1,
        content_sha256="sha256:abc",
        source_files_json=[{"path": "demo.eval.ts", "content": "task('demo', {});"}],
        source_size_bytes=20,
    )
    session.add(rev)

    # Batch + Run + Attempt (like caller create-and-claim creates)
    batch = AgentTaskBatchRunDB(
        id="bch-1", project="p1", selection_type="caller", status="completed",
        created_at=now,
    )
    session.add(batch)
    session.flush()

    run = AgentTaskRunDB(
        id="run-1", batch_run_id="bch-1", task_id="demo", task_path="demo",
        task_definition_revision_id=rev.id,
        status="completed",
    )
    session.add(run)
    session.flush()

    attempt = TaskExecutionAttemptDB(
        id="att-1", project="p1", batch_run_id="bch-1", task_run_id="run-1",
        task_revision_id="rev-1", sequence_index=0, target_kind="caller",
        assignment_kind="caller",
        status="succeeded",
        queue_expires_at=now,
        queued_at=now,
    )
    session.add(attempt)
    session.commit()


class TestProjectDeletionCascade:
    def test_deletes_project_with_attempts_and_definitions(self, session):
        _seed_project_with_caller_run(session)

        # Before: project, run, attempt, definition all exist
        assert session.get(ProjectDB, "p1") is not None
        assert session.get(AgentTaskRunDB, "run-1") is not None
        assert session.get(TaskExecutionAttemptDB, "att-1") is not None
        defs = session.exec(select(TaskDefinitionRevisionDB).where(TaskDefinitionRevisionDB.project == "p1")).all()
        assert len(defs) == 1

        result = delete_project_data(session, "p1", keep_project=False, keep_api_keys=False)

        # After: everything is gone
        assert session.get(ProjectDB, "p1") is None
        assert session.get(AgentTaskRunDB, "run-1") is None
        assert session.get(TaskExecutionAttemptDB, "att-1") is None
        defs_after = session.exec(select(TaskDefinitionRevisionDB).where(TaskDefinitionRevisionDB.project == "p1")).all()
        assert len(defs_after) == 0

    def test_reset_keeps_project_but_clears_runs(self, session):
        _seed_project_with_caller_run(session)

        result = delete_project_data(session, "p1", keep_project=True, keep_api_keys=False)

        # Project survives
        assert session.get(ProjectDB, "p1") is not None
        # But runs/attempts/definitions are cleared
        assert session.get(AgentTaskRunDB, "run-1") is None
        assert session.get(TaskExecutionAttemptDB, "att-1") is None
