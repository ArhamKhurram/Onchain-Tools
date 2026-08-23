"""Generic reserve-reconstruction tests — self-consistency anchor fit + sim-ready tape shape.

Network-free and torch-free: synthetic constant-product pools with a KNOWN depth, so the fit has a
ground truth to recover.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from oct_trading_agent.core import LiquidityEvent, Side, SwapEvent
from oct_trading_agent.sim.replay.reconstruct import (
    ReserveAnchor,
    anchor_seed_liquidity,
    fit_reserve_anchor,
    prepare_market_tape,
)

MINT = "TokenGenericReconstruct00000000000000000000"
T0 = datetime(2026, 8, 22, tzinfo=UTC)


def _cp_swaps(
    *, base0: Decimal, quote0: Decimal, n: int = 50, fee_bps: int = 30, protocol: str = "pumpfun_amm"
) -> list[SwapEvent]:
    """Generate swaps off a KNOWN constant-product pool (V2 fee retained), alternating buy/sell."""
    base_res, quote_res = base0, quote0
    fee = Decimal(fee_bps) / Decimal(10_000)
    swaps: list[SwapEvent] = []
    for i in range(n):
        side = Side.BUY if i % 3 != 0 else Side.SELL
        if side is Side.BUY:
            q = Decimal("0.05")
            dq = q * (Decimal(1) - fee)
            b = base_res * dq / (quote_res + dq)
            base_res -= b
            quote_res += q
            qa, ba = q, b
        else:
            b = Decimal("500")
            db = b * (Decimal(1) - fee)
            q = quote_res * db / (base_res + db)
            base_res += b
            quote_res -= q
            qa, ba = q, b
        swaps.append(
            SwapEvent(
                mint=MINT, slot=1000 + i, block_time=T0 + timedelta(seconds=i * 2),
                signature=f"s{i}", signer=f"w{i % 6}", side=side,
                base_amount=ba, quote_amount=qa, price=qa / ba, protocol=protocol,
            )
        )
    return swaps


def test_fit_recovers_known_pool_price() -> None:
    """The self-consistency fit recovers the pool's mid price to within a percent."""
    base0, quote0 = Decimal("1000000"), Decimal("50")  # mid = 5e-5
    swaps = _cp_swaps(base0=base0, quote0=quote0)
    anchor = fit_reserve_anchor(swaps, fee_bps=30)
    assert anchor.source == "self_consistency_fit"
    true_mid = quote0 / base0
    assert abs(anchor.mid_price / true_mid - Decimal(1)) < Decimal("0.02")
    assert anchor.base_reserve > 0 and anchor.quote_reserve > 0
    assert anchor.reliable  # a clean synthetic pool fits tightly


def test_fit_recovers_depth_order_of_magnitude() -> None:
    """Fitted depth is the right order of magnitude (the fit identifies L, not just price)."""
    base0, quote0 = Decimal("2000000"), Decimal("80")
    anchor = fit_reserve_anchor(_cp_swaps(base0=base0, quote0=quote0), fee_bps=30)
    # Within 3x of true depth on both legs (self-consistency depth is weakly identified by small
    # trades, but must not be orders of magnitude off).
    assert Decimal("0.33") < anchor.quote_reserve / quote0 < Decimal(3)
    assert Decimal("0.33") < anchor.base_reserve / base0 < Decimal(3)


def test_prepare_market_tape_prepends_anchor_add() -> None:
    swaps = _cp_swaps(base0=Decimal("1000000"), quote0=Decimal("50"))
    tape, anchor = prepare_market_tape(swaps, fee_bps=30)
    seed = tape[0]
    assert isinstance(seed, LiquidityEvent)
    assert seed.action == "add"
    assert seed.base_amount == anchor.base_reserve
    assert seed.quote_amount == anchor.quote_reserve
    assert seed.slot < swaps[0].slot  # anchor is causally BEFORE the first swap
    assert len(tape) == len(swaps) + 1


def test_prepare_market_tape_uses_explicit_anchor() -> None:
    swaps = _cp_swaps(base0=Decimal("1000000"), quote0=Decimal("50"))
    explicit = ReserveAnchor(
        base_reserve=Decimal("999999"), quote_reserve=Decimal("49"),
        slot=swaps[0].slot, source="independent_reserves",
    )
    tape, anchor = prepare_market_tape(swaps, anchor=explicit)
    assert anchor is explicit
    seed = tape[0]
    assert isinstance(seed, LiquidityEvent)
    assert seed.base_amount == Decimal("999999")


def test_prepare_market_tape_rejects_multi_mint() -> None:
    swaps = _cp_swaps(base0=Decimal("1000000"), quote0=Decimal("50"))
    swaps[-1] = swaps[-1].model_copy(update={"mint": "OTHER_MINT"})
    with pytest.raises(ValueError, match="one mint"):
        prepare_market_tape(swaps)


def test_prepare_market_tape_rejects_empty() -> None:
    with pytest.raises(ValueError, match="at least one swap"):
        prepare_market_tape([])


def test_fit_rejects_too_few_swaps() -> None:
    swaps = _cp_swaps(base0=Decimal("1000000"), quote0=Decimal("50"), n=3)
    with pytest.raises(ValueError):
        fit_reserve_anchor(swaps)


def test_anchor_seed_liquidity_is_causal_and_carries_reserves() -> None:
    swaps = _cp_swaps(base0=Decimal("1000000"), quote0=Decimal("50"))
    anchor = ReserveAnchor(
        base_reserve=Decimal("1000000"), quote_reserve=Decimal("50"),
        slot=swaps[0].slot - 1, source="self_consistency_fit",
    )
    seed = anchor_seed_liquidity(MINT, swaps[0], anchor)
    assert seed.action == "add"
    assert seed.slot == swaps[0].slot - 1
    assert seed.block_time < swaps[0].block_time
    assert seed.base_amount == Decimal("1000000")
