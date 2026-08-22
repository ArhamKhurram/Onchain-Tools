"""sim/curves — multi-venue fill-curve abstraction (Wave-2 §Step 0).

The simulator no longer assumes one AMM law. A :class:`Curve` maps pre-trade pool state + a resolved
:class:`CurveInput` to a ``CurveFill``; a :class:`CurveRegistry` dispatches a swap's ``protocol`` tag
to the right curve. Built-ins ship here; the pump.fun bonding curve and the concentrated-liquidity
(CLMM/DLMM/Whirlpool) curves are the next two Wave-2 agents' work and drop in by *registering*.

Public surface:
    * ``Curve`` / ``CurveInput`` — the fill interface and its venue-agnostic request.
    * ``CurveFill`` — the fill result shape (re-exported from ``sim.amm.curve``; unchanged).
    * ``ConstantProductCurve`` — the existing ``x·y=k`` math behind the interface (Raydium/CPMM).
    * ``PumpFunAmmCurve`` / ``FeeSplit`` / ``PumpFunAmmFeeSchedule`` — pump.fun AMM + its real fee stack.
    * ``ConcentratedLiquidityCurve`` / ``CLMMFill`` / ``RollingLocalLiquidityEstimator`` — the
      effective-local-liquidity CLMM/DLMM/Whirlpool approximation + its rolling ``L`` estimator.
    * ``CurveRegistry`` / ``DEFAULT_REGISTRY`` / ``register_curve`` — venue→curve dispatch.
    * ``VenueResolution`` / ``UnsupportedVenueError`` — the explicit "no model for this venue" result.
    * ``resolve_curve`` / ``try_resolve_curve`` — module-level shortcuts over ``DEFAULT_REGISTRY``.

Adding a venue (the extension contract): create a new module with a ``Curve`` subclass decorated
``@register_curve("<protocol>")`` (see ``constant_product.py`` / ``pumpfun.py``), then add one import
line to the ``# built-in curves`` block below so importing this package runs the registration. **No
existing curve file is edited** — new venues are new modules plus one import line.
"""

from __future__ import annotations

from oct_trading_agent.core import SwapEvent
from oct_trading_agent.sim.amm.curve import CurveFill

from .base import (
    Curve,
    CurveInput,
    UnsupportedVenueError,
    VenueResolution,
)

# --- built-in curves: importing each module runs its @register_curve on DEFAULT_REGISTRY ---------
from .clmm import (
    CLMM_VENUES,
    CLMMFill,
    ConcentratedLiquidityCurve,
    LocalLiquidityEstimate,
    LocalSwapObservation,
    RollingLocalLiquidityEstimator,
)
from .constant_product import ConstantProductCurve
from .pumpfun import (
    PUMPFUN_AMM_STANDARD_FEE,
    PUMPFUN_BONDING_CURVE_FEE_BPS,
    FeeSplit,
    PumpFunAmmCurve,
    PumpFunAmmFeeSchedule,
)
from .registry import (
    DEFAULT_REGISTRY,
    KNOWN_UNSUPPORTED,
    CurveFactory,
    CurveRegistry,
    register_curve,
)


def resolve_curve(protocol: str | None) -> Curve:
    """Resolve a venue ``protocol`` to a curve via ``DEFAULT_REGISTRY`` (raises if unsupported)."""
    return DEFAULT_REGISTRY.resolve(protocol)


def try_resolve_curve(protocol: str | None) -> VenueResolution:
    """Non-raising venue resolution via ``DEFAULT_REGISTRY`` (typed unsupported result)."""
    return DEFAULT_REGISTRY.try_resolve(protocol)


def resolve_curve_for_swap(swap: SwapEvent) -> Curve:
    """Resolve the curve for a swap's venue via ``DEFAULT_REGISTRY`` (raises if unsupported)."""
    return DEFAULT_REGISTRY.resolve_for_swap(swap)


__all__ = [
    # interface
    "Curve",
    "CurveInput",
    "CurveFill",
    # built-in curves
    "ConstantProductCurve",
    "PumpFunAmmCurve",
    "FeeSplit",
    "PumpFunAmmFeeSchedule",
    "PUMPFUN_AMM_STANDARD_FEE",
    "PUMPFUN_BONDING_CURVE_FEE_BPS",
    "ConcentratedLiquidityCurve",
    "CLMMFill",
    "CLMM_VENUES",
    "LocalSwapObservation",
    "LocalLiquidityEstimate",
    "RollingLocalLiquidityEstimator",
    # registry / resolution
    "CurveRegistry",
    "CurveFactory",
    "DEFAULT_REGISTRY",
    "register_curve",
    "KNOWN_UNSUPPORTED",
    "VenueResolution",
    "UnsupportedVenueError",
    "resolve_curve",
    "try_resolve_curve",
    "resolve_curve_for_swap",
]
