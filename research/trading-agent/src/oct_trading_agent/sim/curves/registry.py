"""Venue→curve registry + resolver — the dispatch that keeps venues pluggable (Wave-2 §Step 0).

The whole point of the abstraction is that adding a venue must not touch existing curve code. This
module is that guarantee:

* :class:`CurveRegistry` maps a Pinax ``protocol`` string to a zero-arg **factory** that builds a
  default-configured :class:`~oct_trading_agent.sim.curves.base.Curve`. Registration is a table, not
  a hardcoded ``if/elif`` — so a new venue is a new *entry*, never an edit to a resolver body.
* :func:`register_curve` is the decorator built-in curves use to self-register on import. A later
  agent adds ``clmm.py`` / ``bonding_curve.py``, decorates the class, and adds one import line to
  ``curves/__init__.py`` (importing the module runs the decorator). **No existing curve file is
  edited** — the extension seam is import-time registration.
* Resolution is explicit about failure. A venue with no factory resolves to a typed
  :class:`~oct_trading_agent.sim.curves.base.VenueResolution` (non-raising) or raises
  :class:`~oct_trading_agent.sim.curves.base.UnsupportedVenueError` (raising) — **never** a silent
  constant-product fallback. Known-but-unimplemented venues carry a helpful reason naming the model
  a later agent should register.

The module keeps a process-wide :data:`DEFAULT_REGISTRY`; the built-in curves register into it. A
test or an experiment can construct its own :class:`CurveRegistry` for isolation.
"""

from __future__ import annotations

from collections.abc import Callable

from oct_trading_agent.core import SwapEvent

from .base import Curve, VenueResolution

__all__ = [
    "CurveFactory",
    "CurveRegistry",
    "DEFAULT_REGISTRY",
    "register_curve",
    "KNOWN_UNSUPPORTED",
]

#: A zero-arg builder for a default-configured curve. Kept as a factory (not a shared instance) so a
#: registry hands back an independent object and a curve is free to become stateful later.
CurveFactory = Callable[[], Curve]

# Venues we can NAME but do not (yet) model, mapped to the fill model a later agent should register.
# Resolving one of these yields a typed "unsupported" with this reason — actionable, not a silent
# gap. Kept out of the registry proper: these are documentation for the resolver's failure path.
KNOWN_UNSUPPORTED: dict[str, str] = {
    "pumpfun": "pump.fun pre-migration bonding curve — register a BondingCurve",
    "raydium_clmm": "concentrated-liquidity (CLMM) — register a ConcentratedLiquidityCurve",
    "orca_whirlpool": "concentrated-liquidity (Whirlpool) — register a ConcentratedLiquidityCurve",
    "meteora_dlmm": "concentrated-liquidity (DLMM bins) — register a ConcentratedLiquidityCurve",
    "jupiter_v6": "router/aggregator — resolve the underlying venue per hop, do not price directly",
}


class CurveRegistry:
    """A mutable ``protocol -> curve factory`` table with explicit, typed resolution.

    Not thread-safe for concurrent *registration* (registration happens at import time, single
    threaded); resolution is read-only and safe to share.
    """

    def __init__(self) -> None:
        self._factories: dict[str, CurveFactory] = {}

    # -- registration -------------------------------------------------------------------------

    def register(self, *protocols: str, factory: CurveFactory, replace: bool = False) -> None:
        """Register ``factory`` for one or more ``protocols``.

        Raises ``ValueError`` on a duplicate unless ``replace=True`` — a silent re-registration
        would let two curves fight over a venue, which is exactly the kind of ambiguity this table
        exists to prevent.
        """
        if not protocols:
            raise ValueError("register() needs at least one protocol name")
        for protocol in protocols:
            key = protocol.strip()
            if not key:
                raise ValueError("protocol name must be a non-empty string")
            if key in self._factories and not replace:
                raise ValueError(
                    f"venue {key!r} already has a registered Curve; "
                    "pass replace=True to override deliberately"
                )
            self._factories[key] = factory

    # -- resolution ---------------------------------------------------------------------------

    def is_supported(self, protocol: str | None) -> bool:
        return protocol is not None and protocol in self._factories

    def supported_venues(self) -> frozenset[str]:
        """Every venue that currently resolves to a curve."""
        return frozenset(self._factories)

    def try_resolve(self, protocol: str | None) -> VenueResolution:
        """Resolve ``protocol`` without raising.

        Returns a :class:`VenueResolution` whose ``supported`` flag branches the caller. An
        unknown venue carries a ``reason`` (from :data:`KNOWN_UNSUPPORTED` when we recognise the
        family, else a generic message) — never a constant-product fallback.
        """
        if protocol is None:
            return VenueResolution(protocol=None, reason="swap carries no venue (protocol is None)")
        factory = self._factories.get(protocol)
        if factory is not None:
            return VenueResolution(protocol=protocol, curve=factory())
        reason = KNOWN_UNSUPPORTED.get(protocol, "no fill model registered for this venue")
        return VenueResolution(protocol=protocol, reason=reason)

    def resolve(self, protocol: str | None) -> Curve:
        """Resolve ``protocol`` to a curve, or raise :class:`UnsupportedVenueError`."""
        return self.try_resolve(protocol).unwrap()

    def try_resolve_for_swap(self, swap: SwapEvent) -> VenueResolution:
        """Resolve the venue a :class:`SwapEvent` executed on (its ``protocol`` tag)."""
        return self.try_resolve(swap.protocol)

    def resolve_for_swap(self, swap: SwapEvent) -> Curve:
        """Resolve a swap's venue to a curve, or raise :class:`UnsupportedVenueError`."""
        return self.resolve(swap.protocol)


#: Process-wide registry the built-in curves register into (see ``curves/__init__.py``).
DEFAULT_REGISTRY = CurveRegistry()


def register_curve(
    *protocols: str,
    registry: CurveRegistry = DEFAULT_REGISTRY,
    factory: CurveFactory | None = None,
    replace: bool = False,
) -> Callable[[type[Curve]], type[Curve]]:
    """Class decorator: register the decorated :class:`Curve` for ``protocols`` on import.

    By default the decorated class is its own factory (constructed with its defaults), so a curve
    only needs a zero-arg-constructible default configuration to self-register::

        @register_curve("raydium_amm_v4", "raydium_cpmm")
        class ConstantProductCurve(Curve):
            def __init__(self, *, fee_bps: int = 25) -> None: ...

    Pass an explicit ``factory`` when a venue needs non-default construction. This is the seam a
    later agent uses: a new curve module decorates its class and is imported by
    ``curves/__init__.py`` — no existing curve file changes.
    """

    def decorate(cls: type[Curve]) -> type[Curve]:
        registry.register(*protocols, factory=factory or cls, replace=replace)
        return cls

    return decorate
