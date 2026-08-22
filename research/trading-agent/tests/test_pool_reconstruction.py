"""Pool-state reconstruction: anchoring, delta folding, ground-truth snapping, causality."""

from __future__ import annotations

from decimal import Decimal

from oct_trading_agent.core import Side, TapeEvent
from oct_trading_agent.sim.amm.pool import PoolReconstructor
from tests.conftest import MINT, LiqFactory, SwapFactory, _t


def test_unanchored_before_any_liquidity(make_swap: SwapFactory) -> None:
    # A lone swap with no carried reserves and no prior liquidity cannot be anchored.
    tape: list[TapeEvent] = [make_swap(100, base_reserve_after=None, quote_reserve_after=None)]
    state = PoolReconstructor(tape, MINT).state_as_of(_t(200))
    assert not state.anchored
    assert not state.tradeable


def test_liquidity_add_anchors_depth(make_liquidity: LiqFactory) -> None:
    tape: list[TapeEvent] = [make_liquidity(100, "add", "1000000", "100")]
    state = PoolReconstructor(tape, MINT).state_as_of(_t(200))
    assert state.anchored
    assert state.base_reserve == Decimal(1_000_000)
    assert state.quote_reserve == Decimal(100)
    assert state.mid_price == Decimal("0.0001")


def test_swap_deltas_fold_onto_anchor(
    make_liquidity: LiqFactory, make_swap: SwapFactory
) -> None:
    # Anchor 1e6:100, then a BUY of 500 base for 0.05 quote -> reserves 999500 : 100.05.
    tape: list[TapeEvent] = [
        make_liquidity(100, "add", "1000000", "100"),
        make_swap(200, side=Side.BUY, base_amount="500", quote_amount="0.05"),
    ]
    state = PoolReconstructor(tape, MINT).state_as_of(_t(300))
    assert state.base_reserve == Decimal(1_000_000) - Decimal(500)
    assert state.quote_reserve == Decimal(100) + Decimal("0.05")


def test_carried_reserves_snap_over_folding(
    make_liquidity: LiqFactory, make_swap: SwapFactory
) -> None:
    # A swap that carries reserves_after is ground truth and OVERRIDES the folded estimate.
    tape: list[TapeEvent] = [
        make_liquidity(100, "add", "1000000", "100"),
        make_swap(
            200,
            side=Side.BUY,
            base_amount="500",
            quote_amount="0.05",
            base_reserve_after="900000",  # deliberately different from the folded 999500
            quote_reserve_after="111",
        ),
    ]
    state = PoolReconstructor(tape, MINT).state_as_of(_t(300))
    assert state.base_reserve == Decimal(900_000)
    assert state.quote_reserve == Decimal(111)


def test_causal_no_future_events(
    make_liquidity: LiqFactory, make_swap: SwapFactory
) -> None:
    tape: list[TapeEvent] = [
        make_liquidity(100, "add", "1000000", "100"),
        make_swap(500, side=Side.BUY, base_amount="900000", quote_amount="900"),  # far future
    ]
    # As-of slot-300 time: the future swap must not move the reserves.
    state = PoolReconstructor(tape, MINT).state_as_of(_t(300))
    assert state.base_reserve == Decimal(1_000_000)
    assert state.quote_reserve == Decimal(100)


def test_state_before_slot_excludes_the_swap_itself(
    make_liquidity: LiqFactory, make_swap: SwapFactory
) -> None:
    tape: list[TapeEvent] = [
        make_liquidity(100, "add", "1000000", "100"),
        make_swap(200, side=Side.BUY, base_amount="500", quote_amount="0.05"),
    ]
    recon = PoolReconstructor(tape, MINT)
    # Pre-slot-200 state is the anchor only (the swap at 200 is not folded in).
    pre = recon.state_before_slot(200)
    assert pre.base_reserve == Decimal(1_000_000)
    assert pre.quote_reserve == Decimal(100)


def test_remove_liquidity_reduces_depth(
    make_liquidity: LiqFactory,
) -> None:
    tape: list[TapeEvent] = [
        make_liquidity(100, "add", "1000000", "100"),
        make_liquidity(200, "remove", "400000", "40"),
    ]
    state = PoolReconstructor(tape, MINT).state_as_of(_t(300))
    assert state.base_reserve == Decimal(600_000)
    assert state.quote_reserve == Decimal(60)


def test_sell_folds_opposite_direction(
    make_liquidity: LiqFactory, make_swap: SwapFactory
) -> None:
    tape: list[TapeEvent] = [
        make_liquidity(100, "add", "1000000", "100"),
        make_swap(200, side=Side.SELL, base_amount="1000", quote_amount="0.1"),
    ]
    state = PoolReconstructor(tape, MINT).state_as_of(_t(300))
    # A SELL adds base to the pool, removes quote.
    assert state.base_reserve == Decimal(1_001_000)
    assert state.quote_reserve == Decimal("99.9")
