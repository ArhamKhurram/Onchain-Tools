"""The ``Curve`` abstraction — one fill law behind a single interface (Wave-2 §Step 0).

The simulator was born speaking exactly one dialect of AMM: closed-form constant-product
(``sim/amm/curve.py``). Real Solana new-pair flow is not monolingual — the tape mixes
constant-product (``pumpfun_amm``, ``raydium_amm_v4``, generic CPMM), pump.fun's pre-migration
**bonding curve**, and **concentrated-liquidity** DLMM/whirlpool/CLMM. Each obeys a *different*
fill law, so a single hardcoded ``x·y=k`` silently mis-prices ~35% of swaps.

This module is the seam that lets each venue bring its own law without the simulator caring which:

* :class:`Curve` — the ABC every fill model implements: pre-trade pool state + a resolved
  :class:`CurveInput` (side + absolute amount-in) → a :class:`~oct_trading_agent.sim.amm.curve.CurveFill`
  (the SAME result shape the constant-product core already returns, so nothing downstream re-learns it).
* :class:`CurveInput` — the venue-agnostic fill request: a side and the absolute input amount
  (quote/SOL for a BUY, base/token for a SELL). Deliberately *not* the core ``Order`` (which is an
  intent + a fraction of the risk budget): sizing against the budget is the simulator's job; by the
  time a curve is asked to fill, the amount is already absolute.
* :class:`VenueResolution` / :class:`UnsupportedVenueError` — an **explicit, typed** "this venue has
  no fill model" outcome. An unknown venue must never silently fall back to constant-product (that is
  exactly the mis-pricing this abstraction exists to end); the resolver says so, loudly.

Extension contract (how Wave-2's bonding-curve and CLMM agents plug in) lives in
``registry.py`` — a new venue is a new module that registers a :class:`Curve`, with **no edit to any
existing curve file**.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from decimal import Decimal
from typing import ClassVar

from oct_trading_agent.core import Side
from oct_trading_agent.sim.amm.curve import CurveFill
from oct_trading_agent.sim.amm.pool import PoolState

__all__ = [
    "CurveInput",
    "Curve",
    "VenueResolution",
    "UnsupportedVenueError",
]


@dataclass(frozen=True)
class CurveInput:
    """A resolved, absolute fill request against a curve — venue-agnostic.

    ``amount_in`` is the input leg in UI units: **quote (SOL) for a BUY**, **base (token) for a
    SELL** — mirroring the ``core.tape.SwapEvent`` convention (BUY = SOL in, SELL = SOL out). This
    is the point where an intent has already been turned into an absolute size against the risk
    budget, so a curve never sees the ``Order``/``f_max`` machinery.
    """

    side: Side
    amount_in: Decimal


class Curve(ABC):
    """One venue's fill law: pre-trade pool state + a :class:`CurveInput` → a ``CurveFill``.

    Implementations are stateless value objects configured at construction (e.g. with a fee
    schedule) and safe to share. The contract every implementation upholds:

    * The result is a :class:`~oct_trading_agent.sim.amm.curve.CurveFill` — the same shape the
      constant-product core returns, so the simulator, calibration harness, and execution model
      read one type regardless of venue.
    * ``slippage_bps`` / ``price_impact_bps`` are **non-negative costs** (adverse move of the average
      fill vs the pre-trade mid, and the magnitude of the mid move the order caused).
    * A non-tradeable input (non-positive amount, empty/insufficient pool depth for the venue's law)
      raises ``ValueError`` — the *caller* decides whether that is an ``INSUFFICIENT_LIQUIDITY``
      fill, exactly as the simulator already does for the constant-product path.

    The pre-trade state is passed as :class:`~oct_trading_agent.sim.amm.pool.PoolState` — the
    reserve reconstruction the tape already yields. A venue whose law needs richer state than
    ``(base_reserve, quote_reserve)`` (a CLMM needs active liquidity + tick) reads what the reserve
    pair implies and/or carries the extra state on the concrete subclass; the reserve pair remains
    the shared, reconstructable contract every venue can at minimum consume.
    """

    #: Canonical Pinax ``protocol`` id(s) this curve models. Documentation-only — the authoritative
    #: venue→curve wiring is the registry; this makes a curve self-describing at a glance.
    venues: ClassVar[tuple[str, ...]] = ()

    @abstractmethod
    def fill(self, request: CurveInput, state: PoolState) -> CurveFill:
        """Fill ``request`` against pre-trade ``state``. Raises ``ValueError`` if untradeable."""
        ...

    # -- convenience wrappers (parallel to sim.amm.curve.fill_buy / fill_sell) -----------------

    def fill_buy(self, quote_in: Decimal, state: PoolState) -> CurveFill:
        """Buy base by spending ``quote_in`` quote (SOL) against ``state``."""
        return self.fill(CurveInput(side=Side.BUY, amount_in=quote_in), state)

    def fill_sell(self, base_in: Decimal, state: PoolState) -> CurveFill:
        """Sell ``base_in`` base (token) for quote (SOL) against ``state``."""
        return self.fill(CurveInput(side=Side.SELL, amount_in=base_in), state)


class UnsupportedVenueError(LookupError):
    """Raised by the resolver when a venue has no registered :class:`Curve`.

    Carries the offending ``protocol`` and a human ``reason`` (e.g. "concentrated-liquidity venue —
    register a ConcentratedLiquidityCurve"). It is a hard, typed failure on purpose: silently
    pricing an unknown venue on the constant-product law is the precise bug this package prevents.
    """

    def __init__(self, protocol: str | None, reason: str | None = None) -> None:
        self.protocol = protocol
        self.reason = reason
        shown = repr(protocol) if protocol else "<missing protocol>"
        suffix = f" — {reason}" if reason else ""
        super().__init__(f"no Curve registered for venue {shown}{suffix}")


@dataclass(frozen=True)
class VenueResolution:
    """Result of a non-raising venue lookup: either a ``curve`` or a typed ``reason`` it is absent.

    ``supported`` is the branch discriminator. When ``curve is None`` the ``reason`` explains what a
    later agent must register (bonding curve, CLMM, …) or why the venue is out of scope (a router
    that must be resolved per-hop), so an unsupported venue is actionable, never a silent gap.
    """

    protocol: str | None
    curve: Curve | None = None
    reason: str | None = None

    @property
    def supported(self) -> bool:
        return self.curve is not None

    def unwrap(self) -> Curve:
        """Return the curve, or raise :class:`UnsupportedVenueError` if the venue is unsupported."""
        if self.curve is None:
            raise UnsupportedVenueError(self.protocol, self.reason)
        return self.curve
