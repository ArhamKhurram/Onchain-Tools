"""Analytic tests for the closed-form constant-product curve.

A constant-product fill has a closed form, so the sim's math is checked against hand-computed
analytic answers — the whole program's credibility rests on this being exactly right (03 §Phase 0).
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from oct_trading_agent.core import Side
from oct_trading_agent.sim.amm.curve import fill_buy, fill_sell, mid_price

# A round synthetic pool: 1,000,000 base : 100 quote -> mid = 0.0001 quote/base.
R_B = Decimal(1_000_000)
R_Q = Decimal(100)


def _rel(actual: Decimal, expected: Decimal) -> Decimal:
    return abs(actual - expected) / abs(expected)


def test_mid_price() -> None:
    assert mid_price(R_B, R_Q) == Decimal("0.0001")


def test_buy_zero_fee_matches_closed_form() -> None:
    # Buy spending 10 quote, no fee. base_out = 1e6*10/(100+10) = 90909.0909...
    fill = fill_buy(Decimal(10), R_B, R_Q, Decimal(0))
    assert fill.side is Side.BUY
    # executed = 10 / base_out = 10*110/1e7 = 0.00011 exactly.
    assert fill.executed_price == Decimal("0.00011")
    # slippage vs mid 0.0001: (0.00011/0.0001 - 1) = 0.10 -> 1000 bps.
    assert float(fill.slippage_bps) == pytest.approx(1000.0)
    # post-mid = 110 / (1e6 - base_out) = 110/909090.909... = 0.000121 -> impact 2100 bps.
    assert float(fill.price_impact_bps) == pytest.approx(2100.0)
    assert fill.quote_amount == Decimal(10)


def test_buy_zero_fee_preserves_k() -> None:
    """With no fee, the constant product k is preserved exactly (fee retention is the only source
    of k growth)."""
    fill = fill_buy(Decimal("7.5"), R_B, R_Q, Decimal(0))
    k_before = R_B * R_Q
    k_after = fill.base_reserve_after * fill.quote_reserve_after
    assert _rel(k_after, k_before) < Decimal("1e-25")


def test_buy_with_fee_grows_k_and_costs_more() -> None:
    no_fee = fill_buy(Decimal(10), R_B, R_Q, Decimal(0))
    with_fee = fill_buy(Decimal(10), R_B, R_Q, Decimal("0.003"))  # 30 bps
    # A fee means you receive LESS base for the same quote -> a higher executed price.
    assert with_fee.executed_price > no_fee.executed_price
    assert with_fee.base_amount < no_fee.base_amount
    # The retained fee grows k.
    k_before = R_B * R_Q
    assert with_fee.base_reserve_after * with_fee.quote_reserve_after > k_before


def test_sell_zero_fee_matches_closed_form() -> None:
    # Sell 100000 base, no fee. quote_out = 100*1e5/(1e6+1e5) = 1e7/1.1e6 = 9.0909...
    fill = fill_sell(Decimal(100_000), R_B, R_Q, Decimal(0))
    assert fill.side is Side.SELL
    expected_quote = Decimal(10_000_000) / Decimal(1_100_000)
    assert _rel(fill.quote_amount, expected_quote) < Decimal("1e-25")
    # executed = quote_out / 100000; below mid, so slippage is a positive cost.
    assert fill.executed_price < mid_price(R_B, R_Q)
    assert float(fill.slippage_bps) == pytest.approx(909.0909, rel=1e-4)


def test_sell_zero_fee_preserves_k() -> None:
    fill = fill_sell(Decimal(50_000), R_B, R_Q, Decimal(0))
    k_before = R_B * R_Q
    k_after = fill.base_reserve_after * fill.quote_reserve_after
    assert _rel(k_after, k_before) < Decimal("1e-25")


def test_larger_order_has_more_impact() -> None:
    small = fill_buy(Decimal(1), R_B, R_Q, Decimal(0))
    large = fill_buy(Decimal(20), R_B, R_Q, Decimal(0))
    assert large.slippage_bps > small.slippage_bps
    assert large.price_impact_bps > small.price_impact_bps


def test_slippage_and_impact_are_non_negative() -> None:
    for fill in (
        fill_buy(Decimal(5), R_B, R_Q, Decimal("0.0025")),
        fill_sell(Decimal(5000), R_B, R_Q, Decimal("0.0025")),
    ):
        assert fill.slippage_bps >= 0
        assert fill.price_impact_bps >= 0


def test_invalid_inputs_raise() -> None:
    with pytest.raises(ValueError):
        fill_buy(Decimal(0), R_B, R_Q, Decimal(0))
    with pytest.raises(ValueError):
        fill_sell(Decimal(-1), R_B, R_Q, Decimal(0))
    with pytest.raises(ValueError):
        fill_buy(Decimal(1), Decimal(0), R_Q, Decimal(0))
