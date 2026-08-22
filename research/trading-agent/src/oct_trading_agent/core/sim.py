"""Simulator contract — ``Order`` (intent) → ``Fill`` (execution) → ``SimStepResult``.

The replay simulator (02 §2 (3); the single largest engineering item) fills orders against
reconstructed AMM pool state. This module defines the *interface* only; ``sim/`` (Wave-1) owns
the AMM curve, slippage/impact, latency/MEV, fees, and rug absorbing states.

Conventions:

* **Long-only in the alpha** (paper §3.3) — an ``Order`` never expresses a short.
* **Size is a fraction of the risk budget** in ``[0, f_max]``; ``f_max`` maps to ``1.0`` here.
  The hard per-token cap is enforced *inside the sim/risk layer*, not by trusting the order.
* **Realized only.** ``SimStepResult`` reports realized PnL; a ``mark_price`` is carried for
  reporting but is explicitly NOT a reward-bearing quantity (paper §3.5.4 — never reward
  unrealized/peak PnL). The reward function (``agent/``) consumes results; the sim does not
  score.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Protocol, runtime_checkable

from pydantic import Field

from .base import Frozen
from .enums import FillFailureReason, Intent, TerminalReason
from .tape import Mint

NonNegDecimal = Decimal  # documented non-negative; validated per-field below


class Order(Frozen):
    """An execution intent for one candidate token on one decision step.

    ``size`` is the target as a fraction of the risk budget (``1.0`` == the full ``f_max``
    slice). For ``TRIM``/``CLOSE`` it is the fraction to reduce (``CLOSE`` implies the whole
    position regardless). For ``NO_OP``/``HOLD`` it is ``0.0``.
    """

    mint: Mint
    intent: Intent
    size: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description="Fraction of risk budget in [0, f_max]; f_max maps to 1.0.",
    )
    slippage_tolerance_bps: int | None = Field(
        default=None,
        ge=0,
        description="Max acceptable slippage in basis points; None = sim default.",
    )
    decision_time: datetime | None = Field(
        default=None, description="When the decision was made (feeds latency/inclusion delay)."
    )


class Fill(Frozen):
    """The realized outcome of attempting an :class:`Order` against pool state.

    On failure, ``success`` is False, ``failure_reason`` is set, and the ``*_amount`` fields are
    zero (nothing executed). ``slippage_bps`` and ``price_impact_bps`` are the realized numbers
    the sim computed from the AMM curve; ``mev_penalty_quote`` is the modeled adversarial cost
    (back-run/sandwich) charged as a stochastic slippage/failure penalty early (02 §2 (3)).
    """

    mint: Mint
    intent: Intent
    success: bool
    failure_reason: FillFailureReason | None = None

    executed_price: NonNegDecimal | None = Field(
        default=None, ge=0, description="Realized average execution price (quote per base)."
    )
    base_amount: NonNegDecimal = Field(default=Decimal(0), ge=0, description="Token filled.")
    quote_amount: NonNegDecimal = Field(default=Decimal(0), ge=0, description="Quote/SOL spent.")

    fee_quote: NonNegDecimal = Field(default=Decimal(0), ge=0, description="Fees + priority fee.")
    slippage_bps: float = Field(default=0.0, description="Realized slippage vs pre-trade mid.")
    price_impact_bps: float = Field(default=0.0, description="Own-order impact on the AMM price.")
    mev_penalty_quote: NonNegDecimal = Field(default=Decimal(0), ge=0)
    latency_ms: int = Field(default=0, ge=0, description="Modeled decision→inclusion delay.")


class PositionState(Frozen):
    """The agent's position in a token after a step. Cost basis is realized.

    ``mark_price`` is for reporting/telemetry ONLY. It is deliberately separated from any
    realized figure so no reward path can accidentally credit unrealized/peak PnL (paper §3.5.4).
    """

    mint: Mint
    base_qty: NonNegDecimal = Field(default=Decimal(0), ge=0)
    avg_entry_price: NonNegDecimal | None = Field(default=None, ge=0)
    realized_pnl_quote: Decimal = Field(default=Decimal(0))
    opened_at: datetime | None = None
    mark_price: NonNegDecimal | None = Field(
        default=None, ge=0, description="Reporting only — never a reward input."
    )

    @property
    def is_open(self) -> bool:
        return self.base_qty > 0


class SimStepResult(Frozen):
    """The full outcome of one simulator step: the fill, the new position, and terminality."""

    fill: Fill
    position: PositionState
    realized_pnl_quote: Decimal = Field(
        default=Decimal(0), description="Realized PnL booked on THIS step (0 unless a sell filled)."
    )
    terminal: bool = False
    terminal_reason: TerminalReason | None = None


@runtime_checkable
class Simulator(Protocol):
    """Replay-simulator interface. Implemented in ``sim/`` (Wave-1).

    The hot loop lives behind this Protocol on purpose: the Python implementation is the
    correctness reference, and a later Rust kernel (via PyO3/maturin) can be swapped in behind
    the same ``step`` signature only where profiling proves it necessary (see src/README.md).
    """

    def step(self, order: Order, as_of: datetime) -> SimStepResult:
        """Fill ``order`` against reconstructed pool state as-of ``as_of``."""
        ...

    def reset(self, mint: Mint) -> None:
        """Reset per-token episode state (position, absorbing flags)."""
        ...
