# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportReturnType=false, reportCallIssue=false

"""Run Configuration validation and Batch summary states.

Pure-function tests for the adapter-reported Run Configuration contract:
normalization rules (trimming, byte-length bounds, control-character
rejection, casing preservation) and the exact uniform/mixed/partial/unknown
batch-summary derivation. No database needed — these are the derivation rules
the projections and the grouped list query both rely on.
"""

from __future__ import annotations

import pytest

from apo.models import (
    AgentTaskBatchRunConfigurationSummary,
    AgentTaskRunConfiguration,
    AgentTaskRunConfigurationCount,
)
from apo.services.agent_task_configuration import (
    configuration_from_row,
    normalize_run_configuration,
    summarize_batch_configurations,
)


# ---------------------------------------------------------------------------
# normalize_run_configuration
# ---------------------------------------------------------------------------


def test_absent_configuration_normalizes_to_none() -> None:
    assert normalize_run_configuration(None) is None


def test_leading_trailing_whitespace_is_trimmed() -> None:
    result = normalize_run_configuration(
        AgentTaskRunConfiguration(model="  gpt-5.6-terra  ", effort="  high  ")
    )
    assert result is not None
    assert result.model == "gpt-5.6-terra"
    assert result.effort == "high"


def test_omitted_effort_is_preserved_as_none() -> None:
    result = normalize_run_configuration(AgentTaskRunConfiguration(model="claude-opus-4.1"))
    assert result is not None
    assert result.model == "claude-opus-4.1"
    assert result.effort is None


def test_explicit_default_effort_is_preserved() -> None:
    result = normalize_run_configuration(
        AgentTaskRunConfiguration(model="claude-opus-4.1", effort="default")
    )
    assert result is not None
    assert result.effort == "default"


def test_casing_and_punctuation_are_preserved() -> None:
    result = normalize_run_configuration(AgentTaskRunConfiguration(model="Pi/gpt-5.6-Terra"))
    assert result is not None
    assert result.model == "Pi/gpt-5.6-Terra"


@pytest.mark.parametrize("model", ["", "   ", "\t", "\n"])
def test_blank_model_is_rejected(model: str) -> None:
    with pytest.raises(ValueError):
        normalize_run_configuration(AgentTaskRunConfiguration(model=model))


def test_model_over_255_bytes_is_rejected() -> None:
    # 256 ASCII chars = 256 bytes > the 255-byte ceiling.
    with pytest.raises(ValueError):
        normalize_run_configuration(AgentTaskRunConfiguration(model="a" * 256))


def test_model_at_exactly_255_bytes_is_accepted() -> None:
    result = normalize_run_configuration(AgentTaskRunConfiguration(model="a" * 255))
    assert result is not None
    assert len(result.model.encode("utf-8")) == 255


def test_model_byte_length_uses_utf8_not_chars() -> None:
    # 128 x 'é' (2 bytes each) = 256 bytes -> rejected.
    with pytest.raises(ValueError):
        normalize_run_configuration(AgentTaskRunConfiguration(model="é" * 128))


def test_effort_over_64_bytes_is_rejected() -> None:
    with pytest.raises(ValueError):
        normalize_run_configuration(AgentTaskRunConfiguration(model="ok", effort="b" * 65))


def test_nul_and_control_characters_are_rejected() -> None:
    with pytest.raises(ValueError):
        normalize_run_configuration(AgentTaskRunConfiguration(model="bad\x00model"))
    with pytest.raises(ValueError):
        normalize_run_configuration(AgentTaskRunConfiguration(model="ok", effort="high\x1f"))


def test_whitespace_only_effort_is_treated_as_not_reported() -> None:
    # Optional value that trims to empty normalizes to None (not reported),
    # mirroring "omitted effort means the adapter did not report effort".
    result = normalize_run_configuration(
        AgentTaskRunConfiguration(model="claude-opus-4.1", effort="   ")
    )
    assert result is not None
    assert result.effort is None


# ---------------------------------------------------------------------------
# configuration_from_row
# ---------------------------------------------------------------------------


def test_row_without_model_projects_as_none() -> None:
    assert configuration_from_row(None, None) is None
    assert configuration_from_row("", None) is None


def test_row_with_model_carries_effort_or_none() -> None:
    full = configuration_from_row("terra", "high")
    assert full is not None
    assert full.model == "terra"
    assert full.effort == "high"

    no_effort = configuration_from_row("terra", None)
    assert no_effort is not None
    assert no_effort.model == "terra"
    assert no_effort.effort is None


# ---------------------------------------------------------------------------
# summarize_batch_configurations
# ---------------------------------------------------------------------------


def _cfg(model: str, effort: str | None = None) -> AgentTaskRunConfiguration:
    return AgentTaskRunConfiguration(model=model, effort=effort)


def test_no_reported_configurations_is_unknown() -> None:
    summary = summarize_batch_configurations([None, None, None], total_task_runs=3)
    assert summary.state == "unknown"
    assert summary.configurations == []
    assert summary.reported_task_runs == 0
    assert summary.total_task_runs == 3


def test_empty_batch_is_unknown() -> None:
    summary = summarize_batch_configurations([], total_task_runs=0)
    assert summary.state == "unknown"
    assert summary.reported_task_runs == 0
    assert summary.total_task_runs == 0


def test_all_children_share_one_pair_is_uniform() -> None:
    summary = summarize_batch_configurations(
        [_cfg("terra", "high"), _cfg("terra", "high"), _cfg("terra", "high")],
        total_task_runs=3,
    )
    assert summary.state == "uniform"
    assert summary.reported_task_runs == 3
    assert len(summary.configurations) == 1
    only = summary.configurations[0]
    assert only.model == "terra"
    assert only.effort == "high"
    assert only.task_runs == 3


def test_all_reported_with_multiple_pairs_is_mixed() -> None:
    summary = summarize_batch_configurations(
        [_cfg("terra", "low"), _cfg("opus", "high"), _cfg("terra", "low")],
        total_task_runs=3,
    )
    assert summary.state == "mixed"
    assert summary.reported_task_runs == 3
    pairs = {(c.model, c.effort, c.task_runs) for c in summary.configurations}
    assert pairs == {("terra", "low", 2), ("opus", "high", 1)}


def test_some_reported_some_not_is_partial() -> None:
    summary = summarize_batch_configurations(
        [_cfg("terra", "high"), None, None, _cfg("terra", "high")],
        total_task_runs=4,
    )
    assert summary.state == "partial"
    assert summary.reported_task_runs == 2
    assert summary.total_task_runs == 4
    assert len(summary.configurations) == 1
    assert summary.configurations[0].task_runs == 2


def test_uniform_pair_counts_preserve_model_and_effort_together() -> None:
    # The same model with different efforts are distinct pairs — never a
    # single "dominant model" rollup.
    summary = summarize_batch_configurations(
        [_cfg("terra", "low"), _cfg("terra", "high")], total_task_runs=2
    )
    assert summary.state == "mixed"
    assert {(c.model, c.effort, c.task_runs) for c in summary.configurations} == {
        ("terra", "low", 1),
        ("terra", "high", 1),
    }


def test_omitted_effort_pairs_count_separately_from_explicit_effort() -> None:
    summary = summarize_batch_configurations(
        [_cfg("terra"), _cfg("terra", "high")], total_task_runs=2
    )
    assert summary.state == "mixed"
    pairs = {(c.model, c.effort, c.task_runs) for c in summary.configurations}
    assert pairs == {("terra", None, 1), ("terra", "high", 1)}


def test_summary_return_type_is_the_documented_shape() -> None:
    summary = summarize_batch_configurations([_cfg("a", "b")], total_task_runs=1)
    assert isinstance(summary, AgentTaskBatchRunConfigurationSummary)
    assert isinstance(summary.configurations[0], AgentTaskRunConfigurationCount)
