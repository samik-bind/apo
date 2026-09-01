# pyright: reportUnusedCallResult=false

"""Determinism guard for the benchmark fixture builders.

A regression report must measure the code, not fixture drift: if a
``random`` or ``datetime.now()`` ever leaks into the builders, two
instantiations stop being byte-identical and this test fails.
"""

from apo.services.otlp_receiver import count_otlp_spans, decode_otlp_payload

from .conftest import DECODE_SPAN_COUNT, build_otlp_json_body


def test_payload_builder_is_deterministic() -> None:
    """The synthetic payload builder is byte-identical across calls."""
    assert build_otlp_json_body(
        span_count=DECODE_SPAN_COUNT
    ) == build_otlp_json_body(span_count=DECODE_SPAN_COUNT)


def test_payload_builder_survives_decode() -> None:
    """Builder output passes the real decode path and admission limits."""
    body = build_otlp_json_body(span_count=DECODE_SPAN_COUNT)
    decoded = decode_otlp_payload(body, "application/json")
    assert count_otlp_spans(decoded) == DECODE_SPAN_COUNT
