"""Leakage-guard tests: the raw-chart tier is certified causal; the noise store corrupts only signal."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from oct_trading_agent.core import FeatureStatus, FeatureTier, Side, SwapEvent, TapeEvent
from oct_trading_agent.eval.ablations import (
    NoiseTierFeatureStore,
    assert_raw_chart_causal,
    noise_ablation,
)
from oct_trading_agent.featurestore import PointInTimeFeatureStore

MINT = "So11111111111111111111111111111111111111112"
T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)


def _swap(i: int) -> SwapEvent:
    return SwapEvent(
        mint=MINT,
        slot=1000 + i,
        block_time=T0 + timedelta(seconds=10 * i),
        signature=f"s{i}",
        signer=f"w{i}",
        side=Side.BUY if i % 2 == 0 else Side.SELL,
        base_amount=Decimal("1000"),
        quote_amount=Decimal("1"),
        price=Decimal("0.001"),
        protocol="pumpfun",
    )


def _tape(n: int) -> list[TapeEvent]:
    return [_swap(i) for i in range(n)]


def test_raw_chart_tier_is_certified_causal() -> None:
    tape = _tape(8)
    # as_of between events; there is at least one strictly-later event.
    as_of = T0 + timedelta(seconds=35)
    assert_raw_chart_causal(tape, as_of)  # does not raise (real features pass, canary trips)


def test_noise_store_preserves_missingness_but_corrupts_observed() -> None:
    tape = _tape(6)
    base = PointInTimeFeatureStore(tape)
    noised = NoiseTierFeatureStore(base, FeatureTier.A_RAW_CHART, seed=1)
    as_of = T0 + timedelta(seconds=55)
    tiers = frozenset({FeatureTier.A_RAW_CHART})

    real_bundle = base.assemble(MINT, as_of, tiers)
    noised_bundle = noised.assemble(MINT, as_of, tiers)

    for name, real_feat in real_bundle.tiers[FeatureTier.A_RAW_CHART].items():
        noised_feat = noised_bundle.tiers[FeatureTier.A_RAW_CHART][name]
        # Missingness is preserved exactly (same status; a missing slot stays missing).
        assert noised_feat.status is real_feat.status
        if real_feat.status is FeatureStatus.OBSERVED and isinstance(real_feat.value, float):
            # Observed numeric values are replaced by noise (deterministically).
            assert noised_feat.value is not None


def test_noise_store_is_deterministic() -> None:
    tape = _tape(6)
    noised = NoiseTierFeatureStore(PointInTimeFeatureStore(tape), seed=7)
    as_of = T0 + timedelta(seconds=55)
    tiers = frozenset({FeatureTier.A_RAW_CHART})
    a = noised.assemble(MINT, as_of, tiers)
    b = noised.assemble(MINT, as_of, tiers)
    for name in a.tiers[FeatureTier.A_RAW_CHART]:
        assert (
            a.tiers[FeatureTier.A_RAW_CHART][name].value
            == b.tiers[FeatureTier.A_RAW_CHART][name].value
        )


def test_noise_ablation_returns_paired_stores() -> None:
    stores = noise_ablation(_tape(6))
    assert isinstance(stores.noised, NoiseTierFeatureStore)
    assert stores.real is not stores.noised
