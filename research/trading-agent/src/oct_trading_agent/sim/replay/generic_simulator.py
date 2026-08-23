"""``MarketReplaySimulator`` — the replay simulator that fills against a VENUE-appropriate curve.

:class:`~oct_trading_agent.sim.replay.simulator.ReplaySimulator` is hardwired to one fill law: the
module-level constant-product :func:`~oct_trading_agent.sim.amm.curve.fill_buy` / ``fill_sell`` with a
single flat LP fee. That is correct for the pump.fun *bonding-curve* regime it was built for, but it
mis-prices every other venue — a ``pumpfun_amm`` swap (three-part fee stack, LP-retained only) or a
CLMM swap (concentrated liquidity, fee accrued outside the range) fills wrong, which is exactly why
running the bonding env on migrated tokens produces impossible numbers.

This subclass changes **only the fill law**. It keeps every other part of the base simulator intact —
the rug/absorbing-state check, the causal as-of pool reconstruction, the risk-budget sizing, the
execution-realism layer (latency/MEV/fail/gas), the realized-only position book, and the terminal
logic — and routes the buy/sell fill through an injected :class:`~oct_trading_agent.sim.curves.base.Curve`
(resolved from the token's venue via the registry). A curve that refuses the fill (non-positive
depth, a CLMM order that would cross a tick, an unsupported venue's raise) is turned into an honest
``INSUFFICIENT_LIQUIDITY`` fill, never a fabricated number — the same way the base handles a thin pool.

One env instance trades one token, whose swaps share one venue in a given Pinax pull, so the curve is
resolved once and held for the episode. The reserve trajectory the base reconstructor rolls forward
comes from :func:`~oct_trading_agent.sim.replay.reconstruct.prepare_market_tape` (a fit or independent
anchor), NOT the hardcoded pump.fun bonding seed.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from oct_trading_agent.core import FillFailureReason, Order, SimStepResult, TapeEvent
from oct_trading_agent.sim.amm.pool import PoolState
from oct_trading_agent.sim.curves.base import Curve
from oct_trading_agent.sim.replay.simulator import (
    ReplaySimulator,
    SimConfig,
    _EpisodeState,
)

__all__ = ["MarketReplaySimulator"]

_CURVE_ERRORS = (ValueError, ZeroDivisionError, ArithmeticError)


class MarketReplaySimulator(ReplaySimulator):
    """A :class:`ReplaySimulator` that fills through a venue :class:`Curve` instead of the flat CP law.

    Construct with the sim-ready ``tape`` (anchor ``add`` + swaps), a :class:`SimConfig`, and the
    resolved venue ``curve``. Everything except the two fill helpers is inherited unchanged.
    """

    def __init__(self, tape: list[TapeEvent], config: SimConfig | None, *, curve: Curve) -> None:
        super().__init__(tape, config)
        self._curve = curve

    @property
    def curve(self) -> Curve:
        return self._curve

    def _do_buy(
        self, ep: _EpisodeState, order: Order, as_of: datetime, pool: PoolState
    ) -> SimStepResult:
        quote_in = self.config.risk_budget_quote * Decimal(str(order.size))
        if quote_in <= 0:
            return self._noop_result(ep, order, pool)
        if not pool.tradeable:
            return self._fail_result(ep, order, pool, FillFailureReason.INSUFFICIENT_LIQUIDITY)

        try:
            curve_fill = self._curve.fill_buy(quote_in, pool)
        except _CURVE_ERRORS:
            # Venue curve refused (non-positive depth, out-of-range CLMM, etc.) — honest thin-pool
            # failure, never a fabricated fill.
            return self._fail_result(ep, order, pool, FillFailureReason.INSUFFICIENT_LIQUIDITY)
        if self._impact_too_large(curve_fill):
            return self._fail_result(ep, order, pool, FillFailureReason.INSUFFICIENT_LIQUIDITY)

        fill = self._exec.realize(curve_fill, order)
        realized = Decimal(0)
        if fill.success:
            realized = ep.book.apply_buy(fill, as_of)
        return self._result(ep, fill, pool, realized, terminal=False)

    def _do_sell(
        self, ep: _EpisodeState, order: Order, as_of: datetime, pool: PoolState
    ) -> SimStepResult:
        held = ep.book.base_qty
        if held <= 0:
            return self._noop_result(ep, order, pool)
        from oct_trading_agent.core import Intent

        frac = Decimal(1) if order.intent is Intent.CLOSE else Decimal(str(order.size))
        base_in = held if order.intent is Intent.CLOSE else min(held, held * frac)
        if base_in <= 0:
            return self._noop_result(ep, order, pool)
        if not pool.tradeable:
            return self._fail_result(ep, order, pool, FillFailureReason.INSUFFICIENT_LIQUIDITY)

        try:
            curve_fill = self._curve.fill_sell(base_in, pool)
        except _CURVE_ERRORS:
            return self._fail_result(ep, order, pool, FillFailureReason.INSUFFICIENT_LIQUIDITY)
        if self._impact_too_large(curve_fill):
            return self._fail_result(ep, order, pool, FillFailureReason.INSUFFICIENT_LIQUIDITY)

        fill = self._exec.realize(curve_fill, order)
        realized = Decimal(0)
        terminal = False
        if fill.success:
            realized = ep.book.apply_sell(fill)
            if ep.book.base_qty <= 0:
                from oct_trading_agent.core import TerminalReason

                ep.terminal = True
                ep.terminal_reason = TerminalReason.FULL_EXIT
                terminal = True
        return self._result(ep, fill, pool, realized, terminal=terminal)
