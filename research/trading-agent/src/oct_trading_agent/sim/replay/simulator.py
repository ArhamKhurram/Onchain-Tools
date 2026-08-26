"""The replay simulator — implements the ``core.sim.Simulator`` protocol.

Orchestrates the pieces every step (02 §2 (3)):

    order  ─▶ rug/terminal check (absorbing states, causal as-of)
           ─▶ pool-state reconstruction as-of the decision instant
           ─▶ intent+size ─▶ absolute side/amount (against the risk budget)
           ─▶ closed-form curve fill  ─▶ execution realism (latency/MEV/fail/fees)
           ─▶ position update (cost-inclusive, realized-only)
           ─▶ SimStepResult (fill, new position, terminality)

**Conservative own-impact-only** (02 §7): the agent's order moves the curve for *its own* fill; it
does not assume it changes anyone else's behavior. The pool state is reconstructed from the tape as
if the order were inserted at ``as_of`` without perturbing the historical flow — a documented lower
bound on adversariality.

Per-token episode state (position, terminal flag) lives in :class:`_EpisodeState`; ``reset(mint)``
clears it. The hot loop sits behind ``Simulator`` so a Rust kernel can replace it later where
profiling proves it necessary — no premature native code (src/README.md).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

import numpy as np

from oct_trading_agent.core import (
    Fill,
    FillFailureReason,
    Intent,
    Mint,
    Order,
    PositionState,
    SimStepResult,
    TapeEvent,
    TerminalReason,
)
from oct_trading_agent.sim.amm.curve import CurveFill, fill_buy, fill_sell
from oct_trading_agent.sim.amm.fees import PoolConfig
from oct_trading_agent.sim.amm.pool import PoolReconstructor, PoolState
from oct_trading_agent.sim.execution.model import ExecutionModel, ExecutionParams
from oct_trading_agent.sim.replay.position import PositionBook
from oct_trading_agent.sim.rug.absorbing import RugTracker

_BUY_INTENTS = frozenset({Intent.OPEN_LONG, Intent.ADD})
_SELL_INTENTS = frozenset({Intent.TRIM, Intent.CLOSE})


@dataclass
class SimConfig:
    """Simulator-wide configuration.

    ``risk_budget_quote`` is the quote (SOL) a full-size (``Order.size == 1.0``) BUY spends — the
    ``f_max`` slice. Per-token hard caps are enforced here/in the risk layer, not by trusting the
    order (``core.sim`` note). ``pool`` carries the venue fee + liquidity guards; ``execution``
    carries the friction model; ``seed`` makes stochastic execution reproducible.
    """

    risk_budget_quote: Decimal = Decimal(1)
    pool: PoolConfig = field(default_factory=PoolConfig)
    execution: ExecutionParams = field(default_factory=ExecutionParams)
    seed: int = 0


@dataclass
class _EpisodeState:
    """Per-token mutable episode state."""

    book: PositionBook
    reconstructor: PoolReconstructor
    terminal: bool = False
    terminal_reason: TerminalReason | None = None


class ReplaySimulator:
    """Recent-window replay simulator over an in-memory tape. Implements ``core.sim.Simulator``.

    Construct with the tape (one or many mints) and a :class:`SimConfig`. Each ``step`` fills one
    order against pool state reconstructed as-of the decision instant. Absorbing states (rugs, and
    an optional liquidity floor) short-circuit to a terminal result.
    """

    def __init__(self, tape: list[TapeEvent], config: SimConfig | None = None) -> None:
        self._tape = tape
        self.config = config or SimConfig()
        self._rug = RugTracker(tape)
        self._rng = np.random.default_rng(self.config.seed)
        self._exec = ExecutionModel(self.config.execution, self._rng)
        self._episodes: dict[Mint, _EpisodeState] = {}

    # -- Simulator protocol -------------------------------------------------------------------

    def step(self, order: Order, as_of: datetime) -> SimStepResult:
        ep = self._episode(order.mint)

        # 1) Absorbing states first (causal as-of). A rug at/before now is terminal, forever.
        if not ep.terminal and self._rug.is_rugged_as_of(order.mint, as_of):
            ep.terminal = True
            ep.terminal_reason = TerminalReason.RUG
        if ep.terminal:
            return self._terminal_result(ep, order, as_of)

        # 2) Reconstruct pool state as-of the decision instant.
        pool = ep.reconstructor.state_as_of(as_of)

        # 3) Liquidity floor: a pool that has drained below the floor is a (terminal) death.
        floor = self.config.pool.min_quote_reserve
        if pool.anchored and floor > 0 and pool.quote_reserve <= floor:
            ep.terminal = True
            ep.terminal_reason = TerminalReason.LIQUIDITY_FLOOR
            return self._terminal_result(ep, order, as_of)

        # 4) Venue handoff (e.g. a bonding curve that graduated). Checked BEFORE routing so a HOLD
        #    sees it too — see Curve.is_complete for why that matters.
        venue_reason = self._venue_absorbed(pool)
        if venue_reason is not None:
            ep.terminal = True
            ep.terminal_reason = venue_reason
            return self._terminal_result(ep, order, as_of)

        # 5) Route the intent.
        if order.intent in _BUY_INTENTS:
            return self._do_buy(ep, order, as_of, pool)
        if order.intent in _SELL_INTENTS:
            return self._do_sell(ep, order, as_of, pool)
        # NO_OP / HOLD — nothing executes, position unchanged.
        return self._noop_result(ep, order, pool)

    def _venue_absorbed(self, pool: PoolState) -> TerminalReason | None:
        """Hook: has the venue handed this token off? Base simulator has one fixed law, so never."""
        return None

    def reset(self, mint: Mint) -> None:
        """Reset per-token episode state (position, absorbing flags)."""
        self._episodes.pop(mint, None)

    def force_close_at(self, mint: Mint, as_of: datetime) -> SimStepResult:
        """Close an open position as-of a time the venue could still quote, bypassing the absorbing flag.

        **Only valid for a GRADUATED episode.** A graduated token did not die — it migrated to
        another venue and is still worth something, so leaving the position unrealized would book a
        winner as a total loss of its entry cost. Every other absorbing state (a rug above all) is
        genuinely unsellable, and bypassing the flag there would fabricate an exit that could not
        have happened; this method refuses those outright.

        ``as_of`` must be an instant where the curve still quotes — in practice the decision step
        *before* the one that reported graduation.
        """
        ep = self._episode(mint)
        if ep.terminal_reason is not TerminalReason.GRADUATED:
            raise ValueError(
                "force_close_at is only valid for a GRADUATED episode; "
                f"this one is {ep.terminal_reason}"
            )
        was_terminal, was_reason = ep.terminal, ep.terminal_reason
        ep.terminal = False
        try:
            return self.step(Order(mint=mint, intent=Intent.CLOSE), as_of)
        finally:
            # Restore BOTH: a successful close would otherwise stamp the episode FULL_EXIT and lose
            # the real reason it ended. The agent did not choose to exit — the venue moved.
            ep.terminal, ep.terminal_reason = was_terminal, was_reason

    # -- helpers ------------------------------------------------------------------------------

    def _episode(self, mint: Mint) -> _EpisodeState:
        ep = self._episodes.get(mint)
        if ep is None:
            ep = _EpisodeState(
                book=PositionBook(mint),
                reconstructor=PoolReconstructor(self._tape, mint),
            )
            self._episodes[mint] = ep
        return ep

    def _mark(self, pool: PoolState) -> Decimal | None:
        return pool.mid_price if pool.tradeable else None

    def _do_buy(
        self, ep: _EpisodeState, order: Order, as_of: datetime, pool: PoolState
    ) -> SimStepResult:
        quote_in = self.config.risk_budget_quote * Decimal(str(order.size))
        if quote_in <= 0:
            return self._noop_result(ep, order, pool)
        if not pool.tradeable:
            return self._fail_result(ep, order, pool, FillFailureReason.INSUFFICIENT_LIQUIDITY)

        curve = fill_buy(
            quote_in, pool.base_reserve, pool.quote_reserve, self.config.pool.fee_fraction
        )
        if self._impact_too_large(curve):
            return self._fail_result(ep, order, pool, FillFailureReason.INSUFFICIENT_LIQUIDITY)

        fill = self._exec.realize(curve, order)
        realized = Decimal(0)
        if fill.success:
            realized = ep.book.apply_buy(fill, as_of)
        return self._result(ep, fill, pool, realized, terminal=False)

    def _do_sell(
        self, ep: _EpisodeState, order: Order, as_of: datetime, pool: PoolState
    ) -> SimStepResult:
        held = ep.book.base_qty
        if held <= 0:
            return self._noop_result(ep, order, pool)  # nothing to sell
        frac = Decimal(1) if order.intent is Intent.CLOSE else Decimal(str(order.size))
        base_in = held if order.intent is Intent.CLOSE else min(held, held * frac)
        if base_in <= 0:
            return self._noop_result(ep, order, pool)
        if not pool.tradeable:
            return self._fail_result(ep, order, pool, FillFailureReason.INSUFFICIENT_LIQUIDITY)

        curve = fill_sell(
            base_in, pool.base_reserve, pool.quote_reserve, self.config.pool.fee_fraction
        )
        if self._impact_too_large(curve):
            return self._fail_result(ep, order, pool, FillFailureReason.INSUFFICIENT_LIQUIDITY)

        fill = self._exec.realize(curve, order)
        realized = Decimal(0)
        terminal = False
        if fill.success:
            realized = ep.book.apply_sell(fill)
            if ep.book.base_qty <= 0:
                # A full exit ends the episode naturally (paper §3.4).
                ep.terminal = True
                ep.terminal_reason = TerminalReason.FULL_EXIT
                terminal = True
        return self._result(ep, fill, pool, realized, terminal=terminal)

    def _impact_too_large(self, curve: CurveFill) -> bool:
        cap = self.config.pool.max_price_impact_bps
        return cap > 0 and curve.price_impact_bps > cap

    # -- result builders ----------------------------------------------------------------------

    def _result(
        self,
        ep: _EpisodeState,
        fill: Fill,
        pool: PoolState,
        realized: Decimal,
        *,
        terminal: bool,
    ) -> SimStepResult:
        return SimStepResult(
            fill=fill,
            position=ep.book.snapshot(self._mark(pool)),
            realized_pnl_quote=realized,
            terminal=terminal,
            terminal_reason=ep.terminal_reason if terminal else None,
        )

    def _noop_result(
        self, ep: _EpisodeState, order: Order, pool: PoolState
    ) -> SimStepResult:
        fill = Fill(
            mint=order.mint,
            intent=order.intent,
            success=True,  # a HOLD/NO_OP is not a failure — it simply executed nothing
            executed_price=None,
            base_amount=Decimal(0),
            quote_amount=Decimal(0),
        )
        return self._result(ep, fill, pool, Decimal(0), terminal=False)

    def _fail_result(
        self,
        ep: _EpisodeState,
        order: Order,
        pool: PoolState,
        reason: FillFailureReason,
    ) -> SimStepResult:
        return self._result(ep, self._exec.fail(order, reason), pool, Decimal(0), terminal=False)

    def _terminal_result(
        self, ep: _EpisodeState, order: Order, as_of: datetime
    ) -> SimStepResult:
        # No pool reconstruction on a dead token — mark is gone.
        reason = ep.terminal_reason
        if reason is TerminalReason.RUG:
            fill_reason = FillFailureReason.RUGGED
        elif reason is TerminalReason.GRADUATED:
            # NOT "insufficient liquidity" — the pool is deep, it simply moved to another venue.
            # Calling a migration a thin pool would poison the fill-failure diagnostics.
            fill_reason = FillFailureReason.VENUE_MIGRATED
        else:
            fill_reason = FillFailureReason.INSUFFICIENT_LIQUIDITY
        return SimStepResult(
            fill=self._exec.fail(order, fill_reason),
            position=ep.book.snapshot(None),
            realized_pnl_quote=Decimal(0),
            terminal=True,
            terminal_reason=reason,
        )

    # -- introspection (for the ledger / episode driver) --------------------------------------

    def position(self, mint: Mint) -> PositionState:
        """Current position snapshot for a mint (no mark — pool is not reconstructed here)."""
        return self._episode(mint).book.snapshot(None)

    def is_terminal(self, mint: Mint) -> bool:
        ep = self._episodes.get(mint)
        return ep is not None and ep.terminal

    def terminal_reason(self, mint: Mint) -> TerminalReason | None:
        ep = self._episodes.get(mint)
        return ep.terminal_reason if ep is not None else None
