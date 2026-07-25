"""SPEC-148: Run Configuration validation and Batch summary derivation.

Pure functions for the adapter-reported Run Configuration contract. These are
the rules shared by every result-entry path (the shared Task Run finalizer
validates here before mutating terminal state) and by the projections that
expose nested configuration on Task Run and Batch Run responses.

No database access and no I/O — pass values in, get validated/derived values
out. This keeps the contract rules independently testable.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Literal, overload

from ..models import (
    AgentTaskBatchRunConfigurationSummary,
    AgentTaskRunConfiguration,
    AgentTaskRunConfigurationCount,
)

# Byte-length ceilings. ``model`` and ``effort`` are short identity strings,
# not free text — keep them bounded so they stay useful as indexed filtering
# and comparison dimensions.
_MAX_MODEL_BYTES = 255
_MAX_EFFORT_BYTES = 64

# NUL and ASCII control characters (C0 controls plus DEL) are never valid in a
# model/effort identifier and would corrupt downstream display/filtering.
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def normalize_run_configuration(
    raw: AgentTaskRunConfiguration | None,
) -> AgentTaskRunConfiguration | None:
    """Validate and normalize an adapter-reported Run Configuration.

    Returns ``None`` when no configuration was reported (the adapter does not
    support reporting one, or the run failed before session creation). An
    invalid configuration (blank model, oversized value, control character)
    raises ``ValueError`` — it is an adapter contract error that must fail the
    Task Run before the first Task Turn.

    Normalization:
      - trim leading/trailing whitespace from ``model`` and ``effort``;
      - ``model`` is required (1–255 UTF-8 bytes);
      - ``effort`` is optional; when present it is 1–64 UTF-8 bytes;
      - reject NUL and ASCII control characters;
      - preserve casing and punctuation.

    Never log secret-bearing source values — the error messages name the
    field, not the value.
    """
    if raw is None:
        return None

    model = _normalize_scalar(
        raw.model, "run_configuration.model", _MAX_MODEL_BYTES, required=True
    )
    effort = _normalize_scalar(
        raw.effort, "run_configuration.effort", _MAX_EFFORT_BYTES, required=False
    )

    return AgentTaskRunConfiguration(model=model, effort=effort)


def configuration_from_row(
    configured_model: str | None,
    configured_effort: str | None,
) -> AgentTaskRunConfiguration | None:
    """Build the nested API shape from a Task Run's persisted columns.

    Absent (``None``) when the row never reported a configuration, so legacy
    rows and failed-before-session runs project as "unknown". A present model
    always carries an effort value (possibly ``None`` when effort was not
    meaningful for that runtime).
    """
    if not configured_model:
        return None
    return AgentTaskRunConfiguration(model=configured_model, effort=configured_effort)


def summarize_batch_configurations(
    configurations: Sequence[AgentTaskRunConfiguration | None],
    total_task_runs: int,
) -> AgentTaskBatchRunConfigurationSummary:
    """Derive a Batch Run's configuration summary from its children.

    State rules:
      - ``unknown``: no child reports a configuration;
      - ``uniform``: every child reports the same model/effort pair;
      - ``mixed``:   every child reports a configuration and >1 pair exists;
      - ``partial``: at least one child reports and at least one does not.

    Pair counts always preserve ``(model, effort)`` together — never a
    "dominant model" and "dominant effort" computed independently, which could
    invent a configuration that never ran. ``total_task_runs`` is taken from
    the caller (the batch's authoritative count) rather than ``len(...)`` so a
    grouped-query caller can pass the real total without materializing the
    ``None`` rows.
    """
    reported: list[AgentTaskRunConfiguration] = [
        cfg for cfg in configurations if cfg is not None
    ]
    reported_count = len(reported)

    if reported_count == 0:
        return AgentTaskBatchRunConfigurationSummary(
            state="unknown",
            configurations=[],
            reported_task_runs=0,
            total_task_runs=total_task_runs,
        )

    counts = _count_pairs(reported)
    distinct_pairs = len(counts)
    all_reported = reported_count == total_task_runs

    if all_reported and distinct_pairs == 1:
        state = "uniform"
    elif all_reported:
        state = "mixed"
    else:
        state = "partial"

    return AgentTaskBatchRunConfigurationSummary(
        state=state,
        configurations=counts,
        reported_task_runs=reported_count,
        total_task_runs=total_task_runs,
    )


def _count_pairs(
    reported: list[AgentTaskRunConfiguration],
) -> list[AgentTaskRunConfigurationCount]:
    """Count Task Runs per ``(model, effort)`` pair, preserving pair identity."""
    totals: dict[tuple[str, str | None], int] = {}
    for cfg in reported:
        key = (cfg.model, cfg.effort)
        totals[key] = totals.get(key, 0) + 1
    return [
        AgentTaskRunConfigurationCount(model=model, effort=effort, task_runs=count)
        for (model, effort), count in totals.items()
    ]


@overload
def _normalize_scalar(
    value: str | None,
    field: str,
    max_bytes: int,
    *,
    required: Literal[True],
) -> str: ...


@overload
def _normalize_scalar(
    value: str | None,
    field: str,
    max_bytes: int,
    *,
    required: Literal[False],
) -> str | None: ...


def _normalize_scalar(
    value: str | None,
    field: str,
    max_bytes: int,
    *,
    required: bool,
) -> str | None:
    """Normalize and validate one model/effort scalar.

    Control characters are rejected on the *original* value because
    ``str.strip()`` also removes the C0 controls ``\\x1c``–``\\x1f`` (Python
    treats them as whitespace), which would otherwise hide them. After
    trimming, a required value must be non-empty; an optional value that
    trims to empty is treated as "not reported" (``None``).
    """
    if value is None:
        if required:
            raise ValueError(f"{field} is required")
        return None

    if _CONTROL_CHARS.search(value):
        raise ValueError(f"{field} must not contain control characters")

    trimmed = value.strip()
    if not trimmed:
        if required:
            raise ValueError(f"{field} is required and must be non-empty")
        return None

    encoded = trimmed.encode("utf-8")
    if len(encoded) > max_bytes:
        raise ValueError(f"{field} must be at most {max_bytes} UTF-8 bytes")
    return trimmed


__all__ = [
    "configuration_from_row",
    "normalize_run_configuration",
    "summarize_batch_configurations",
]
