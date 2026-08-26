"""Graduation handoff: a bonding curve that completes ends the episode instead of crashing.

The bonding curve raises :class:`BondingCurveComplete` when ``real_token_reserves`` hits zero — an
explicit venue handoff, deliberately NOT the ``ValueError`` that means "thin pool". Nothing caught
it, so the first token in a training cohort to actually graduate killed the run with an unhandled
exception (observed live at ladder iteration ~1000).

A ``pumpfun`` tape *stops* at migration — it holds no post-graduation swaps to price against — so
the correct handling is to end the episode, not to re-resolve onto the AMM curve. The one thing that
must not happen is silently dropping an open position: graduation means the token SUCCEEDED, and
booking a winner as a total loss of its entry cost biases the measurement against exactly the tokens
the study exists to find.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from oct_trading_agent.core import (
    FillFailureReason,
    Intent,
    Order,
    TapeEvent,
    TerminalReason,
)
from oct_trading_agent.sim.amm.curve import CurveFill
from oct_trading_agent.sim.amm.fees import PoolConfig
from oct_trading_agent.sim.amm.pool import PoolState
from oct_trading_agent.sim.curves.base import Curve, CurveInput
from oct_trading_agent.sim.curves.bonding_curve import BondingCurveComplete
from oct_trading_agent.sim.curves.constant_product import ConstantProductCurve
from oct_trading_agent.sim.execution.model import ExecutionParams
from oct_trading_agent.sim.replay.generic_simulator import MarketReplaySimulator
from oct_trading_agent.sim.replay.simulator import SimConfig
from tests.conftest import MINT, LiqFactory, SwapFactory, _t


class _GraduatesAt(Curve):
    """Constant-product until the quote reserve crosses ``at_quote``, then permanently graduated.

    Stands in for a real bonding curve crossing ``real_token_reserves == 0``. Crucially it is a
    function of the POOL STATE, exactly like the real one: graduation is a property of an instant,
    so an earlier instant is still quotable. A call-counter stub would hide the bug these tests
    exist to catch — that the forced close must reach BACK to a time the curve can still price.
    """

    def __init__(self, at_quote: str = "150") -> None:
        self._inner = ConstantProductCurve(fee_bps=25)
        self._at = Decimal(at_quote)

    def is_complete(self, state: PoolState) -> bool:
        return state.quote_reserve >= self._at

    def fill(self, request: CurveInput, state: PoolState) -> CurveFill:
        if self.is_complete(state):
            raise BondingCurveComplete(Decimal(0))
        return self._inner.fill(request, state)


class _RaisesOnly(_GraduatesAt):
    """Graduates but never advertises it — proves the ``except`` backstop still catches the raise."""

    def is_complete(self, state: PoolState) -> bool:
        return False

    def fill(self, request: CurveInput, state: PoolState) -> CurveFill:
        if state.quote_reserve >= self._at:
            raise BondingCurveComplete(Decimal(0))
        return self._inner.fill(request, state)


def _graduating_tape(make_liquidity: LiqFactory, make_swap: SwapFactory) -> list[TapeEvent]:
    """Deep pool at t=100, then a buy at t=250 that lifts the quote reserve past the threshold."""
    return [
        make_liquidity(100, "add", "1000000", "100"),
        make_swap(
            250,
            base_amount="100000",
            quote_amount="100",
            base_reserve_after="900000",
            quote_reserve_after="200",
        ),
    ]


def _config() -> SimConfig:
    return SimConfig(
        risk_budget_quote=Decimal(1),
        pool=PoolConfig(fee_bps=25),
        execution=ExecutionParams.ideal(),
    )


def _sim(tape: list[TapeEvent], curve: Curve) -> MarketReplaySimulator:
    return MarketReplaySimulator(tape, _config(), curve=curve)


def _order(intent: Intent, size: float = 1.0) -> Order:
    return Order(mint=MINT, intent=intent, size=size)


# -- the crash itself ---------------------------------------------------------------------------


def test_graduation_does_not_raise(make_liquidity: LiqFactory) -> None:
    """The regression that matters: this exact path used to kill a 20-hour training run."""
    tape: list[TapeEvent] = [make_liquidity(100, "add", "1000000", "100")]
    sim = _sim(tape, _GraduatesAt(at_quote="50"))
    result = sim.step(_order(Intent.OPEN_LONG), _t(200))  # would have raised BondingCurveComplete
    assert result.terminal
    assert result.terminal_reason is TerminalReason.GRADUATED


def test_graduation_is_not_reported_as_a_thin_pool(make_liquidity: LiqFactory) -> None:
    """A migrated pool is DEEP. Calling it INSUFFICIENT_LIQUIDITY would poison fill diagnostics."""
    tape: list[TapeEvent] = [make_liquidity(100, "add", "1000000", "100")]
    sim = _sim(tape, _GraduatesAt(at_quote="50"))
    result = sim.step(_order(Intent.OPEN_LONG), _t(200))
    assert result.fill.failure_reason is FillFailureReason.VENUE_MIGRATED
    assert result.fill.failure_reason is not FillFailureReason.INSUFFICIENT_LIQUIDITY


def test_graduation_is_absorbing(make_liquidity: LiqFactory) -> None:
    tape: list[TapeEvent] = [make_liquidity(100, "add", "1000000", "100")]
    sim = _sim(tape, _GraduatesAt(at_quote="50"))
    sim.step(_order(Intent.OPEN_LONG), _t(200))
    again = sim.step(_order(Intent.OPEN_LONG), _t(300))
    assert again.terminal
    assert sim.terminal_reason(MINT) is TerminalReason.GRADUATED


def test_hold_detects_graduation(
    make_liquidity: LiqFactory, make_swap: SwapFactory
) -> None:
    """A HOLD fills nothing, so it never touches the curve — the handoff must be polled, not raised.

    Without the absorbing-state check an agent could sit through a graduation entirely unnoticed and
    reach end-of-tape still holding, which books the winner as unrealized (i.e. as a total loss).
    """
    sim = _sim(_graduating_tape(make_liquidity, make_swap), _GraduatesAt())
    sim.step(_order(Intent.OPEN_LONG), _t(200))
    held = sim.step(_order(Intent.HOLD, size=0.0), _t(300))
    assert held.terminal
    assert held.terminal_reason is TerminalReason.GRADUATED


def test_raise_is_still_caught_when_the_curve_does_not_advertise(
    make_liquidity: LiqFactory,
) -> None:
    """Belt and braces: a third-party curve that only raises must not crash the run either."""
    tape: list[TapeEvent] = [make_liquidity(100, "add", "1000000", "100")]
    sim = _sim(tape, _RaisesOnly(at_quote="50"))
    result = sim.step(_order(Intent.OPEN_LONG), _t(200))
    assert result.terminal
    assert result.terminal_reason is TerminalReason.GRADUATED


# -- the open position --------------------------------------------------------------------------


def test_force_close_realizes_a_position_held_through_graduation(
    make_liquidity: LiqFactory, make_swap: SwapFactory
) -> None:
    """The bias guard: a winner must not book as a total loss of its entry cost."""
    sim = _sim(_graduating_tape(make_liquidity, make_swap), _GraduatesAt())

    opened = sim.step(_order(Intent.OPEN_LONG), _t(200))
    assert opened.fill.success and opened.position.base_qty > 0

    graduated = sim.step(_order(Intent.HOLD, size=0.0), _t(300))
    assert graduated.terminal_reason is TerminalReason.GRADUATED

    closed = sim.force_close_at(MINT, _t(200))
    assert closed.fill.success
    assert closed.position.base_qty == Decimal(0)
    assert closed.realized_pnl_quote != Decimal(0)


def test_force_close_preserves_the_reason_the_episode_ended(
    make_liquidity: LiqFactory, make_swap: SwapFactory
) -> None:
    """The agent did not choose to exit — the venue moved. FULL_EXIT would misattribute that."""
    sim = _sim(_graduating_tape(make_liquidity, make_swap), _GraduatesAt())
    sim.step(_order(Intent.OPEN_LONG), _t(200))
    sim.step(_order(Intent.HOLD, size=0.0), _t(300))
    sim.force_close_at(MINT, _t(200))
    assert sim.terminal_reason(MINT) is TerminalReason.GRADUATED
    assert sim.is_terminal(MINT)


def test_force_close_refuses_any_other_absorbing_state(make_liquidity: LiqFactory) -> None:
    """A rugged token is genuinely unsellable — bypassing the flag there fabricates an exit."""
    tape: list[TapeEvent] = [make_liquidity(100, "add", "1000000", "100")]
    sim = _sim(tape, ConstantProductCurve(fee_bps=25))
    sim.step(_order(Intent.OPEN_LONG), _t(200))
    with pytest.raises(ValueError, match="GRADUATED"):
        sim.force_close_at(MINT, _t(200))


# -- the signal is still distinct ---------------------------------------------------------------


def test_bonding_curve_complete_is_not_a_value_error() -> None:
    """If this ever becomes a ValueError, the simulator silently books migrations as thin pools."""
    assert issubclass(BondingCurveComplete, LookupError)
    assert not issubclass(BondingCurveComplete, ValueError)
