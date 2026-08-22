"""PointInTimeFeatureStore: as-of assembly, mint scoping, no-lookahead, present-but-empty tiers."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from oct_trading_agent.core import (
    FeatureBundle,
    FeatureStatus,
    FeatureTier,
    Side,
    SwapEvent,
    TapeEvent,
)
from oct_trading_agent.featurestore import PointInTimeFeatureStore

MINT_A = "So11111111111111111111111111111111111111112"
MINT_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)
TIER_A = frozenset({FeatureTier.A_RAW_CHART})


def _swap(mint: str, slot: int, when: datetime, price: str, side: Side = Side.BUY) -> SwapEvent:
    return SwapEvent(
        mint=mint,
        slot=slot,
        block_time=when,
        signer="Wa11etWa11etWa11etWa11etWa11etWa11etWa11",
        side=side,
        base_amount=Decimal("1000"),
        quote_amount=Decimal("1"),
        price=Decimal(price),
    )


def test_assemble_produces_tier_a_bundle() -> None:
    tape: list[TapeEvent] = [
        _swap(MINT_A, 100, T0, "0.001"),
        _swap(MINT_A, 101, T0 + timedelta(seconds=5), "0.002"),
    ]
    store = PointInTimeFeatureStore(tape)
    bundle = store.assemble(MINT_A, as_of=T0 + timedelta(seconds=10), tiers=TIER_A)
    assert isinstance(bundle, FeatureBundle)
    price = bundle.get(FeatureTier.A_RAW_CHART, "price")
    assert price is not None and price.observed and price.value == 0.002
    tc = bundle.get(FeatureTier.A_RAW_CHART, "trade_count")
    assert tc is not None and tc.value == 2


def test_no_lookahead_future_event_ignored() -> None:
    tape: list[TapeEvent] = [
        _swap(MINT_A, 100, T0, "0.001"),
        _swap(MINT_A, 200, T0 + timedelta(hours=1), "9.999"),  # future
    ]
    store = PointInTimeFeatureStore(tape)
    bundle = store.assemble(MINT_A, as_of=T0 + timedelta(minutes=1), tiers=TIER_A)
    price = bundle.get(FeatureTier.A_RAW_CHART, "price")
    assert price is not None and price.value == 0.001


def test_mint_scoping_isolates_tokens() -> None:
    tape: list[TapeEvent] = [
        _swap(MINT_A, 100, T0, "0.001"),
        _swap(MINT_B, 101, T0, "5.000"),  # different mint, same instant
    ]
    store = PointInTimeFeatureStore(tape)
    bundle = store.assemble(MINT_A, as_of=T0 + timedelta(seconds=1), tiers=TIER_A)
    price = bundle.get(FeatureTier.A_RAW_CHART, "price")
    assert price is not None and price.value == 0.001  # MINT_B did not bleed in
    tc = bundle.get(FeatureTier.A_RAW_CHART, "trade_count")
    assert tc is not None and tc.value == 1


def test_sparse_new_pair_all_slots_explicitly_missing() -> None:
    store = PointInTimeFeatureStore([])
    bundle = store.assemble(MINT_A, as_of=T0, tiers=TIER_A)
    slots = bundle.tiers[FeatureTier.A_RAW_CHART]
    assert slots  # slots are present...
    for feat in slots.values():  # ...but every one is explicitly missing, never a silent zero
        assert not feat.observed
        assert feat.value is None
        assert feat.status is not FeatureStatus.OBSERVED


def test_unlocked_but_unimplemented_tier_is_present_but_empty() -> None:
    tape: list[TapeEvent] = [_swap(MINT_A, 100, T0, "0.001")]
    store = PointInTimeFeatureStore(tape)
    bundle = store.assemble(
        MINT_A,
        as_of=T0 + timedelta(seconds=1),
        tiers=frozenset({FeatureTier.A_RAW_CHART, FeatureTier.B_WALLET_FLOWS}),
    )
    assert FeatureTier.B_WALLET_FLOWS in bundle.tiers  # requested -> present
    assert bundle.tiers[FeatureTier.B_WALLET_FLOWS] == {}  # ...but empty (distinct from absent)
    assert bundle.get(FeatureTier.B_WALLET_FLOWS, "unique_buyers") is None
    assert bundle.get(FeatureTier.A_RAW_CHART, "price") is not None


def test_unrequested_tier_is_absent() -> None:
    store = PointInTimeFeatureStore([_swap(MINT_A, 100, T0, "0.001")])
    bundle = store.assemble(MINT_A, as_of=T0, tiers=TIER_A)
    assert FeatureTier.C_METADATA not in bundle.tiers  # absent != present-but-empty
