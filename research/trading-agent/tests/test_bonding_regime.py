"""Bonding-curve regime setup: the seed anchor lets the replay sim fill on reserve-less swap tape."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from oct_trading_agent.agent.envs.bonding import (
    PUMPFUN_BONDING_FEE_BPS,
    bonding_curve_seed_liquidity,
    bonding_curve_sim_config,
    prepare_bonding_curve_tape,
)
from oct_trading_agent.core import Intent, LiquidityEvent, Order, Side, SwapEvent
from oct_trading_agent.sim.replay.simulator import ReplaySimulator

MINT = "TokenMintPumpFunBonding0000000000000000000000"
T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)


def _swap(i: int, side: Side, base: str, quote: str) -> SwapEvent:
    return SwapEvent(
        mint=MINT,
        slot=1000 + i,
        block_time=T0 + timedelta(seconds=i),
        signature=f"s{i}",
        signer=f"w{i}",
        side=side,
        base_amount=Decimal(base),
        quote_amount=Decimal(quote),
        price=Decimal(quote) / Decimal(base),
        protocol="pumpfun",
    )


def test_seed_liquidity_precedes_first_swap_and_carries_virtual_reserves() -> None:
    swaps = [_swap(0, Side.BUY, "1917", "0.00005")]
    seed = bonding_curve_seed_liquidity(MINT, swaps[0])
    assert isinstance(seed, LiquidityEvent)
    assert seed.slot < swaps[0].slot
    assert seed.block_time < swaps[0].block_time
    assert seed.base_amount == Decimal("1073000000")  # virtual token seed (UI units)
    assert seed.quote_amount == Decimal("30")  # virtual SOL seed


def test_prepared_tape_anchors_the_pool_so_the_sim_can_fill() -> None:
    swaps = [_swap(i, Side.BUY, "1900", "0.00005") for i in range(5)]
    tape = prepare_bonding_curve_tape(swaps)
    assert isinstance(tape[0], LiquidityEvent)  # seed prepended

    sim = ReplaySimulator(tape, bonding_curve_sim_config(risk_budget_quote=Decimal("0.01")))
    # A decision after the first swap must fill against the reconstructed virtual reserves.
    result = sim.step(
        Order(mint=MINT, intent=Intent.OPEN_LONG, size=1.0), T0 + timedelta(seconds=3)
    )
    assert result.fill.success
    assert result.position.base_qty > 0


def test_bonding_fee_is_the_125bps_stack() -> None:
    assert PUMPFUN_BONDING_FEE_BPS == 125
    config = bonding_curve_sim_config()
    assert config.pool.fee_bps == 125


def test_prepare_rejects_multi_mint_tape() -> None:
    a = _swap(0, Side.BUY, "1000", "0.001")
    b = SwapEvent(
        mint="OtherMint", slot=1001, block_time=T0, signer="w", side=Side.BUY,
        base_amount=Decimal("1"), quote_amount=Decimal("1"), price=Decimal("1"),
    )
    try:
        prepare_bonding_curve_tape([a, b])
        raise AssertionError("expected ValueError for multi-mint tape")
    except ValueError:
        pass
