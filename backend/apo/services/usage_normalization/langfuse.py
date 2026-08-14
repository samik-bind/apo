# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnnecessaryIsInstance=false

"""Langfuse-SDK usage normalization (`langfuse.observation.usage_details`).

Unlike the provider modules, this one is not provider-specific: the Langfuse SDK
already reports usage as a per-dimension map, so it is resolved *before* provider
detection. It is also the only usage the SDK emits — those spans carry no
`gen_ai.usage.*` keys at all, so without this the costing seam sees no usage,
returns early, and the call ends up with neither a cost nor the `unpriced`
marker that would flag the gap.

Non-overlap needs no correction here: Langfuse's `input` is already the uncached
remainder, with the cached portion in its own buckets (a 33k-token cached prompt
reports `input: 2, input_cache_read: 33381`).
"""

from __future__ import annotations

from typing import Any

from ...models.usage_keys import UsageKey
from ._shared import get_json_dict

USAGE_DETAILS_ATTR = "langfuse.observation.usage_details"

# Langfuse bucket -> canonical UsageKey. `input_cache_creation` carries no TTL,
# so it maps to the 5-minute write — the provider default. A model priced only
# for 1h writes would under-report; that needs a TTL signal Langfuse doesn't send.
_BUCKETS: dict[str, str] = {
    "input": UsageKey.INPUT.value,
    "output": UsageKey.OUTPUT.value,
    "input_cache_read": UsageKey.CACHE_READ.value,
    "cache_read_input_tokens": UsageKey.CACHE_READ.value,
    "input_cache_creation": UsageKey.CACHE_WRITE_5M.value,
    "cache_creation_input_tokens": UsageKey.CACHE_WRITE_5M.value,
    "output_reasoning": UsageKey.REASONING.value,
    "reasoning": UsageKey.REASONING.value,
}

# `total` is a sum of the others, not a dimension — pricing it would double-count.
_IGNORED = frozenset({"total", "total_tokens"})


def has_usage_details(attrs: dict[str, Any]) -> bool:
    """True when the span carries a non-empty Langfuse usage map."""
    return bool(get_json_dict(attrs, USAGE_DETAILS_ATTR))


def normalize(attrs: dict[str, Any]) -> dict[str, int]:
    details = get_json_dict(attrs, USAGE_DETAILS_ATTR)
    if not details:
        return {}

    usage: dict[str, int] = {}
    for key, raw in details.items():
        if not isinstance(key, str) or key in _IGNORED:
            continue
        if not isinstance(raw, (int, float)) or isinstance(raw, bool):
            continue
        # Unknown buckets are kept verbatim (store-but-unpriced, ticket 01) so a
        # new provider dimension is preserved rather than silently discarded.
        canonical = _BUCKETS.get(key, key)
        usage[canonical] = usage.get(canonical, 0) + int(raw)

    return {key: value for key, value in usage.items() if value}
