"""The leakage firewall: the audit CATCHES a leaky feature and PASSES every causal Tier-A feature.

This is the load-bearing test of Agent C's deliverable. If the audit ever fails to catch
``NextTradePriceLeak``, or ever flags a real Tier-A feature, the firewall is broken.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from oct_trading_agent.core import Side, SwapEvent, TapeEvent
from oct_trading_agent.featurestore import (
    NextTradePriceLeak,
    StandingLeakageAudit,
    assert_no_leaks,
    default_tier_a_features,
    run_standing_audit,
)
from oct_trading_agent.featurestore.tiers import LastPrice

MINT = "So11111111111111111111111111111111111111112"
T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)
AS_OF = T0 + timedelta(minutes=1)


def _swap(slot: int, when: datetime, price: str, side: Side = Side.BUY) -> SwapEvent:
    return SwapEvent(
        mint=MINT,
        slot=slot,
        block_time=when,
        signer="Wa11etWa11etWa11etWa11etWa11etWa11etWa11",
        side=side,
        base_amount=Decimal("1000"),
        quote_amount=Decimal("1"),
        price=Decimal(price),
        quote_reserve_after=Decimal("50"),
        base_reserve_after=Decimal("1000"),
    )


# A ragged, sparse "new pair" tape split around AS_OF.
PAST: list[TapeEvent] = [
    _swap(100, T0, "0.001"),
    _swap(101, T0 + timedelta(seconds=20), "0.002", side=Side.SELL),
    _swap(102, T0 + timedelta(seconds=40), "0.003"),
]
FUTURE: list[TapeEvent] = [
    _swap(200, AS_OF + timedelta(seconds=5), "9.999"),
    _swap(201, AS_OF + timedelta(minutes=5), "42.0"),
]


def test_audit_catches_the_leaky_feature() -> None:
    result = StandingLeakageAudit().audit(NextTradePriceLeak(), PAST, FUTURE, AS_OF)
    assert result.passed is False
    assert result.feature_name == "next_trade_price_leak"
    assert result.detail is not None and "changed" in result.detail


def test_audit_passes_a_correct_feature() -> None:
    result = StandingLeakageAudit().audit(LastPrice(), PAST, FUTURE, AS_OF)
    assert result.passed is True
    assert result.detail is None


def test_every_tier_a_feature_is_causal() -> None:
    results = run_standing_audit(default_tier_a_features(), PAST, FUTURE, AS_OF)
    assert len(results) == len(default_tier_a_features())
    assert all(r.passed for r in results), [r.detail for r in results if not r.passed]
    assert_no_leaks(results)  # does not raise


def test_assert_no_leaks_raises_on_a_leak() -> None:
    results = run_standing_audit([NextTradePriceLeak()], PAST, FUTURE, AS_OF)
    with pytest.raises(AssertionError, match="leakage audit failed"):
        assert_no_leaks(results)


def test_audit_rejects_a_vacuous_future_injection() -> None:
    """An injected 'future' event that is actually at/before as_of makes the test vacuous -> error."""
    not_future: list[TapeEvent] = [_swap(150, AS_OF - timedelta(seconds=1), "0.005")]
    with pytest.raises(ValueError, match="strictly after"):
        StandingLeakageAudit().audit(LastPrice(), PAST, not_future, AS_OF)


def test_audit_is_stable_on_empty_past() -> None:
    """Even with no past at all, a causal feature is invariant to appended future events."""
    results = run_standing_audit(default_tier_a_features(), [], FUTURE, AS_OF)
    assert all(r.passed for r in results)
    # And the leak still leaks: it would read FUTURE off an empty past.
    leak = StandingLeakageAudit().audit(NextTradePriceLeak(), [], FUTURE, AS_OF)
    assert leak.passed is False
