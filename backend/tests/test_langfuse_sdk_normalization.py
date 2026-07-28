# pyright: reportAny=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false

"""Spans emitted directly by the Langfuse SDK (`@langfuse/tracing`).

That SDK is an OTel tracer, so an instrumented app can export straight to apo's
OTLP endpoint with Langfuse nowhere in the path. It emits *only* its own
`langfuse.*` namespace (verified against @langfuse/core 5.4.1 — not one
`gen_ai.*` key), so before the langfuse mapper existed those spans projected as
type SPAN with `{}` input and `{}` output.

The attribute payloads below are the real ones taken off a `sim-user` span.
"""

import json
from datetime import datetime, timezone

import pytest
from sqlmodel import Session, select, text

from apo.db import engine, init_db
from apo.models.db import LoggedCallDB, OtlpSpanDB
from apo.services.otel_normalization import normalize_span
from apo.services.trace_projector import TraceProjector


def _span(attrs: dict[str, object], name: str = "sim-user") -> OtlpSpanDB:
    return OtlpSpanDB(
        project_id="p",
        trace_id="0b6f8005fd3f23cfbf210292aab58fd1",
        span_id="a1b2c3d4e5f60718",
        span_name=name,
        attributes=attrs,
    )


SIM_USER_ATTRS: dict[str, object] = {
    "langfuse.observation.type": "generation",
    "langfuse.observation.model.name": "google/gemini-3.1-flash-lite-preview",
    "langfuse.observation.input": json.dumps(
        {"systemPrompt": "You are simulating a user interacting with Bind", "temperature": 0}
    ),
    "langfuse.observation.output": json.dumps({"response": "Yes, do all of that."}),
}


def test_sim_user_span_keeps_its_type_model_and_payload():
    result = normalize_span(_span(SIM_USER_ATTRS))

    assert result.mapping_name == "langfuse"
    assert result.observation_type == "GENERATION"
    assert result.model == "google/gemini-3.1-flash-lite-preview"
    assert result.input == {
        "systemPrompt": "You are simulating a user interacting with Bind",
        "temperature": 0,
    }
    assert result.output == {"response": "Yes, do all of that."}


def test_unmodelled_langfuse_type_still_maps_as_a_langfuse_span():
    # Langfuse has observation types apo doesn't model; the span is still
    # recognisably a Langfuse span, so its payload must not be dropped.
    result = normalize_span(_span({**SIM_USER_ATTRS, "langfuse.observation.type": "event"}))

    assert result.mapping_name == "langfuse"
    assert result.observation_type == "SPAN"
    assert result.output == {"response": "Yes, do all of that."}


def test_usage_details_sum_cached_input_buckets():
    # Cached input arrives split, with `input` holding only the uncached
    # remainder — the same shape the trace importer sums (issue #43).
    attrs = {
        **SIM_USER_ATTRS,
        "langfuse.observation.usage_details": json.dumps(
            {"input": 2, "output": 62, "input_cache_read": 33381, "input_cache_creation": 169, "total": 33614}
        ),
    }

    result = normalize_span(_span(attrs))

    assert result.token_usage == {"prompt": 33552, "completion": 62}


def test_missing_usage_details_leaves_tokens_empty():
    assert normalize_span(_span(SIM_USER_ATTRS)).token_usage == {}


def test_standard_conventions_keep_precedence_over_langfuse():
    # A span carrying both keeps the well-tested gen_ai extraction.
    attrs = {
        **SIM_USER_ATTRS,
        "gen_ai.request.model": "claude-opus-5",
        "gen_ai.output.messages": json.dumps(
            [{"role": "assistant", "parts": [{"type": "text", "content": "from gen_ai"}]}]
        ),
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 5,
        "langfuse.observation.usage_details": json.dumps({"input": 999, "output": 999}),
    }

    result = normalize_span(_span(attrs))

    assert result.model == "claude-opus-5"
    assert result.token_usage == {"prompt": 10, "completion": 5}
    assert result.output is not None and result.output.get("text") == "from gen_ai"
    # The explicit type declaration still wins — that is not an inference.
    assert result.observation_type == "GENERATION"
    assert result.mapping_name == "langfuse"


def test_a_span_with_no_langfuse_attributes_is_untouched():
    result = normalize_span(_span({"http.method": "GET"}, name="plain"))

    assert result.mapping_name == "generic"
    assert result.observation_type == "SPAN"
    assert result.input is None
    assert result.output is None


def test_message_shaped_and_scalar_payloads_are_preserved():
    messages = [{"role": "user", "content": "hi"}]
    as_messages = normalize_span(
        _span({**SIM_USER_ATTRS, "langfuse.observation.input": json.dumps(messages)})
    )
    assert as_messages.input == {"messages": messages}

    as_text = normalize_span(
        _span({**SIM_USER_ATTRS, "langfuse.observation.output": "just a string"})
    )
    assert as_text.output == {"text": "just a string"}


def test_empty_payloads_do_not_masquerade_as_content():
    result = normalize_span(
        _span(
            {
                **SIM_USER_ATTRS,
                "langfuse.observation.input": json.dumps({}),
                "langfuse.observation.output": json.dumps([]),
            }
        )
    )

    assert result.input is None
    assert result.output is None


# --- projection: the layer where the payload was actually being lost ----------


@pytest.fixture
def clean_db():
    init_db()
    yield
    with Session(engine) as session:
        session.execute(text("DELETE FROM run_metrics"))
        session.execute(text("DELETE FROM logged_calls"))
        session.execute(text("DELETE FROM runs"))
        session.execute(text("DELETE FROM otlp_spans"))
        session.commit()


def _canonical(span_id: str, attrs: dict[str, object], parent: str | None = None) -> OtlpSpanDB:
    return OtlpSpanDB(
        project_id="test-project",
        trace_id="lf-sdk-trace-01",
        span_id=span_id,
        parent_span_id=parent,
        start_time=datetime(2026, 7, 28, 6, 59, 28, tzinfo=timezone.utc),
        end_time=datetime(2026, 7, 28, 6, 59, 31, tzinfo=timezone.utc),
        span_name="sim-user",
        attributes=attrs,
        resource={},
        raw_span={},
    )


def test_projected_row_carries_the_payload_not_an_empty_dict(clean_db):
    """The reported symptom: sim-user rendered blank in the trace view.

    The projector defaults input/output to `{}` when no convention matches, so an
    unmapped namespace surfaced as an empty observation rather than as missing
    data.
    """
    root = _canonical("root-lf-01", {"apo.observation.type": "AGENT"})
    sim_user = _canonical(
        "sim-lf-0001",
        {
            **SIM_USER_ATTRS,
            "langfuse.observation.usage_details": json.dumps({"input": 1200, "output": 34}),
        },
        parent="root-lf-01",
    )

    projector = TraceProjector()
    with Session(engine) as session:
        projector.project(root, session)
        projector.project(sim_user, session)
        session.commit()

    with Session(engine) as session:
        call = session.exec(select(LoggedCallDB).where(LoggedCallDB.id == "sim-lf-0001")).first()
        assert call is not None
        assert call.observation_type == "GENERATION"
        assert call.model == "google/gemini-3.1-flash-lite-preview"
        assert call.input != {}
        assert call.input["systemPrompt"].startswith("You are simulating a user")
        assert call.output == {"response": "Yes, do all of that."}
        assert call.prompt_tokens == 1200
        assert call.completion_tokens == 34


def test_reprojecting_the_same_span_stays_idempotent(clean_db):
    span = _canonical("sim-lf-0002", SIM_USER_ATTRS)

    projector = TraceProjector()
    with Session(engine) as session:
        projector.project(span, session)
        session.commit()
        projector.project(span, session)
        session.commit()

    with Session(engine) as session:
        rows = session.exec(
            select(LoggedCallDB).where(LoggedCallDB.id == "sim-lf-0002")
        ).all()
        assert len(rows) == 1
        assert rows[0].output == {"response": "Yes, do all of that."}
