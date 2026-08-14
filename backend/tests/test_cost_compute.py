# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownLambdaType=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false

"""Cost computation — breakdown math + precedence.

Verifies: breakdown[k] = round(price_stored * tokens / 1_000_000) per
dimension (price_stored is micro-USD-per-1M), total = sum(breakdown),
provided-wins-verbatim, skip-on-no-match, skip-on-missing-price.
"""

from __future__ import annotations
from collections.abc import Iterator

from datetime import datetime, timezone

import pytest
from sqlmodel import Session, SQLModel, create_engine

from apo.models.pricing import ModelRowDB, PriceDB, PricingTierDB
from apo.models.usage_keys import UsageKey
from apo.services.pricing.compute import ComputedCost, compute_cost
from apo.services.pricing.resolution import resolve_model_era


@pytest.fixture
def session() -> Iterator[Session]:
    eng = create_engine("sqlite://")
    SQLModel.metadata.create_all(eng)
    sess = Session(eng)
    yield sess
    sess.close()


_NOW = datetime(2026, 2, 15, tzinfo=timezone.utc)


def _flat_model(session: Session) -> None:
    """gpt-4o-mini: flat-priced, input=0.15/MTok, output=0.60/MTok."""
    m = ModelRowDB(match_pattern=r"(?i)^gpt-4o-mini$", provider="openai", start_date=None)
    session.add(m)
    session.flush()
    assert m.id is not None
    t = PricingTierDB(model_id=m.id, name="default", is_default=True, conditions_json="[]")
    session.add(t)
    session.flush()
    assert m.id is not None
    assert t.id is not None
    # micro-USD per 1M tokens
    session.add(PriceDB(model_id=m.id, tier_id=t.id, usage_key=UsageKey.INPUT.value, price_per_1m=150_000))
    session.add(PriceDB(model_id=m.id, tier_id=t.id, usage_key=UsageKey.OUTPUT.value, price_per_1m=600_000))
    session.commit()


def _cache_tiered_model(session: Session) -> None:
    """claude-sonnet-4.5: cache_read + cache_write_5m distinct priced dims."""
    m = ModelRowDB(match_pattern=r"(?i)^claude-sonnet-4\.5$", provider="anthropic", start_date=None)
    session.add(m)
    session.flush()
    assert m.id is not None
    t = PricingTierDB(model_id=m.id, name="default", is_default=True, conditions_json="[]")
    session.add(t)
    session.flush()
    assert m.id is not None
    assert t.id is not None
    # input=3.0/MTok, output=15.0/MTok, cache_read=0.30/MTok, cache_write_5m=3.75/MTok
    session.add(PriceDB(model_id=m.id, tier_id=t.id, usage_key=UsageKey.INPUT.value, price_per_1m=3_000_000))
    session.add(PriceDB(model_id=m.id, tier_id=t.id, usage_key=UsageKey.OUTPUT.value, price_per_1m=15_000_000))
    session.add(PriceDB(model_id=m.id, tier_id=t.id, usage_key=UsageKey.CACHE_READ.value, price_per_1m=300_000))
    session.add(PriceDB(model_id=m.id, tier_id=t.id, usage_key=UsageKey.CACHE_WRITE_5M.value, price_per_1m=3_750_000))
    session.commit()


def _reasoning_model(session: Session) -> None:
    """o3: reasoning is a distinct output-side priced dim."""
    m = ModelRowDB(match_pattern=r"(?i)^o3$", provider="openai", start_date=None)
    session.add(m)
    session.flush()
    assert m.id is not None
    t = PricingTierDB(model_id=m.id, name="default", is_default=True, conditions_json="[]")
    session.add(t)
    session.flush()
    assert m.id is not None
    assert t.id is not None
    session.add(PriceDB(model_id=m.id, tier_id=t.id, usage_key=UsageKey.INPUT.value, price_per_1m=2_000_000))
    session.add(PriceDB(model_id=m.id, tier_id=t.id, usage_key=UsageKey.OUTPUT.value, price_per_1m=8_000_000))
    session.add(PriceDB(model_id=m.id, tier_id=t.id, usage_key=UsageKey.REASONING.value, price_per_1m=32_000_000))
    session.commit()


class TestFlatCost:
    def test_breakdown_and_total(self, session: Session) -> None:
        _flat_model(session)
        result = compute_cost(session, "gpt-4o-mini", {"input": 1_000_000, "output": 500_000}, "__global__", _NOW)
        assert result is not None
        # input: 150_000 micro-per-1M * 1M tokens / 1M = 150_000 micro-USD
        assert result.breakdown == {"input": 150_000, "output": 300_000}
        assert result.total == 450_000

    def test_stores_matched_tier(self, session: Session) -> None:
        _flat_model(session)
        result = compute_cost(session, "gpt-4o-mini", {"input": 100, "output": 100}, "__global__", _NOW)
        assert result is not None
        assert result.tier_name == "default"
        assert result.tier_id is not None

    def test_zero_tokens_zero_cost(self, session: Session) -> None:
        _flat_model(session)
        result = compute_cost(session, "gpt-4o-mini", {"input": 0, "output": 0}, "__global__", _NOW)
        assert result is not None
        assert result.total == 0


class TestCacheTieredCost:
    def test_all_priced_dims_present(self, session: Session) -> None:
        _cache_tiered_model(session)
        result = compute_cost(
            session,
            "claude-sonnet-4.5",
            {"input": 1_000_000, "output": 1_000_000, "cache_read": 500_000, "cache_write_5m": 200_000},
            "__global__",
            _NOW,
        )
        assert result is not None
        # 3M + 15M + 0.15M + 0.75M micro-USD
        assert result.breakdown == {
            "input": 3_000_000,
            "output": 15_000_000,
            "cache_read": 150_000,
            "cache_write_5m": 750_000,
        }
        assert result.total == 18_900_000


class TestReasoningCost:
    def test_reasoning_priced_separately(self, session: Session) -> None:
        _reasoning_model(session)
        result = compute_cost(
            session,
            "o3",
            {"input": 1_000_000, "output": 1_000_000, "reasoning": 500_000},
            "__global__",
            _NOW,
        )
        assert result is not None
        assert result.breakdown == {"input": 2_000_000, "output": 8_000_000, "reasoning": 16_000_000}
        assert result.total == 26_000_000

    def test_unpriced_reasoning_falls_back_to_output_rate(self, session: Session) -> None:
        """Issue #143: reasoning without an explicit price row must be billed
        at the output rate, not skipped (providers bill reasoning as output
        tokens when there's no separate rate)."""
        _flat_model(session)
        result = compute_cost(
            session,
            "gpt-4o-mini",
            {"input": 1_000_000, "output": 0, "reasoning": 999_999},
            "__global__",
            _NOW,
        )
        assert result is not None
        # reasoning billed at output rate (600_000 micro-per-1M)
        assert result.breakdown == {"input": 150_000, "reasoning": 599_999}

    def test_reasoning_without_price_row_falls_back_to_output_rate(self, session: Session) -> None:
        """Issue #143: when reasoning has no explicit price row, it must be
        billed at the output rate — providers bill reasoning as output tokens
        when there's no separate rate. Splitting reasoning out of output must
        not make it free."""
        _flat_model(session)
        # Split: reasoning separated from output (as the normalizer does)
        split = compute_cost(
            session,
            "gpt-4o-mini",
            {"input": 100, "output": 200, "reasoning": 300},
            "__global__",
            _NOW,
        )
        # Merged: reasoning still inside output (the old pre-normalization shape)
        merged = compute_cost(
            session,
            "gpt-4o-mini",
            {"input": 100, "output": 500},
            "__global__",
            _NOW,
        )
        assert split is not None and merged is not None
        # The split must cost the same as the merged — reasoning tokens are
        # billed at the output rate when no separate reasoning price exists.
        assert split.total == merged.total


class TestNoMatch:
    def test_no_matching_model_returns_none(self, session: Session) -> None:
        result = compute_cost(session, "no-such-model", {"input": 100, "output": 100}, "__global__", _NOW)
        assert result is None


class TestRouterPrefixStripping:
    """Routers (OpenRouter, etc.) prefix the model with a provider slug
    ('openai/gpt-4o-mini'); the pricing table keys on the bare name, so
    compute_cost retries with the prefix stripped as a fallback."""

    def test_provider_prefixed_model_resolves_like_bare(self, session: Session) -> None:
        _flat_model(session)
        prefixed = compute_cost(
            session, "openai/gpt-4o-mini", {"input": 1_000_000, "output": 500_000}, "__global__", _NOW
        )
        bare = compute_cost(
            session, "gpt-4o-mini", {"input": 1_000_000, "output": 500_000}, "__global__", _NOW
        )
        assert prefixed is not None and bare is not None
        assert prefixed.total == bare.total == 450_000

    def test_prefixed_unknown_model_still_returns_none(self, session: Session) -> None:
        _flat_model(session)
        result = compute_cost(
            session, "openai/no-such-model", {"input": 100, "output": 100}, "__global__", _NOW
        )
        assert result is None


class TestGpt56Pricing:
    """Issue #101: gpt-5.6 terra/luna were arriving unpriced — no entry in
    the default pricing file meant compute_cost returned None for the entire
    family. These tests load the bundled defaults and verify both variants
    resolve to a non-zero cost."""

    def test_gpt_56_luna_priced(self, session: Session) -> None:
        from apo.services.pricing.loader import load_default_prices
        load_default_prices(session)
        result = compute_cost(
            session, "gpt-5.6-luna",
            {"input": 1_000_000, "output": 500_000},
            "__global__", _NOW,
        )
        assert result is not None
        assert result.total > 0

    def test_gpt_56_terra_priced(self, session: Session) -> None:
        from apo.services.pricing.loader import load_default_prices
        load_default_prices(session)
        result = compute_cost(
            session, "gpt-5.6-terra",
            {"input": 1_000_000, "output": 500_000},
            "__global__", _NOW,
        )
        assert result is not None
        assert result.total > 0

    def test_openrouter_prefixed_gpt_56_luna_resolves(self, session: Session) -> None:
        from apo.services.pricing.loader import load_default_prices
        load_default_prices(session)
        result = compute_cost(
            session, "openai/gpt-5.6-luna",
            {"input": 1_000_000, "output": 500_000},
            "__global__", _NOW,
        )
        assert result is not None
        assert result.total > 0


class TestRounding:
    def test_round_per_dimension_and_reconcile(self, session: Session) -> None:
        """round-per-dimension to micro-USD int; total == sum(breakdown)."""
        _flat_model(session)
        # input=150_000 micro-per-1M, 333_333 tokens.
        # round(150_000 * 333333 / 1e6) = round(49_999.95) = 50_000 micro-USD
        # round(600_000 * 333333 / 1e6) = round(199_999.8) = 200_000 micro-USD
        result = compute_cost(
            session,
            "gpt-4o-mini",
            {"input": 333_333, "output": 333_333},
            "__global__",
            _NOW,
        )
        assert result is not None
        assert result.breakdown == {"input": 50_000, "output": 200_000}
        assert result.total == sum(result.breakdown.values())

    def test_negative_clamped_to_zero(self, session: Session) -> None:
        _flat_model(session)
        result = compute_cost(
            session,
            "gpt-4o-mini",
            {"input": -500, "output": 100},  # negative clamped to 0
            "__global__",
            _NOW,
        )
        assert result is not None
        # input clamped to 0 -> 0 cost -> omitted from breakdown (zero-cost dims
        # are not stored). Only output contributes.
        assert "input" not in result.breakdown
        assert result.breakdown == {"output": round(600_000 * 100 / 1_000_000)}


class TestComputedCostModel:
    def test_total_defaults_to_breakdown_sum(self) -> None:
        c = ComputedCost(model_id=1, tier_id=2, tier_name="default", breakdown={"input": 10, "output": 20})
        assert c.total == 30
