# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportReturnType=false, reportCallIssue=false

"""Finalization no longer duplicates transcript/body.

New recorded Task Runs leave ``transcript_json`` null (the Trace is the
conversation source) and the linked trace row's ``output`` carries only a
compact Deliverable manifest (name/kind/size), never a body.
"""

from __future__ import annotations

import pytest
from sqlmodel import Session, select, text
from apo.db import engine, reset_apo_file_db
from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB, RunDB
from apo.services.agent_task_runner import finalize_task_run_with_result
from apo.services.check_report_storage import load_check_report
from apo.services.trace_backend import get_trace_backend


@pytest.fixture(autouse=True)
def setup_database():
    reset_apo_file_db()
    yield
    with Session(engine) as session:
        session.execute(text("DELETE FROM agent_task_deliverables"))
        session.execute(text("DELETE FROM agent_task_runs"))
        session.execute(text("DELETE FROM agent_task_batch_runs"))
        session.execute(text("DELETE FROM runs"))
        session.commit()


def _seed(project: str = "p1") -> tuple[AgentTaskBatchRunDB, AgentTaskRunDB, RunDB]:
    with Session(engine) as session:
        batch = AgentTaskBatchRunDB(
            id="batch-1", project=project, selection_type="manual", status="running"
        )
        run = AgentTaskRunDB(
            id="run-1", batch_run_id="batch-1", task_id="t", task_path="p", status="running"
        )
        trace = RunDB(
            id="trace-1", project=project, environment="default", call_count=0
        )
        session.add(batch)
        session.add(run)
        session.add(trace)
        session.commit()
        session.refresh(batch)
        session.refresh(run)
        session.refresh(trace)
    return batch, run, trace


def _get_trace(session: Session, trace_id: str, project: str = "p1") -> RunDB | None:
    return session.exec(
        select(RunDB).where(RunDB.id == trace_id, RunDB.project == project)
    ).first()


class TestFinalizationStorageBoundary:
    def test_new_finalize_leaves_transcript_null(self):
        batch, run, _ = _seed()
        with Session(engine) as session:
            task_run = session.get(AgentTaskRunDB, run.id)
            batch_row = session.get(AgentTaskBatchRunDB, batch.id)
            assert task_run is not None and batch_row is not None
            finalize_task_run_with_result(
                session,
                task_run,
                batch_row,
                adapter_name="harbor",
                pass_result=True,
                trace_run_id="trace-1",
                checks=[{"name": "ok", "pass": True, "received": "good"}],
                transcript=None,  # new SDK omits transcript
                deliverables=None,
            )
            session.commit()

            refreshed = session.get(AgentTaskRunDB, run.id)
            assert refreshed is not None
            assert refreshed.transcript_json is None
            assert refreshed.deliverables_json is None
            assert refreshed.status == "passed"

    def test_legacy_caller_still_persists_transcript_for_compat(self):
        batch, run, _ = _seed()
        transcript = {"turns": [{"userAction": {"content": "hi"}}]}
        with Session(engine) as session:
            task_run = session.get(AgentTaskRunDB, run.id)
            batch_row = session.get(AgentTaskBatchRunDB, batch.id)
            assert task_run is not None and batch_row is not None
            finalize_task_run_with_result(
                session,
                task_run,
                batch_row,
                adapter_name=None,
                pass_result=True,
                trace_run_id="trace-1",
                checks=[],
                transcript=transcript,
                deliverables={"verdict": {"reward": 1}},
            )
            session.commit()
            refreshed = session.get(AgentTaskRunDB, run.id)
            assert refreshed is not None
            assert refreshed.transcript_json == transcript
            assert refreshed.deliverables_json == {"verdict": {"reward": 1}}

    def test_trace_output_is_compact_manifest_not_body(self):
        """RunDB.output carries name/kind/size, never the full deliverable body."""
        batch, run, _ = _seed()
        # A "large" legacy deliverable body that must NOT be copied wholesale.
        big_body = {"report": "x" * 50_000}
        with Session(engine) as session:
            task_run = session.get(AgentTaskRunDB, run.id)
            batch_row = session.get(AgentTaskBatchRunDB, batch.id)
            assert task_run is not None and batch_row is not None
            finalize_task_run_with_result(
                session,
                task_run,
                batch_row,
                adapter_name=None,
                pass_result=True,
                trace_run_id="trace-1",
                checks=[],
                transcript=None,
                deliverables=big_body,
            )
            session.commit()

            trace = _get_trace(session, "trace-1")
            assert trace is not None
            assert trace.output is not None
            # Output is the manifest wrapper, not the body.
            assert isinstance(trace.output, dict)
            assert trace.output.get("type") == "apo.task-deliverables"
            items = trace.output.get("items")
            assert isinstance(items, list) and items
            item = items[0]
            assert set(item.keys()) == {"name", "kind", "size_bytes"}
            # The 50 KiB body string is NOT present in the trace row.
            assert "x" * 1000 not in str(trace.output)

    def test_checks_are_normalized_on_finalize(self):
        batch, run, _ = _seed()
        big = "y" * (1024 * 1024)  # 1 MiB received value
        with Session(engine) as session:
            task_run = session.get(AgentTaskRunDB, run.id)
            batch_row = session.get(AgentTaskBatchRunDB, batch.id)
            assert task_run is not None and batch_row is not None
            finalize_task_run_with_result(
                session,
                task_run,
                batch_row,
                adapter_name=None,
                pass_result=False,
                trace_run_id="trace-1",
                checks=[{"name": "big", "pass": False, "received": big}],
                transcript=None,
                deliverables=None,
            )
            session.commit()
            refreshed = session.get(AgentTaskRunDB, run.id)
            assert refreshed is not None
            # evidence lives in the check report row, not checks_json.
            assert refreshed.checks_json is None
            checks = load_check_report(session, refreshed.id) or []
            assert isinstance(checks[0]["received"], dict)
            assert checks[0]["received"]["kind"] == "truncated"  # type: ignore[index]
            assert "y" * 1000 not in str(checks)
