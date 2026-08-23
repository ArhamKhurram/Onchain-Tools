"""Generic reserve reconstruction — anchor a single-venue swap tape so it fills on ANY venue.

The bonding-curve env (:mod:`oct_trading_agent.agent.envs.bonding`) seeds the pump.fun *virtual*
reserves with one synthetic pool-creation ``add`` and lets :class:`~oct_trading_agent.sim.amm.pool.PoolReconstructor`
fold the swap deltas onto it. That is the honest, causal roll-forward the reconstructor already
supports — but the seed is a **hardcoded pump.fun constant**. A migrated / multi-venue token
(``pumpfun_amm``, ``raydium_*``, a CLMM) has no such published seed, so the bonding seed mis-anchors
it and every fill comes back garbage.

This module generalises that anchor. A decoded swap stream carries **no reserves** (``core.tape``:
``base_reserve_*``/``quote_reserve_*`` are ``None``; ``data/pinax_client/decode`` confirms it), so we
recover the *pre-trade* depth trajectory the same two honest ways ``sim/calibration_independent`` uses:

* **Self-consistency fit (default, offline, network-free).** Fit the single constant-product depth
  ``(base0, quote0)`` at the token's FIRST swap that best reproduces an early window of its own swaps,
  then let :class:`PoolReconstructor` **roll it forward** by folding each subsequent swap's amount
  deltas — recovering pre-trade depth at every instant. This is the forward dual of the calibration
  harness's roll-*back* from an independent anchor, and it reuses the exact same self-consistency
  estimator (:class:`~oct_trading_agent.sim.curves.clmm.RollingLocalLiquidityEstimator`): for a
  constant-product pool the Uniswap-v3 virtual reserves ``(L/√P, L·√P)`` **are** the reserves.

* **Independent-reserve anchor (optional, live).** When a real on-chain reserve snapshot at (or near)
  a known block is available (:class:`~oct_trading_agent.data.pinax_client.reserves.PoolReserves`),
  pass it as an explicit ``anchor`` and skip the fit. For a *recently active* pool this is the
  ground-truth depth; for a *dead* pool the latest balance is dust and unusable (reserves.py finding)
  — there the self-consistency fit is the only honest option, so it stays the default.

The output is a **sim-ready tape**: one synthetic anchoring ``add`` prepended to the causal swap
sequence, exactly the shape :func:`~oct_trading_agent.agent.envs.bonding.prepare_bonding_curve_tape`
produces — so the existing simulator, feature store and env consume it unchanged. We invent **no**
per-swap reserves and never perturb the historical flow; we supply one anchoring fact and let the
reconstructor's causal fold do the rest.

CLMM note: for a concentrated-liquidity venue the absolute vault reserves are not the swap depth, but
the venue curve (:class:`~oct_trading_agent.sim.curves.clmm.ConcentratedLiquidityCurve`) reads only the
reserve *ratio* (the mid price) and prices depth off its own effective ``L``. The virtual-reserve
anchor gives the right ratio at the anchor and the fold approximates the price path; the curve's own
``in_range`` / ``confidence`` flags carry the honesty about where that approximation holds.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal

from oct_trading_agent.core import LiquidityEvent, Mint, Side, SwapEvent, TapeEvent
from oct_trading_agent.sim.curves.clmm import (
    LocalSwapObservation,
    RollingLocalLiquidityEstimator,
)

__all__ = [
    "ReserveAnchor",
    "fit_reserve_anchor",
    "anchor_seed_liquidity",
    "prepare_market_tape",
    "DEFAULT_ANCHOR_FEE_BPS",
    "DEFAULT_FIT_WINDOW",
]

#: A neutral representative fee for the anchor DEPTH fit when a venue-specific tier is unknown. The
#: fit only needs depth to the right order of magnitude and the right price; the actual fill then uses
#: the venue's correct :class:`~oct_trading_agent.sim.curves.base.Curve`. 30 bps = the pump.fun-AMM /
#: common-CLMM mature tier.
DEFAULT_ANCHOR_FEE_BPS = 30

#: How many of a token's earliest swaps feed the self-consistency depth fit. Wide enough to identify
#: depth, short enough to stay within one liquidity regime near launch.
DEFAULT_FIT_WINDOW = 48


def _sqrt(x: Decimal) -> Decimal:
    return x.sqrt()


def _virtual_reserves(liquidity: Decimal, price: Decimal) -> tuple[Decimal, Decimal]:
    """Constant-product reserves for depth ``L`` at mid price ``P``: ``(L/√P, L·√P)`` (v3 identity)."""
    root = _sqrt(price)
    return liquidity / root, liquidity * root


@dataclass(frozen=True)
class ReserveAnchor:
    """The absolute pre-trade depth an env's :class:`PoolReconstructor` rolls forward from.

    ``base_reserve`` / ``quote_reserve`` are UI-unit ``Decimal`` reserves at ``slot`` (the token's
    first swap by default). ``source`` records HOW it was obtained so a run manifest can flag
    low-confidence anchors; ``fit_median_rel_error`` / ``reliable`` carry the self-consistency fit's
    quality (both ``None`` for an independent-reserve anchor).
    """

    base_reserve: Decimal
    quote_reserve: Decimal
    slot: int
    source: str
    fit_median_rel_error: float | None = None
    reliable: bool = True

    @property
    def mid_price(self) -> Decimal:
        return self.quote_reserve / self.base_reserve


def fit_reserve_anchor(
    swaps: list[SwapEvent],
    *,
    fee_bps: int = DEFAULT_ANCHOR_FEE_BPS,
    fit_window: int = DEFAULT_FIT_WINDOW,
) -> ReserveAnchor:
    """Fit the constant-product depth ``(base0, quote0)`` at the token's first swap by self-consistency.

    Reuses :class:`RollingLocalLiquidityEstimator` — the same estimator the CLMM curve uses — over the
    earliest ``fit_window`` swaps: it returns the single ``(L, P0)`` that best reproduces those swaps'
    observed outputs under the virtual-reserve fill law. For a constant-product pool those virtual
    reserves ARE the reserves, so ``(L/√P0, L·√P0)`` is the depth anchor. Raises ``ValueError`` if
    there are too few usable swaps to identify depth (the caller then skips/flags the token).
    """
    ordered = sorted(swaps, key=lambda s: (s.slot, s.block_time))
    if len(ordered) < 4:
        raise ValueError("need >= 4 swaps to fit a reserve anchor by self-consistency")

    window = ordered[:fit_window]
    observations = [
        LocalSwapObservation(side=s.side, amount_in=_amount_in(s), observed_out=_observed_out(s))
        for s in window
    ]
    estimator = RollingLocalLiquidityEstimator(window=max(4, fit_window), fee_bps=fee_bps)
    estimate = estimator.estimate(observations)
    base0, quote0 = _virtual_reserves(estimate.effective_liquidity, estimate.reference_price)
    if base0 <= 0 or quote0 <= 0:
        raise ValueError("self-consistency fit produced a non-positive reserve anchor")
    return ReserveAnchor(
        base_reserve=base0,
        quote_reserve=quote0,
        slot=ordered[0].slot,
        source="self_consistency_fit",
        fit_median_rel_error=float(estimate.median_rel_error),
        reliable=estimate.median_rel_error <= Decimal("0.02"),
    )


def _amount_in(swap: SwapEvent) -> Decimal:
    """The input leg in UI units: quote (SOL) for a BUY, base (token) for a SELL."""
    return swap.quote_amount if swap.side is Side.BUY else swap.base_amount


def _observed_out(swap: SwapEvent) -> Decimal:
    """The output leg in UI units: base (token) for a BUY, quote (SOL) for a SELL."""
    return swap.base_amount if swap.side is Side.BUY else swap.quote_amount


def anchor_seed_liquidity(mint: Mint, first_swap: SwapEvent, anchor: ReserveAnchor) -> LiquidityEvent:
    """A synthetic pool-creation ``add`` carrying ``anchor``'s reserves, placed one slot before the
    first swap so it is the causal anchor the reconstructor folds subsequent swaps onto."""
    return LiquidityEvent(
        mint=mint,
        slot=max(0, first_swap.slot - 1),
        block_time=first_swap.block_time - timedelta(seconds=1),
        signature=f"anchor-seed-{mint}",
        action="add",
        base_amount=anchor.base_reserve,
        quote_amount=anchor.quote_reserve,
    )


def prepare_market_tape(
    swaps: list[SwapEvent],
    *,
    anchor: ReserveAnchor | None = None,
    fee_bps: int = DEFAULT_ANCHOR_FEE_BPS,
    fit_window: int = DEFAULT_FIT_WINDOW,
) -> tuple[list[TapeEvent], ReserveAnchor]:
    """Return ``(sim_ready_tape, anchor)`` for one token's causal swap sequence (one mint, one pool).

    The tape is the anchoring ``add`` prepended to the ordered swaps — exactly the shape
    :func:`~oct_trading_agent.agent.envs.bonding.prepare_bonding_curve_tape` yields, so the simulator,
    feature store and env consume it unchanged. ``anchor`` (independent reserves) is used when given;
    otherwise it is fit by self-consistency (:func:`fit_reserve_anchor`). Raises ``ValueError`` on an
    empty tape or a multi-mint input (the caller groups by pool/mint first).
    """
    if not swaps:
        raise ValueError("prepare_market_tape needs at least one swap")
    mints = {s.mint for s in swaps}
    if len(mints) != 1:
        raise ValueError(f"prepare_market_tape expects one mint, got {len(mints)}")

    ordered = sorted(swaps, key=lambda s: (s.slot, s.block_time))
    resolved_anchor = anchor or fit_reserve_anchor(ordered, fee_bps=fee_bps, fit_window=fit_window)
    seed = anchor_seed_liquidity(ordered[0].mint, ordered[0], resolved_anchor)
    tape: list[TapeEvent] = [seed]
    tape.extend(ordered)
    return tape, resolved_anchor
