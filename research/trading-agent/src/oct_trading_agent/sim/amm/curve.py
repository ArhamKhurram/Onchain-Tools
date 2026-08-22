"""Closed-form constant-product (``x*y=k``) curve math — the correctness core of the simulator.

The AMM impact map is **closed-form** (paper §4.4 — a genuine advantage over LOB microstructure):
given pre-trade reserves and a fee, the fill for any size has an exact analytic answer, so the sim
has an analytic ground truth to be tested against (``tests/test_amm_curve.py``).

Conventions (matching ``core.tape`` / ``core.sim``):

* ``base`` is the tracked token, ``quote`` is SOL/WSOL.
* **mid price** = ``quote_reserve / base_reserve`` (quote per base).
* Fee is Uniswap-V2-style: taken on the **input**, and *retained in the pool* (so ``k`` grows).
* ``executed_price`` = gross quote moved / base moved — it already embeds the LP fee (which is why
  it differs from the mid). The AMM/LP fee is therefore NOT reported separately in ``fee_quote``
  (that field carries network/priority gas only) — folding it in both places would double-count.
* ``slippage_bps`` and ``price_impact_bps`` are reported as **non-negative costs** (bps): how much
  worse than the pre-trade mid the average fill was, and the magnitude of the mid-price move the
  own order caused. Non-negativity makes the comparison to a non-negative ``slippage_tolerance_bps``
  unambiguous.

All arithmetic is ``Decimal`` — on-chain amounts are large and float drift is unacceptable when the
whole program's credibility rests on the simulator's fidelity (03 §Phase 0).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from oct_trading_agent.core import Side

_BPS = Decimal(10_000)


@dataclass(frozen=True)
class CurveFill:
    """The exact result of one constant-product fill against a known pre-trade pool state.

    ``base_amount`` / ``quote_amount`` are the gross amounts that moved (fee embedded). The
    ``*_reserve_after`` fields are the post-trade pool state (fee retained -> ``k`` grows).
    """

    side: Side
    base_amount: Decimal
    quote_amount: Decimal
    executed_price: Decimal  # gross quote / gross base
    mid_price_before: Decimal
    mid_price_after: Decimal
    slippage_bps: Decimal  # non-negative: adverse move of avg price vs pre-trade mid
    price_impact_bps: Decimal  # non-negative: magnitude of the mid move the order caused
    base_reserve_after: Decimal
    quote_reserve_after: Decimal


def mid_price(base_reserve: Decimal, quote_reserve: Decimal) -> Decimal:
    """Marginal (mid) price in quote per base. Raises if the pool has no base depth."""
    if base_reserve <= 0:
        raise ValueError("base_reserve must be positive to define a mid price")
    return quote_reserve / base_reserve


def _bps_move(a: Decimal, b: Decimal) -> Decimal:
    """``(a/b - 1)`` in bps as a non-negative magnitude. ``b`` must be positive."""
    return abs(a / b - Decimal(1)) * _BPS


def fill_buy(
    quote_in: Decimal,
    base_reserve: Decimal,
    quote_reserve: Decimal,
    fee_fraction: Decimal,
) -> CurveFill:
    """Buy base by spending ``quote_in`` quote (SOL). Fee taken on the quote input.

    Closed form (Uniswap-V2): ``dq_eff = quote_in*(1-fee)``;
    ``base_out = base_reserve * dq_eff / (quote_reserve + dq_eff)``.
    The full ``quote_in`` (including fee) is retained in the pool, so ``k`` grows.
    """
    if quote_in <= 0:
        raise ValueError("quote_in must be positive")
    if base_reserve <= 0 or quote_reserve <= 0:
        raise ValueError("pool reserves must be positive")

    mid_before = quote_reserve / base_reserve
    dq_eff = quote_in * (Decimal(1) - fee_fraction)
    base_out = base_reserve * dq_eff / (quote_reserve + dq_eff)

    base_reserve_after = base_reserve - base_out
    quote_reserve_after = quote_reserve + quote_in  # fee retained in the pool
    mid_after = quote_reserve_after / base_reserve_after
    executed_price = quote_in / base_out  # gross quote per base (embeds the LP fee)

    return CurveFill(
        side=Side.BUY,
        base_amount=base_out,
        quote_amount=quote_in,
        executed_price=executed_price,
        mid_price_before=mid_before,
        mid_price_after=mid_after,
        slippage_bps=_bps_move(executed_price, mid_before),
        price_impact_bps=_bps_move(mid_after, mid_before),
        base_reserve_after=base_reserve_after,
        quote_reserve_after=quote_reserve_after,
    )


def fill_sell(
    base_in: Decimal,
    base_reserve: Decimal,
    quote_reserve: Decimal,
    fee_fraction: Decimal,
) -> CurveFill:
    """Sell ``base_in`` base for quote (SOL). Fee taken on the base input.

    Closed form: ``db_eff = base_in*(1-fee)``;
    ``quote_out = quote_reserve * db_eff / (base_reserve + db_eff)``.
    The full ``base_in`` (including fee) is retained in the pool, so ``k`` grows.
    """
    if base_in <= 0:
        raise ValueError("base_in must be positive")
    if base_reserve <= 0 or quote_reserve <= 0:
        raise ValueError("pool reserves must be positive")

    mid_before = quote_reserve / base_reserve
    db_eff = base_in * (Decimal(1) - fee_fraction)
    quote_out = quote_reserve * db_eff / (base_reserve + db_eff)

    base_reserve_after = base_reserve + base_in  # fee retained in the pool
    quote_reserve_after = quote_reserve - quote_out
    mid_after = quote_reserve_after / base_reserve_after
    executed_price = quote_out / base_in  # gross quote per base

    return CurveFill(
        side=Side.SELL,
        base_amount=base_in,
        quote_amount=quote_out,
        executed_price=executed_price,
        mid_price_before=mid_before,
        mid_price_after=mid_after,
        slippage_bps=_bps_move(executed_price, mid_before),
        price_impact_bps=_bps_move(mid_after, mid_before),
        base_reserve_after=base_reserve_after,
        quote_reserve_after=quote_reserve_after,
    )
