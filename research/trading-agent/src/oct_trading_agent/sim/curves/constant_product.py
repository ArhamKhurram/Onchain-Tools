"""``ConstantProductCurve`` — the existing ``x·y=k`` math, now behind the :class:`Curve` interface.

This is a thin, behaviour-preserving adapter: it delegates to the closed-form
:func:`~oct_trading_agent.sim.amm.curve.fill_buy` / :func:`~oct_trading_agent.sim.amm.curve.fill_sell`
that ``sim/amm`` already ships and that ``tests/test_amm_curve.py`` pins analytically. Moving the
math *behind* the abstraction (rather than reimplementing it) is deliberate — the constant-product
fill is the correctness core of the simulator, so its results must not move by a single ulp. The
calibration harness and replay simulator keep calling those functions directly; this class simply
exposes the same law through the venue-dispatch seam.

Registered for the plain constant-product venues (Raydium v4 / CPMM and other ``x·y=k`` AMMs). The
fee is Uniswap-V2-style (taken on the input, retained in the pool). pump.fun's *AMM* is also
constant-product but carries a distinct fee stack (LP + protocol + creator, protocol/creator paid
*out* of the pool), so it gets its own :mod:`~oct_trading_agent.sim.curves.pumpfun` curve rather
than this one.
"""

from __future__ import annotations

from decimal import Decimal
from typing import ClassVar

from oct_trading_agent.core import Side
from oct_trading_agent.sim.amm.curve import CurveFill, fill_buy, fill_sell
from oct_trading_agent.sim.amm.fees import DEFAULT_FEE_BPS, PoolConfig
from oct_trading_agent.sim.amm.pool import PoolState

from .base import Curve, CurveInput
from .registry import register_curve

__all__ = ["ConstantProductCurve"]

_BPS = Decimal(10_000)


@register_curve(
    "raydium_amm_v4",
    "raydium_cpmm",
    "raydium",
    "cpmm",
    "meteora_amm",
    "meteora_daam",
)
class ConstantProductCurve(Curve):
    """Closed-form ``x·y=k`` fills with a single Uniswap-V2-style LP fee.

    ``fee_bps`` is the whole swap fee (default: the repo's Raydium-style 25 bps assumption). It is
    taken on the input and retained in the pool, so ``k`` grows — identical semantics to
    ``sim.amm.curve``. Construct with the fee the calibration fit for the pool's venue; the default
    exists only so the class is zero-arg-constructible for registry auto-registration.
    """

    venues: ClassVar[tuple[str, ...]] = (
        "raydium_amm_v4",
        "raydium_cpmm",
        "raydium",
        "cpmm",
        "meteora_amm",
        "meteora_daam",
    )

    def __init__(self, *, fee_bps: int = DEFAULT_FEE_BPS) -> None:
        # Reuse PoolConfig's validation (0 <= fee_bps < 10000) and fraction conversion.
        self._config = PoolConfig(fee_bps=fee_bps)

    @property
    def fee_bps(self) -> int:
        return self._config.fee_bps

    @property
    def fee_fraction(self) -> Decimal:
        return self._config.fee_fraction

    def fill(self, request: CurveInput, state: PoolState) -> CurveFill:
        if request.side is Side.BUY:
            return fill_buy(
                request.amount_in, state.base_reserve, state.quote_reserve, self.fee_fraction
            )
        return fill_sell(
            request.amount_in, state.base_reserve, state.quote_reserve, self.fee_fraction
        )
