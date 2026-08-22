"""Replay simulator: protocol conformance, position/PnL accounting, rug + liquidity terminality."""

from __future__ import annotations

from decimal import Decimal

from oct_trading_agent.core import (
    FillFailureReason,
    Intent,
    Order,
    Simulator,
    TapeEvent,
    TerminalReason,
)
from oct_trading_agent.sim.amm.fees import PoolConfig
from oct_trading_agent.sim.execution.model import ExecutionParams
from oct_trading_agent.sim.replay.simulator import ReplaySimulator, SimConfig
from tests.conftest import MINT, LiqFactory, RugFactory, SwapFactory, _t


def _config() -> SimConfig:
    return SimConfig(
        risk_budget_quote=Decimal(1),
        pool=PoolConfig(fee_bps=25),
        execution=ExecutionParams.ideal(),
    )


def _order(intent: Intent, size: float = 1.0) -> Order:
    return Order(mint=MINT, intent=intent, size=size)


def test_conforms_to_simulator_protocol(make_liquidity: LiqFactory) -> None:
    sim = ReplaySimulator([make_liquidity(100)], _config())
    assert isinstance(sim, Simulator)


def test_buy_opens_a_position(make_liquidity: LiqFactory) -> None:
    tape: list[TapeEvent] = [make_liquidity(100, "add", "1000000", "100")]
    sim = ReplaySimulator(tape, _config())
    result = sim.step(_order(Intent.OPEN_LONG), _t(200))
    assert result.fill.success
    assert result.position.base_qty > 0
    assert result.position.avg_entry_price is not None
    assert result.realized_pnl_quote == Decimal(0)  # realized only on a sell
    assert not result.terminal


def test_hold_executes_nothing(make_liquidity: LiqFactory) -> None:
    sim = ReplaySimulator([make_liquidity(100)], _config())
    result = sim.step(_order(Intent.HOLD, size=0.0), _t(200))
    assert result.fill.success
    assert result.fill.base_amount == Decimal(0)
    assert result.fill.quote_amount == Decimal(0)
    assert result.position.base_qty == Decimal(0)


def test_buy_then_close_books_realized_pnl_and_terminates(
    make_liquidity: LiqFactory, make_swap: SwapFactory
) -> None:
    # Anchor 1e6:100; a later (someone-else) swap lifts the pool to 5e5:200 (mid x4).
    tape: list[TapeEvent] = [
        make_liquidity(100, "add", "1000000", "100"),
        make_swap(
            300,
            base_amount="500000",
            quote_amount="100",
            base_reserve_after="500000",
            quote_reserve_after="200",
        ),
    ]
    sim = ReplaySimulator(tape, _config())
    sim.step(_order(Intent.OPEN_LONG), _t(200))  # buy cheap
    result = sim.step(_order(Intent.CLOSE), _t(400))  # sell into the higher pool
    assert result.fill.success
    assert result.realized_pnl_quote > Decimal(0)  # bought low, sold high
    assert result.position.base_qty == Decimal(0)
    assert result.terminal
    assert result.terminal_reason is TerminalReason.FULL_EXIT


def test_close_when_flat_is_a_noop(make_liquidity: LiqFactory) -> None:
    sim = ReplaySimulator([make_liquidity(100)], _config())
    result = sim.step(_order(Intent.CLOSE), _t(200))
    assert result.fill.success
    assert result.fill.base_amount == Decimal(0)
    assert not result.terminal


def test_rug_is_terminal_and_fails_the_fill(
    make_liquidity: LiqFactory, make_rug: RugFactory
) -> None:
    tape: list[TapeEvent] = [make_liquidity(100, "add", "1000000", "100"), make_rug(250)]
    sim = ReplaySimulator(tape, _config())
    result = sim.step(_order(Intent.OPEN_LONG), _t(300))
    assert result.terminal
    assert result.terminal_reason is TerminalReason.RUG
    assert not result.fill.success
    assert result.fill.failure_reason is FillFailureReason.RUGGED


def test_buy_before_rug_still_works(
    make_liquidity: LiqFactory, make_rug: RugFactory
) -> None:
    tape: list[TapeEvent] = [make_liquidity(100, "add", "1000000", "100"), make_rug(250)]
    sim = ReplaySimulator(tape, _config())
    # A decision at t=200 is BEFORE the rug at slot 250 -> tradeable (causal).
    result = sim.step(_order(Intent.OPEN_LONG), _t(200))
    assert result.fill.success
    assert not result.terminal


def test_unanchored_pool_is_insufficient_liquidity(make_swap: SwapFactory) -> None:
    # A swap with no carried reserves and no liquidity add -> pool depth unknown -> cannot fill.
    tape: list[TapeEvent] = [make_swap(100)]
    sim = ReplaySimulator(tape, _config())
    result = sim.step(_order(Intent.OPEN_LONG), _t(200))
    assert not result.fill.success
    assert result.fill.failure_reason is FillFailureReason.INSUFFICIENT_LIQUIDITY


def test_liquidity_floor_terminates(make_liquidity: LiqFactory) -> None:
    tape: list[TapeEvent] = [make_liquidity(100, "add", "1000000", "5")]  # 5 SOL depth
    config = SimConfig(
        risk_budget_quote=Decimal(1),
        pool=PoolConfig(fee_bps=25, min_quote_reserve=Decimal(10)),  # floor above depth
        execution=ExecutionParams.ideal(),
    )
    sim = ReplaySimulator(tape, config)
    result = sim.step(_order(Intent.OPEN_LONG), _t(200))
    assert result.terminal
    assert result.terminal_reason is TerminalReason.LIQUIDITY_FLOOR


def test_reset_clears_position(make_liquidity: LiqFactory) -> None:
    sim = ReplaySimulator([make_liquidity(100, "add", "1000000", "100")], _config())
    sim.step(_order(Intent.OPEN_LONG), _t(200))
    assert sim.position(MINT).base_qty > 0
    sim.reset(MINT)
    assert sim.position(MINT).base_qty == Decimal(0)
    assert not sim.is_terminal(MINT)


def test_mark_price_is_reporting_only(make_liquidity: LiqFactory) -> None:
    sim = ReplaySimulator([make_liquidity(100, "add", "1000000", "100")], _config())
    result = sim.step(_order(Intent.OPEN_LONG), _t(200))
    # mark_price is populated for an open position but never feeds realized PnL.
    assert result.position.mark_price is not None
    assert result.position.realized_pnl_quote == Decimal(0)
