# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

"""Benchmarks for the span-store write boundary."""

from pytest_codspeed import BenchmarkFixture
from sqlmodel import Session

from apo.models.db import LoggedCallDB
from apo.services.trace_repository import NativeTraceRepository

from .conftest import BENCH_PROJECT, MODEL_NAME, build_span


def test_bench_upsert_observation(
    benchmark: BenchmarkFixture, bench_session: Session
) -> None:
    """NativeTraceRepository.upsert_observation on in-memory SQLite.

    Measures the idempotent update path — the one OTLP's at-least-once
    delivery hits on every duplicate export. The row exists from seeding,
    so table size stays constant across measurement rounds.
    """
    repo = NativeTraceRepository()
    span = build_span(0)

    def reupsert() -> LoggedCallDB:
        return repo.upsert_observation(
            bench_session,
            span_id=str(span["spanId"]),
            trace_id=str(span["traceId"]),
            project_id=BENCH_PROJECT,
            observation_type="GENERATION",
            model=MODEL_NAME,
            step_name="llm.complete",
            input={"prompt": "bench input"},
            output={"text": "bench output"},
            prompt_tokens=100,
            completion_tokens=50,
            latency_ms=50.0,
        )

    call = benchmark(reupsert)
    assert call.id == str(span["spanId"])
