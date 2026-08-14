"""Langfuse SDK mapper — spans emitted by ``@langfuse/tracing`` (priority 2).

The Langfuse SDK is an OTel tracer: `startObservation(name, {...}, {asType})`
produces a plain span whose payload lives in `langfuse.observation.*`
attributes. An app instrumented with it can therefore export straight to apo's
OTLP endpoint, without Langfuse in the path at all — and until this mapper,
those spans landed typed `SPAN` with `{}` input and `{}` output, because the
convention was unmapped.

Priority 2 (just after the apo override): `langfuse.observation.type` is an
explicit declaration by the app author, so it outranks the conventions that
*infer* a type from attribute shape. The payload extractors in `_shared` treat
Langfuse as the last fallback instead — for a span carrying both `gen_ai.*` and
`langfuse.*`, the established convention keeps its well-tested extraction.
"""

# pyright: reportExplicitAny=false

from __future__ import annotations

from typing import Any

from ._shared import VALID_OBSERVATION_TYPES, get_str

MAPPER_NAME = "langfuse"
MAPPER_VERSION = 1


def try_map(attrs: dict[str, Any], span_name: str) -> str | None:
    """Return the observation type for a Langfuse-SDK span, else None.

    Langfuse has observation types apo doesn't model (e.g. `event`). A span that
    declares one is still recognisably a Langfuse span, so it maps to `SPAN`
    rather than falling through to the generic mapper — the provenance stays
    honest and the payload extractors still run.
    """
    _ = span_name
    declared = get_str(attrs, "langfuse.observation.type")
    if not declared:
        return None
    upper = declared.upper()
    return upper if upper in VALID_OBSERVATION_TYPES else "SPAN"
