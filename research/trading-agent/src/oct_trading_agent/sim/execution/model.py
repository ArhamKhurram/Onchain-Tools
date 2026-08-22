"""Execution realism — wrap a pure curve fill with latency, MEV, failed txns, and fees.

This turns the analytic :class:`~oct_trading_agent.sim.amm.curve.CurveFill` into a realized
:class:`~oct_trading_agent.core.sim.Fill`, layering the frictions the pure curve omits (02 §2 (3)):

* **Latency / inclusion delay** — a modeled decision→inclusion delay (``latency_ms``). Early model:
  reported but does not re-price; a later model re-reads pool state at the inclusion slot.
* **MEV** — back-run/sandwich as a *stochastic* slippage/failure penalty early (explicit model
  later): with probability ``mev_prob`` a sandwich either charges ``mev_penalty_quote`` on top or
  (with ``mev_fail_prob``) makes the fill non-viable (``MEV_SANDWICH``).
* **Failed txns + priority fees** — with probability ``tx_fail_prob`` the tx drops (``TX_FAILED``);
  either way the network gas (base + priority fee) is burned and reported in ``fee_quote``.
* **Slippage tolerance** — realized ``slippage_bps`` past the order's tolerance fails the order
  (``SLIPPAGE_EXCEEDED``); gas is still burned.

All randomness comes from an injected ``numpy`` ``Generator`` so runs are reproducible. The default
``ExecutionParams`` are conservative; :meth:`ExecutionParams.ideal` zeroes every friction, which is
what the calibration harness uses to isolate the pure AMM+fee reproduction (03 §Phase 0).

NOTE on fee accounting: ``fee_quote`` is **network gas only** (base + priority fee). The LP/swap fee
is embedded in the curve's executed price / ``quote_amount`` and must NOT be added here — doing so
would double-count it against the ledger (see ``curve.py``).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

import numpy as np

from oct_trading_agent.core import Fill, FillFailureReason, Order
from oct_trading_agent.sim.amm.curve import CurveFill

_BPS = Decimal(10_000)

# Solana base fee: 5000 lamports = 0.000005 SOL. A conservative, venue-agnostic default.
_DEFAULT_BASE_FEE_QUOTE = Decimal("0.000005")


@dataclass(frozen=True)
class ExecutionParams:
    """Knobs for the execution/cost model. Defaults are conservative; ``ideal()`` zeroes them."""

    base_latency_ms: int = 800  # ~2 Solana slots decision→inclusion
    latency_jitter_ms: int = 400
    tx_fail_prob: float = 0.0
    mev_prob: float = 0.0
    mev_fail_prob: float = 0.0  # conditional on a sandwich: chance it voids the fill entirely
    mev_penalty_frac: float = 0.5  # fraction of the slippage cost charged as extra on a sandwich
    priority_fee_quote: Decimal = Decimal(0)
    base_fee_quote: Decimal = _DEFAULT_BASE_FEE_QUOTE
    default_slippage_tolerance_bps: int = 500  # 5%

    @classmethod
    def ideal(cls) -> ExecutionParams:
        """Frictionless execution: no latency, no MEV, no failures, no gas — pure curve fidelity.

        Used by the calibration harness: Phase-0 calibration measures whether the AMM+fee math
        reproduces real fills, not whether the (stochastic) friction model matches any one tx.
        """
        return cls(
            base_latency_ms=0,
            latency_jitter_ms=0,
            tx_fail_prob=0.0,
            mev_prob=0.0,
            mev_fail_prob=0.0,
            mev_penalty_frac=0.0,
            priority_fee_quote=Decimal(0),
            base_fee_quote=Decimal(0),
            default_slippage_tolerance_bps=1_000_000,  # effectively unbounded
        )

    def __post_init__(self) -> None:
        for name in ("tx_fail_prob", "mev_prob", "mev_fail_prob"):
            v = getattr(self, name)
            if not 0.0 <= v <= 1.0:
                raise ValueError(f"{name} must be in [0, 1]: {v}")
        if self.mev_penalty_frac < 0.0:
            raise ValueError("mev_penalty_frac must be non-negative")
        if self.base_latency_ms < 0 or self.latency_jitter_ms < 0:
            raise ValueError("latency must be non-negative")


def _fail(order: Order, reason: FillFailureReason, fee_quote: Decimal, latency_ms: int) -> Fill:
    """Build a failed :class:`Fill` — nothing executes; gas may still be burned."""
    return Fill(
        mint=order.mint,
        intent=order.intent,
        success=False,
        failure_reason=reason,
        executed_price=None,
        base_amount=Decimal(0),
        quote_amount=Decimal(0),
        fee_quote=fee_quote,
        slippage_bps=0.0,
        price_impact_bps=0.0,
        mev_penalty_quote=Decimal(0),
        latency_ms=latency_ms,
    )


class ExecutionModel:
    """Applies latency/MEV/failure/fees to a curve fill, yielding a realized :class:`Fill`."""

    def __init__(self, params: ExecutionParams, rng: np.random.Generator) -> None:
        self.params = params
        self._rng = rng

    def _latency_ms(self) -> int:
        p = self.params
        if p.latency_jitter_ms == 0:
            return p.base_latency_ms
        # Uniform jitter in [-jitter, +jitter], clamped at 0.
        jitter = int(self._rng.integers(-p.latency_jitter_ms, p.latency_jitter_ms + 1))
        return max(0, p.base_latency_ms + jitter)

    def realize(self, curve_fill: CurveFill, order: Order) -> Fill:
        """Produce the realized :class:`Fill` for a successful curve fill under this model."""
        p = self.params
        gas = p.base_fee_quote + p.priority_fee_quote
        latency_ms = self._latency_ms()

        # 1) Inclusion: the tx may drop. Gas is burned either way.
        if p.tx_fail_prob > 0.0 and self._rng.random() < p.tx_fail_prob:
            return _fail(order, FillFailureReason.TX_FAILED, gas, latency_ms)

        # 2) Slippage tolerance: realized slippage past the order's bound voids it.
        tol = order.slippage_tolerance_bps
        if tol is None:
            tol = p.default_slippage_tolerance_bps
        if curve_fill.slippage_bps > Decimal(tol):
            return _fail(order, FillFailureReason.SLIPPAGE_EXCEEDED, gas, latency_ms)

        # 3) MEV: a stochastic sandwich either voids the fill or charges an extra penalty.
        mev_penalty = Decimal(0)
        if p.mev_prob > 0.0 and self._rng.random() < p.mev_prob:
            if p.mev_fail_prob > 0.0 and self._rng.random() < p.mev_fail_prob:
                return _fail(order, FillFailureReason.MEV_SANDWICH, gas, latency_ms)
            # Extra cost proportional to the slippage the order already ate.
            slippage_cost = curve_fill.quote_amount * curve_fill.slippage_bps / _BPS
            mev_penalty = slippage_cost * Decimal(str(p.mev_penalty_frac))

        return Fill(
            mint=order.mint,
            intent=order.intent,
            success=True,
            failure_reason=None,
            executed_price=curve_fill.executed_price,
            base_amount=curve_fill.base_amount,
            quote_amount=curve_fill.quote_amount,
            fee_quote=gas,
            slippage_bps=float(curve_fill.slippage_bps),
            price_impact_bps=float(curve_fill.price_impact_bps),
            mev_penalty_quote=mev_penalty,
            latency_ms=latency_ms,
        )

    def fail(self, order: Order, reason: FillFailureReason) -> Fill:
        """Emit a failure the caller detected pre-curve (e.g. INSUFFICIENT_LIQUIDITY, RUGGED)."""
        gas = Decimal(0)
        # A pre-curve rejection (thin pool, already-rugged) burns no gas — the tx is never sent.
        return _fail(order, reason, gas, self._latency_ms())
