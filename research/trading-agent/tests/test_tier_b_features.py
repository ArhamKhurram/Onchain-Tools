"""Tier-B smart-wallet co-occurrence: as-of correctness, explicit missingness, and the two roster
leakage surfaces.

Synthetic ``SwapEvent`` tapes only. Each test pins one invariant from
``09-cooccurrence-feature.md``: the count is BUY-only + distinct, a measured zero is distinct from
too-young, appending future swaps changes nothing (the audit invariant), and a walk-forward roster
never backdates a wallet.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from oct_trading_agent.core import FeatureStatus, FeatureTier, Side, SwapEvent
from oct_trading_agent.featurestore.pointintime import PointInTimeFeatureStore
from oct_trading_agent.featurestore.tiers import (
    SmartWalletCount,
    SmartWalletShare,
    StaticRosterProvider,
    WalkForwardRosterProvider,
    default_tier_a_features,
    smart_wallet_features,
)

MINT = "So11111111111111111111111111111111111111112"
T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)

# Distinct, recognizable 44-ish char wallet ids.
SMART_A = "SmartAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
SMART_B = "SmartBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
SMART_C = "SmartCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
RANDO_1 = "Rando111111111111111111111111111111111111111"
RANDO_2 = "Rando222222222222222222222222222222222222222"


def _swap(slot: int, when: datetime, signer: str, side: Side = Side.BUY) -> SwapEvent:
    return SwapEvent(
        mint=MINT,
        slot=slot,
        block_time=when,
        signer=signer,
        side=side,
        base_amount=Decimal("1000"),
        quote_amount=Decimal("1"),
        price=Decimal("1"),
    )


def _min(n: int) -> datetime:
    return T0 + timedelta(minutes=n)


ROSTER = StaticRosterProvider(frozenset({SMART_A, SMART_B, SMART_C}))


# --- count: missingness ---------------------------------------------------


def test_count_not_yet_available_before_first_swap():
    feat = SmartWalletCount(ROSTER)
    f = feat.compute_as_of([], T0)
    assert f.status is FeatureStatus.MISSING_NOT_YET_AVAILABLE
    assert f.value is None


def test_count_measured_zero_when_no_roster_wallet_bought():
    # Buyers exist, none are in the roster -> OBSERVED 0, NOT missing. This is the study's
    # "0 smart buyers" band and it must be a real zero, not imputation.
    tape = [_swap(1, _min(1), RANDO_1), _swap(2, _min(2), RANDO_2)]
    f = SmartWalletCount(ROSTER).compute_as_of(tape, _min(5))
    assert f.status is FeatureStatus.OBSERVED
    assert f.value == 0


# --- count: the actual signal --------------------------------------------


def test_count_intersects_roster():
    tape = [
        _swap(1, _min(1), SMART_A),
        _swap(2, _min(2), RANDO_1),
        _swap(3, _min(3), SMART_B),
    ]
    feat = SmartWalletCount(ROSTER)
    f = feat.compute_as_of(tape, _min(5))
    assert f.status is FeatureStatus.OBSERVED
    assert f.value == 2
    assert f.as_of == _min(3)  # timestamp of the latest counted swap
    assert feat.tier is FeatureTier.B_WALLET_FLOWS  # tier lives on the feature, not the value


def test_count_is_buy_only():
    # A roster wallet that only SOLD is not accumulation and must not count.
    tape = [
        _swap(1, _min(1), SMART_A, side=Side.SELL),
        _swap(2, _min(2), SMART_B, side=Side.BUY),
    ]
    f = SmartWalletCount(ROSTER).compute_as_of(tape, _min(5))
    assert f.value == 1


def test_count_is_distinct():
    # SMART_A buys three times -> counts once.
    tape = [
        _swap(1, _min(1), SMART_A),
        _swap(2, _min(2), SMART_A),
        _swap(3, _min(3), SMART_A),
    ]
    f = SmartWalletCount(ROSTER).compute_as_of(tape, _min(5))
    assert f.value == 1


def test_count_is_as_of_causal():
    # The whole point: only swaps at/before as_of count, and appending future swaps changes nothing.
    tape = [_swap(1, _min(1), SMART_A), _swap(2, _min(10), SMART_B)]
    feat = SmartWalletCount(ROSTER)
    early = feat.compute_as_of(tape, _min(5))
    assert early.value == 1  # SMART_B's buy at minute 10 is in the future

    future = [*tape, _swap(3, _min(2), SMART_C)]  # a NEW swap before as_of, appended later
    assert feat.compute_as_of(future, _min(5)).value == 2
    # ...but a swap strictly after as_of must never move the earlier reading:
    later_future = [*tape, _swap(4, _min(9), SMART_C)]
    assert feat.compute_as_of(later_future, _min(5)).value == 1


# --- share ----------------------------------------------------------------


def test_share_is_count_over_distinct_buyers():
    tape = [
        _swap(1, _min(1), SMART_A),
        _swap(2, _min(2), RANDO_1),
        _swap(3, _min(3), RANDO_2),
        _swap(4, _min(4), SMART_A),  # duplicate buyer -> distinct denominator stays 3
    ]
    f = SmartWalletShare(ROSTER).compute_as_of(tape, _min(5))
    assert f.status is FeatureStatus.OBSERVED
    assert f.value == pytest.approx(1 / 3)


def test_share_not_applicable_with_swaps_but_no_buyers():
    # Only sells so far: the token is live (a swap exists) but there are zero buyers -> 0/0.
    tape = [_swap(1, _min(1), SMART_A, side=Side.SELL)]
    f = SmartWalletShare(ROSTER).compute_as_of(tape, _min(5))
    assert f.status is FeatureStatus.MISSING_NOT_APPLICABLE
    assert f.value is None


def test_share_not_yet_available_before_first_swap():
    f = SmartWalletShare(ROSTER).compute_as_of([], T0)
    assert f.status is FeatureStatus.MISSING_NOT_YET_AVAILABLE


# --- roster providers (the leakage surfaces) ------------------------------


def test_static_roster_is_constant_in_time():
    r = StaticRosterProvider(frozenset({SMART_A}))
    assert r.as_of(T0) == r.as_of(_min(10_000)) == frozenset({SMART_A})


def test_walkforward_roster_never_backdates_a_wallet():
    # SMART_B only becomes "smart" at minute 5. A decision at minute 3 must NOT count its earlier
    # buy — this is leakage surface (a): the roster is an as-of artifact, not a constant.
    roster = WalkForwardRosterProvider(
        (
            (_min(0), frozenset({SMART_A})),
            (_min(5), frozenset({SMART_A, SMART_B})),
        )
    )
    tape = [_swap(1, _min(1), SMART_A), _swap(2, _min(2), SMART_B)]
    feat = SmartWalletCount(roster)

    at_3 = feat.compute_as_of(tape, _min(3))
    assert at_3.value == 1  # only SMART_A is in the roster as of minute 3

    at_6 = feat.compute_as_of(tape, _min(6))
    assert at_6.value == 2  # SMART_B entered the roster at minute 5


def test_walkforward_roster_empty_before_first_snapshot():
    roster = WalkForwardRosterProvider(((_min(5), frozenset({SMART_A})),))
    assert roster.as_of(_min(1)) == frozenset()


def test_walkforward_roster_rejects_unsorted_snapshots():
    with pytest.raises(ValueError, match="sorted"):
        WalkForwardRosterProvider(
            ((_min(5), frozenset({SMART_A})), (_min(1), frozenset({SMART_B})))
        )


# --- store integration ----------------------------------------------------


def test_store_assembles_tier_b_when_roster_supplied():
    tape = [_swap(1, _min(1), SMART_A), _swap(2, _min(2), RANDO_1)]
    registry = {
        FeatureTier.A_RAW_CHART: default_tier_a_features(),
        FeatureTier.B_WALLET_FLOWS: smart_wallet_features(ROSTER),
        FeatureTier.C_METADATA: [],
        FeatureTier.D_SOCIAL: [],
        FeatureTier.E_CHATTER: [],
    }
    store = PointInTimeFeatureStore(tape, registry)
    bundle = store.assemble(
        MINT, _min(5), frozenset({FeatureTier.A_RAW_CHART, FeatureTier.B_WALLET_FLOWS})
    )
    tier_b = bundle.tiers[FeatureTier.B_WALLET_FLOWS]
    assert set(tier_b) == {"smart_wallet_count", "smart_wallet_share"}
    assert tier_b["smart_wallet_count"].value == 1
    assert tier_b["smart_wallet_share"].value == pytest.approx(0.5)


def test_default_store_leaves_tier_b_empty():
    # No roster in scope -> the tier is present-but-empty, not a wrong zero.
    store = PointInTimeFeatureStore([_swap(1, _min(1), SMART_A)])
    bundle = store.assemble(MINT, _min(5), frozenset({FeatureTier.B_WALLET_FLOWS}))
    assert bundle.tiers[FeatureTier.B_WALLET_FLOWS] == {}
