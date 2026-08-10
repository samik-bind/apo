# pyright: reportAny=false, reportExplicitAny=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

"""OpenAI usage normalization.

OpenAI reports ``input_tokens`` / ``output_tokens`` *inclusive* of cache and
reasoning subsets (OTel GenAI semconv), so the non-overlap invariant subtracts
both. See ``wayfinder/assets/03-normalizer-research.md`` §3.

Cache *creation* is a separate dimension, not a subset of ``input_tokens``.
The OpenAI API itself never reports it, but OpenAI-dialect routers do:
OpenRouter returns ``prompt_tokens_details.cache_write_tokens`` and bills
those tokens at the full input rate. An emitter forwarding them as
``gen_ai.usage.cache_creation.input_tokens`` had them dropped here, which
silently billed the most expensive tokens on the call at zero — the OpenAI
half of issue #125.
"""

from __future__ import annotations

from typing import Any

from ._shared import apply_non_overlap, get_int


def normalize(attrs: dict[str, Any]) -> dict[str, int]:
    usage: dict[str, int] = {}

    # Input side (inclusive of cache).
    inp = get_int(attrs, "gen_ai.usage.input_tokens")
    if inp is None:
        inp = get_int(attrs, "gen_ai.usage.prompt_tokens")
    if inp is None:
        inp = get_int(attrs, "ai.usage.promptTokens")
    if inp is not None:
        usage["input"] = inp

    # Output side (inclusive of reasoning).
    out = get_int(attrs, "gen_ai.usage.output_tokens")
    if out is None:
        out = get_int(attrs, "gen_ai.usage.completion_tokens")
    if out is None:
        out = get_int(attrs, "ai.usage.completionTokens")
    if out is not None:
        usage["output"] = out

    # Cache read (subset of input per OTel semconv).
    cache_read = get_int(attrs, "gen_ai.usage.cache_read.input_tokens")
    if cache_read is None:
        cache_read = get_int(attrs, "ai.usage.cachedInputTokens")
    if cache_read is not None:
        usage["cache_read"] = cache_read

    # Cache creation (a distinct billed dimension, NOT part of input_tokens).
    # OpenAI-dialect providers have no 5m/1h TTL split, so writes land on the
    # default tier — the same bucket Anthropic's untagged remainder uses.
    cache_write = get_int(attrs, "gen_ai.usage.cache_creation.input_tokens")
    if cache_write is None:
        cache_write = get_int(attrs, "gen_ai.usage.cache_creation_input_tokens")
    if cache_write is not None:
        usage["cache_write_5m"] = cache_write

    # Reasoning (subset of output per OTel semconv).
    reasoning = get_int(attrs, "gen_ai.usage.reasoning.output_tokens")
    if reasoning is None:
        reasoning = get_int(attrs, "ai.usage.reasoningTokens")
    if reasoning is not None:
        usage["reasoning"] = reasoning

    # OpenAI input/output are inclusive -> subtract the subsets.
    return apply_non_overlap(usage, input_includes_cache=True, output_includes_reasoning=True)
