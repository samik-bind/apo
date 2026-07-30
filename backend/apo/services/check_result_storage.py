"""SPEC-140 ticket 03: bounded check result storage.

``checks_json`` is persisted on the task run row and loaded by list/detail
queries, so it must stay bounded. A large Deliverable repeated across many
judge assertions must not be able to OOM the row.

Before ``checks_json`` is written, every oversized field becomes an explicit
``TruncatedCheckValue`` marker (data, never a silent ellipsis):

- ``received`` larger than ``RECEIVED_VALUE_LIMIT`` -> truncated marker with
  preview + size + sha256;
- ``judge_prompt``/``judge_response`` segments larger than
  ``JUDGE_SEGMENT_LIMIT`` -> truncated marker;
- ``instruction``/``expected``/``reasoning`` strings capped at
  ``STRING_FIELD_LIMIT``;
- the final normalized payload must not exceed ``TOTAL_CHECKS_LIMIT``.

Normalization runs before any persistence or event emission so direct service
calls and tests cannot bypass it.
"""

from __future__ import annotations

import hashlib
import json

# SPEC-140 §"Check detail is bounded at persistence" — code constants, not
# operator tuning knobs. Changing them affects only future placement.
RECEIVED_VALUE_LIMIT = 4 * 1024  # 4 KiB
JUDGE_SEGMENT_LIMIT = 16 * 1024  # 16 KiB
STRING_FIELD_LIMIT = 32 * 1024  # 32 KiB
TOTAL_CHECKS_LIMIT = 1024 * 1024  # 1 MiB

_PREVIEW_CHARS = 256

# String fields capped at STRING_FIELD_LIMIT (kept verbatim up to the cap).
_STRING_FIELDS = ("instruction", "expected", "reasoning")
# Text-segment fields truncated to TruncatedCheckValue markers.
_TRUNCATED_TEXT_FIELDS = ("judge_prompt", "judge_response")


def normalize_checks_for_storage(
    checks: list[dict[str, object]] | None,
) -> list[dict[str, object]]:
    """Return a bounded, JSON-safe copy of ``checks`` for persistence.

    Never mutates the input. Drops non-dict entries. Every oversized field is
    replaced by an explicit marker; the final payload stays under
    ``TOTAL_CHECKS_LIMIT``.
    """
    if not checks:
        return []

    normalized: list[dict[str, object]] = []
    for entry in checks:
        if not isinstance(entry, dict):
            continue
        normalized.append(_normalize_one(entry))

    serialized = _dumps(normalized)
    if len(serialized) <= TOTAL_CHECKS_LIMIT:
        return normalized

    # The per-entry caps weren't enough (pathological count or huge names).
    # Drop the heaviest previews first, then fall back to dropping entries,
    # so the persisted payload never exceeds the cap.
    return _shrink_to_fit(normalized)


def _normalize_one(entry: dict[str, object]) -> dict[str, object]:
    out: dict[str, object] = {}
    for key, value in entry.items():
        out[key] = _normalize_field(key, value)
    return out


def _normalize_field(key: str, value: object) -> object:
    if key == "received":
        return _truncate_value(value, RECEIVED_VALUE_LIMIT)
    if key in _TRUNCATED_TEXT_FIELDS:
        return _truncate_text(value, JUDGE_SEGMENT_LIMIT)
    if key in _STRING_FIELDS and isinstance(value, str):
        return value[:STRING_FIELD_LIMIT]
    return value


def _truncate_value(value: object, limit: int) -> object:
    """Truncate a ``received`` value when its compact JSON form exceeds ``limit``."""
    if value is None:
        return None
    try:
        encoded = _dumps(value)
    except (TypeError, ValueError):
        # Non-JSON-safe value: stringify then bound it.
        encoded = _dumps(str(value))
    if len(encoded) <= limit:
        return value
    return _marker(encoded, limit)


def _truncate_text(value: object, limit: int) -> object:
    if not isinstance(value, str):
        return value
    if len(value.encode("utf-8")) <= limit:
        return value
    return _marker(value.encode("utf-8"), limit)


def _marker(payload: bytes, limit: int) -> dict[str, object]:
    preview = payload[:_PREVIEW_CHARS].decode("utf-8", errors="replace")
    return {
        "kind": "truncated",
        "preview": preview,
        "size_bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
    }


def _shrink_to_fit(normalized: list[dict[str, object]]) -> list[dict[str, object]]:
    """Progressively shrink the payload so it stays under the total cap."""
    # Pass 1: blank every marker preview (the body is already gone).
    shrunk = [_strip_previews(entry) for entry in normalized]
    if len(_dumps(shrunk)) <= TOTAL_CHECKS_LIMIT:
        return shrunk

    # Pass 2: keep only verdict + name for each check, dropping all detail.
    minimal = [_minimal(entry) for entry in shrunk]
    if len(_dumps(minimal)) <= TOTAL_CHECKS_LIMIT:
        return minimal

    # Pass 3: truncate the list itself, preserving verdicts in order.
    while minimal and len(_dumps(minimal)) > TOTAL_CHECKS_LIMIT:
        minimal.pop()
    return minimal


def _strip_previews(entry: dict[str, object]) -> dict[str, object]:
    out = dict(entry)
    for key, value in list(out.items()):
        if isinstance(value, dict) and value.get("kind") == "truncated":
            kept = dict(value)
            kept["preview"] = ""
            out[key] = kept
    return out


# Fields kept when a check is reduced to its minimum. A verdict with no
# identity is unusable downstream — the dashboard can't label the check, and the
# check-source viewer has nothing to resolve, so it falls through its candidate
# list and reports a 404 for a filename unrelated to the real problem. These are
# small and bounded, so keeping them costs a few dozen bytes per check.
# SPEC-160: ``group_id``/``group_name`` are kept so a large run (exactly the
# case that needs grouping — dozens of generated checks under one describe)
# still nests correctly after the minimal-form shrink.
_MINIMAL_FIELDS = ("id", "name", "group_id", "group_name", "source_file", "pass")


def _minimal(entry: dict[str, object]) -> dict[str, object]:
    return {key: entry[key] for key in _MINIMAL_FIELDS if key in entry}


def _dumps(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
