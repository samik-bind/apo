"""Issue #149: errored generations are execution evidence, not a score.

The fixture goes through the real OTLP receiver so status codes, finish reasons,
usage, projected calls, Task Run aggregation, and finalization are exercised as
one contract.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB
from apo.services.agent_task_runner import finalize_task_run_with_result
from apo.services.otlp_receiver import OtlpReceiver
from apo.services.agent_task_projection import to_task_run_summary
from apo.services.trace_backend import NativeTraceBackend

TRACE_ID = "14914914914914914914914914914914"
ROOT_SPAN_ID = "1491491491491491"
NOW = datetime(2026, 8, 19, tzinfo=timezone.utc)


@pytest.fixture
def session() -> Session:  # pyright: ignore[reportInvalidTypeForm]
    engine = create_engine("sqlite://", poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)
    value = Session(engine)
    yield value  # pyright: ignore[reportReturnType]
    value.close()


def test_persisted_failure_shape_rolls_up_17_of_22_and_partial_usage(
    session: Session,
) -> None:
    _ingest_generation_fixture(session, healthy=5, errored=17)
    task_run = _task_run()
    session.add(task_run)
    session.commit()

    NativeTraceBackend().aggregate_costs(session, task_run, "p1")

    assert task_run.generation_execution_json == {
        "total": 22,
        "errored": 17,
        "error_finish_reasons": {"error": 17},
    }
    # Five healthy calls at 10,000 micro-USD and 12 tokens each. The 17
    # errored calls' zero/missing-looking usage is not treated as measured.
    assert task_run.total_cost == 50_000.0
    assert task_run.total_tokens == 60
    public_summary = to_task_run_summary(task_run).generation_execution
    assert public_summary is not None
    assert public_summary.model_dump() == task_run.generation_execution_json


def test_predominantly_errored_generations_suppress_pass_fail_verdict(
    session: Session,
) -> None:
    _ingest_generation_fixture(session, healthy=5, errored=17)
    batch = AgentTaskBatchRunDB(
        id="batch-1", project="p1", selection_type="manual", status="running"
    )
    task_run = _task_run()
    session.add(batch)
    session.add(task_run)
    session.commit()

    finalize_task_run_with_result(
        session,
        task_run,
        batch,
        adapter_name="fixture",
        pass_result=False,
        trace_run_id=TRACE_ID,
        checks=[
            {"id": "one", "pass": True, "reasoning": "diagnostic"},
            {"id": "two", "pass": False, "reasoning": "diagnostic"},
        ],
        transcript=None,
        deliverables=None,
    )

    assert task_run.status == "error"
    assert task_run.pass_result is None
    assert task_run.total_checks == 2
    assert task_run.passed_checks == 1
    assert task_run.failed_checks == 1
    assert task_run.error_message is not None
    assert "17 of 22 generations ended in error" in task_run.error_message
    assert "verdict" in task_run.error_message.lower()


def test_recovered_generation_error_keeps_normal_verdict(session: Session) -> None:
    _ingest_generation_fixture(session, healthy=2, errored=1)
    batch = AgentTaskBatchRunDB(
        id="batch-1", project="p1", selection_type="manual", status="running"
    )
    task_run = _task_run()
    session.add(batch)
    session.add(task_run)
    session.commit()

    finalize_task_run_with_result(
        session,
        task_run,
        batch,
        adapter_name="fixture",
        pass_result=True,
        trace_run_id=TRACE_ID,
        checks=[{"id": "one", "pass": True, "reasoning": "ok"}],
        transcript=None,
        deliverables=None,
    )

    assert task_run.status == "passed"
    assert task_run.pass_result is True
    assert task_run.generation_execution_json == {
        "total": 3,
        "errored": 1,
        "error_finish_reasons": {"error": 1},
    }


def _task_run() -> AgentTaskRunDB:
    return AgentTaskRunDB(
        id="run-1",
        batch_run_id="batch-1",
        task_id="task/x",
        task_path="task/x",
        status="running",
        trace_run_id=TRACE_ID,
    )


def _ingest_generation_fixture(
    session: Session, *, healthy: int, errored: int
) -> None:
    spans: list[dict[str, object]] = [
        {
            "traceId": TRACE_ID,
            "spanId": ROOT_SPAN_ID,
            "name": "agent-task",
            "startTimeUnixNano": "1787137200000000000",
            "endTimeUnixNano": "1787137201000000000",
            "status": {"code": 1},
            "attributes": [],
        }
    ]
    for index in range(healthy + errored):
        is_error = index >= healthy
        spans.append(
            {
                "traceId": TRACE_ID,
                "spanId": f"{index + 1:016x}",
                "parentSpanId": ROOT_SPAN_ID,
                "name": "chat fixture-model",
                "startTimeUnixNano": str(1787137200000000000 + index * 1000),
                "endTimeUnixNano": str(1787137200000000500 + index * 1000),
                "status": {
                    "code": 2 if is_error else 1,
                    **({"message": "provider stream failed"} if is_error else {}),
                },
                "attributes": _generation_attributes(is_error),
            }
        )

    payload: dict[str, object] = {
        "resourceSpans": [
            {
                "resource": {"attributes": []},
                "scopeSpans": [{"scope": {"name": "issue-149"}, "spans": spans}],
            }
        ]
    }
    result = OtlpReceiver().ingest(
        payload=json.dumps(payload).encode(),
        content_type="application/json",
        project_id="p1",
        session=session,
    )
    assert result.rejected == 0
    assert result.accepted == healthy + errored + 1


def _generation_attributes(is_error: bool) -> list[dict[str, object]]:
    return [
        {
            "key": "gen_ai.operation.name",
            "value": {"stringValue": "chat"},
        },
        {
            "key": "gen_ai.request.model",
            "value": {"stringValue": "fixture-model"},
        },
        {
            "key": "gen_ai.response.finish_reasons",
            "value": {
                "arrayValue": {
                    "values": [
                        {"stringValue": "error" if is_error else "stop"}
                    ]
                }
            },
        },
        {
            "key": "gen_ai.usage.input_tokens",
            "value": {"intValue": "0" if is_error else "10"},
        },
        {
            "key": "gen_ai.usage.output_tokens",
            "value": {"intValue": "0" if is_error else "2"},
        },
        {
            "key": "apo.observation.cost.amount",
            "value": {"doubleValue": 0.0 if is_error else 0.01},
        },
    ]
