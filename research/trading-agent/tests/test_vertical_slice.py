"""Phase-0 vertical slice: prove the shared contracts compose end-to-end.

Wiring under test:

    SwapEvent (tape)
        -> StubTierAFeatureStore.assemble  (data -> point-in-time feature bundle, causal)
        -> HoldPolicy.decide               (feature bundle -> typed AgentDecision)
        -> assert the types line up + the value distribution is usable.

This does NOT test the simulator, feature computations, or a learned policy (all Wave-1). It tests
that the contracts are self-consistent and that the dependency chain type-checks and runs.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from oct_trading_agent.agent import HoldPolicy
from oct_trading_agent.core import (
    AgentDecision,
    FeatureBundle,
    FeatureStatus,
    FeatureTier,
    Intent,
    Side,
    SwapEvent,
    TapeEvent,
    ValueDistribution,
)
from oct_trading_agent.featurestore import StubTierAFeatureStore

MINT = "So11111111111111111111111111111111111111112"
T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)


def _swap(slot: int, price: str, when: datetime) -> SwapEvent:
    return SwapEvent(
        mint=MINT,
        slot=slot,
        block_time=when,
        signer="Wa11etWa11etWa11etWa11etWa11etWa11etWa11",
        side=Side.BUY,
        base_amount=Decimal("1000"),
        quote_amount=Decimal("1"),
        price=Decimal(price),
    )


def test_tape_to_feature_to_decision_composes() -> None:
    tape: list[TapeEvent] = [
        _swap(100, "0.001", T0),
        _swap(101, "0.002", T0 + timedelta(seconds=5)),
    ]
    store = StubTierAFeatureStore(tape)

    bundle = store.assemble(
        MINT, as_of=T0 + timedelta(seconds=10), tiers=frozenset({FeatureTier.A_RAW_CHART})
    )
    assert isinstance(bundle, FeatureBundle)

    price = bundle.get(FeatureTier.A_RAW_CHART, "price")
    assert price is not None
    assert price.observed
    assert price.value == 0.002  # latest swap at/before as_of

    decision = HoldPolicy().decide(bundle)
    assert isinstance(decision, AgentDecision)
    assert decision.intent is Intent.HOLD
    assert decision.size == 0.0
    assert decision.mint == MINT
    assert isinstance(decision.value_distribution, ValueDistribution)
    # The distributional value is usable: mean and CVaR both compute.
    assert decision.value_distribution.mean() == 0.0
    assert decision.value_distribution.cvar(0.05) == 0.0
    # The convergence signal is present and calibrated in [0, 1].
    assert 0.0 <= decision.signal_contribution.score <= 1.0
    assert decision.signal_contribution.independent is True


def test_feature_store_is_causal_no_lookahead() -> None:
    """A swap AFTER as_of must not influence the feature (the leakage invariant)."""
    tape: list[TapeEvent] = [
        _swap(100, "0.001", T0),
        _swap(200, "9.999", T0 + timedelta(hours=1)),  # far future — must be ignored
    ]
    store = StubTierAFeatureStore(tape)

    bundle = store.assemble(
        MINT, as_of=T0 + timedelta(minutes=1), tiers=frozenset({FeatureTier.A_RAW_CHART})
    )
    price = bundle.get(FeatureTier.A_RAW_CHART, "price")
    assert price is not None
    assert price.value == 0.001  # the future swap did not leak in


def test_missingness_is_explicit_not_imputed() -> None:
    """No swaps before as_of -> feature is explicitly MISSING, not a silent zero."""
    store = StubTierAFeatureStore([])
    bundle = store.assemble(MINT, as_of=T0, tiers=frozenset({FeatureTier.A_RAW_CHART}))
    price = bundle.get(FeatureTier.A_RAW_CHART, "price")
    assert price is not None
    assert not price.observed
    assert price.value is None
    assert price.status is FeatureStatus.MISSING_NOT_YET_AVAILABLE


def test_value_distribution_cvar_is_left_tail() -> None:
    """CVaR at a small alpha picks the worst outcomes, not the mean."""
    dist = ValueDistribution(
        representation="categorical",
        locations=[-1.0, 0.0, 1.0, 10.0],
        weights=[0.25, 0.25, 0.25, 0.25],
    )
    assert dist.cvar(0.25) == -1.0  # worst 25% is the -1.0 atom
    assert dist.mean() == 2.5
