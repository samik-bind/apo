# pyright: reportAny=false, reportExplicitAny=false, reportMissingParameterType=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

"""Deterministic fixtures for the backend benchmark suite.

The suite is dual-use: without ``--codspeed`` these tests run once each as
ordinary smoke tests inside the normal ``pytest`` gate; with the flag the same
tests are measured (simulation mode inside CodSpeed's runner, wall-time
locally). The builders therefore carry a determinism contract: counter-derived
hex ids and fixed literal timestamps — no ``random``, no ``datetime.now`` —
so a regression report measures the code, not fixture drift.

The seeded span store reuses the shared in-memory engine from the top-level
conftest (never a second harness) and seeds through the PUBLIC write paths —
``OtlpReceiver.ingest`` for canonical spans, ``NativeTraceRepository`` for the
projected run/call rows — once per process, outside every measured region.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

import pytest
from sqlalchemy.exc import OperationalError
from sqlmodel import Session, SQLModel, col, select

from apo.models.db import RunDB
from apo.services.otlp_receiver import OtlpReceiver
from apo.services.trace_repository import NativeTraceRepository
from tests.conftest import engine

BENCH_PROJECT = "bench-perf"
MODEL_NAME = "gpt-4o-mini"

# Store shape: 100 traces x 10 spans seeded through the real write paths —
# large enough that a per-call scan cost dominates, small enough that
# seeding stays a one-time constant of the run.
SPANS_PER_TRACE = 10
STORE_TRACE_COUNT = 100
STORE_SPAN_COUNT = STORE_TRACE_COUNT * SPANS_PER_TRACE
DECODE_SPAN_COUNT = 50

_SERVICES: tuple[str, str] = ("apo-agent", "apo-tools")
_SPAN_NAMES: tuple[str, str, str] = ("llm.complete", "tool.execute", "agent.step")
_SPAN_KINDS: tuple[int, int, int] = (1, 3, 1)  # INTERNAL, CLIENT, INTERNAL

# Fixed wall-clock anchor: 2026-09-01T00:00:00Z as a literal, never now().
_BASE_EPOCH_SECONDS = 1_788_220_800
_BASE_TIME = datetime(2026, 9, 1, tzinfo=timezone.utc)


def bench_trace_id(trace_no: int) -> str:
    """Deterministic 32-hex trace id (counter-derived, never all-zero)."""
    return format(trace_no + 1, "032x")


def bench_span_id(counter: int) -> str:
    """Deterministic 16-hex span id (counter-derived, never all-zero)."""
    return format(counter + 1, "016x")


def _to_anyvalue(value: Any) -> dict[str, Any]:
    """Typed dict value → OTLP/JSON AnyValue container."""
    if isinstance(value, bool):
        return {"boolValue": value}
    if isinstance(value, int):
        return {"intValue": value}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, str):
        return {"stringValue": value}
    if isinstance(value, dict):
        return {
            "kvlistValue": {
                "values": [
                    {"key": key, "value": _to_anyvalue(item)}
                    for key, item in value.items()
                ]
            }
        }
    raise TypeError(f"unsupported benchmark attribute type: {type(value)!r}")


def _bench_attributes(counter: int) -> dict[str, Any]:
    """Attributes shaped like real LLM-stack spans: str/int/float/bool/nested."""
    kind = counter % 3
    trace_no = counter // SPANS_PER_TRACE
    if kind == 0:  # llm.complete
        return {
            "gen_ai.request.model": MODEL_NAME,
            "gen_ai.usage.completion_tokens": 128,
            "gen_ai.usage.latency_ms": 42.5,
            "customer.tier": "enterprise" if trace_no % 2 == 0 else "free",
            "stream": True,
        }
    if kind == 1:  # tool.execute
        return {
            "tool.name": "search_invoices",
            "db.statement": "SELECT id FROM invoices WHERE customer_id = ?",
            "http.response.status_code": 200,
        }
    return {  # agent.step
        "agent.step.number": counter,
        "http.response.status_code": 200,
        "delivery": {"attempt": 1, "cached": False},
    }


def build_span(counter: int) -> dict[str, Any]:
    """One OTLP/JSON span dict derived purely from the counter.

    Span kinds rotate across the LLM-typical mix (llm call / tool call /
    agent step); spans after a trace's root parent to that root. Even
    traces belong to ``apo-agent``, odd to ``apo-tools``.
    """
    trace_no = counter // SPANS_PER_TRACE
    start_nano = _BASE_EPOCH_SECONDS * 1_000_000_000 + counter * 1_000_000
    span: dict[str, Any] = {
        "traceId": bench_trace_id(trace_no),
        "spanId": bench_span_id(counter),
        "name": _SPAN_NAMES[counter % 3],
        "kind": _SPAN_KINDS[counter % 3],
        "startTimeUnixNano": str(start_nano),
        "endTimeUnixNano": str(start_nano + 50_000_000),
        "attributes": [
            {"key": key, "value": _to_anyvalue(value)}
            for key, value in _bench_attributes(counter).items()
        ],
        "status": {"code": 1},
    }
    if counter % SPANS_PER_TRACE != 0:
        span["parentSpanId"] = bench_span_id(trace_no * SPANS_PER_TRACE)
    return span


def build_otlp_json_body(span_count: int = DECODE_SPAN_COUNT) -> bytes:
    """A deterministic OTLP/JSON ExportTraceServiceRequest body.

    Split into one resourceSpans entry per service so facet benchmarks
    count more than a single bucket. Byte-identical for identical
    ``span_count`` — pinned by ``test_fixture_determinism.py``.
    """
    resource_spans: list[dict[str, Any]] = []
    for service in _SERVICES:
        spans = [
            build_span(counter)
            for counter in range(span_count)
            if (counter // SPANS_PER_TRACE) % 2 == _SERVICES.index(service)
        ]
        resource_spans.append(
            {
                "resource": {
                    "attributes": [
                        {"key": "service.name", "value": {"stringValue": service}}
                    ]
                },
                "scopeSpans": [
                    {
                        "scope": {"name": "apo.benchmarks", "version": "1.0.0"},
                        "spans": spans,
                    }
                ],
            }
        )
    return json.dumps({"resourceSpans": resource_spans}).encode("utf-8")


def _store_trace_count() -> int:
    """Bench-project trace rows, or -1 when the schema is absent."""
    try:
        with Session(engine) as session:
            rows = session.exec(
                select(RunDB.id).where(col(RunDB.project) == BENCH_PROJECT)
            ).all()
    except OperationalError:
        return -1
    return len(rows)


def _seed_store() -> None:
    """Seed the store once, entirely through the public write paths.

    ``project_immediately=False`` keeps the receiver from projecting; the
    projected run/call rows are written through the repository directly so
    each store is populated by its own boundary. One commit at the end —
    seeding happens in fixtures, never inside ``benchmark(...)``.
    """
    receiver = OtlpReceiver()
    repo = NativeTraceRepository()
    with Session(engine) as session:
        payload = build_otlp_json_body(span_count=STORE_SPAN_COUNT)
        result = receiver.ingest(
            payload,
            "application/json",
            BENCH_PROJECT,
            session,
            project_immediately=False,
        )
        if result.accepted != STORE_SPAN_COUNT:
            raise AssertionError(
                f"seeded ingest rejected spans: {result.errors[:3]}"
            )
        for counter in range(STORE_SPAN_COUNT):
            span = build_span(counter)
            trace_id = str(span["traceId"])
            if counter % SPANS_PER_TRACE == 0:
                repo.upsert_trace(
                    session,
                    trace_id=trace_id,
                    project_id=BENCH_PROJECT,
                    flow_name="bench.flow",
                    created_at=_BASE_TIME,
                )
            is_generation = str(span["name"]) == "llm.complete"
            repo.upsert_observation(
                session,
                span_id=str(span["spanId"]),
                trace_id=trace_id,
                project_id=BENCH_PROJECT,
                observation_type="GENERATION" if is_generation else "SPAN",
                model=MODEL_NAME if is_generation else "",
                step_name=str(span["name"]),
                input={"prompt": "bench input"},
                output={"text": "bench output"},
                latency_ms=50.0,
                created_at=_BASE_TIME,
                end_time=_BASE_TIME + timedelta(milliseconds=50),
            )
        session.commit()


def _ensure_seeded() -> None:
    """Seed once per process; re-seed only if another test's schema
    teardown (top-level conftest's function-scoped ``db_schema``) dropped
    the tables underneath us."""
    if _store_trace_count() == STORE_TRACE_COUNT:
        return
    SQLModel.metadata.drop_all(engine)
    SQLModel.metadata.create_all(engine)
    _seed_store()


@pytest.fixture(name="bench_session")
def bench_session_fixture() -> Iterator[Session]:
    """A session over the shared in-memory engine, store seeded once."""
    _ensure_seeded()
    with Session(engine) as session:
        yield session
