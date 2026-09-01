# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

"""Benchmarks for the OTLP decode fast path."""

from typing import Any

from google.protobuf.json_format import Parse
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)
from pytest_codspeed import BenchmarkFixture

from apo.services.otlp_receiver import count_otlp_spans, decode_otlp_payload

from .conftest import DECODE_SPAN_COUNT, build_otlp_json_body


def test_bench_otlp_decode_json(benchmark: BenchmarkFixture) -> None:
    """decode_otlp_payload on a ~50-span ExportTraceServiceRequest JSON body."""
    body = build_otlp_json_body(span_count=DECODE_SPAN_COUNT)
    decoded = benchmark(decode_otlp_payload, body, "application/json")
    # The decode must succeed for the measurement to count.
    assert count_otlp_spans(decoded) == DECODE_SPAN_COUNT


def test_bench_otlp_decode_protobuf(benchmark: BenchmarkFixture) -> None:
    """The protobuf branch: base64→hex normalization is the extra cost."""
    body = build_otlp_json_body(span_count=DECODE_SPAN_COUNT)
    request = ExportTraceServiceRequest()
    Parse(body, request)
    wire = request.SerializeToString(deterministic=True)
    decoded: dict[str, Any] = benchmark(
        decode_otlp_payload, wire, "application/x-protobuf"
    )
    assert count_otlp_spans(decoded) == DECODE_SPAN_COUNT
