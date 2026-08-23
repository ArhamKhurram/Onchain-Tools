"""``MarketReplayEnv`` — the FULL-CHART, MULTI-VENUE trading environment (task: generic replay).

The bonding-curve :class:`~oct_trading_agent.agent.envs.TradingEnv` is pinned to ONE regime: it seeds
the pump.fun virtual reserves (:func:`~oct_trading_agent.agent.envs.bonding.prepare_bonding_curve_tape`)
and fills every order with the flat constant-product law. Run it on a MIGRATED / multi-venue token
(``pumpfun_amm``, ``raydium_*``, a CLMM) and the pump.fun seed mis-anchors the pool and the flat-fee
CP law mis-prices every fill — a long-only agent can show impossible numbers (−2000×).

``MarketReplayEnv`` fixes exactly that, and NOTHING else. It **is** a :class:`TradingEnv` — the same
``reset``/``step`` contract, the same §3.3 action, the same tier-A masked observation, the same §3.5
realized-risk-adjusted reward (mark price never reaches it). Only the FILL/sim path changes:

1. **Reserve reconstruction** — the token's real swap tape carries no reserves, so its pre-trade depth
   is reconstructed by :func:`~oct_trading_agent.sim.replay.reconstruct.prepare_market_tape`: fit one
   anchor by self-consistency (or take an independent-reserve anchor) and let the base
   :class:`PoolReconstructor` roll it forward. For a ``pumpfun`` bonding-curve token the anchor is the
   KNOWN pump.fun virtual seed instead (its curve prices off those exact constants, not a fit).
2. **Venue-appropriate curve** — the token's venue (Pinax ``protocol``) is resolved to its
   :class:`~oct_trading_agent.sim.curves.base.Curve` through the registry (``pumpfun_amm`` → the
   validated CP+fee-stack curve; a CLMM venue → the effective-liquidity curve with ``L`` fit from the
   token's own swaps; ``pumpfun`` → the closed-form bonding curve), and
   :class:`~oct_trading_agent.sim.replay.generic_simulator.MarketReplaySimulator` fills through it.
3. **Unsupported venues are FLAGGED, not faked** — a ``jupiter_v6`` router swap has no single curve
   (it must be resolved per hop), and any venue with no registered curve resolves to a typed
   "unsupported" :class:`MarketRegime` with a reason. The caller skips such a token and records why;
   the env never fabricates a fill for it.

The episode is the token's **whole life** — one contiguous episode over all its swaps — not a
walk-forward slice (the walk-forward split happens ABOVE the env, in the training entrypoint).
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from oct_trading_agent.core import FeatureStore, Mint, SwapEvent, TapeEvent
from oct_trading_agent.sim.amm.fees import PoolConfig
from oct_trading_agent.sim.curves import (
    ConcentratedLiquidityCurve,
    Curve,
    PumpFunAmmCurve,
    PumpFunBondingCurve,
    try_resolve_curve,
)
from oct_trading_agent.sim.curves.clmm import LocalSwapObservation
from oct_trading_agent.sim.execution.model import ExecutionParams
from oct_trading_agent.sim.replay.generic_simulator import MarketReplaySimulator
from oct_trading_agent.sim.replay.reconstruct import (
    DEFAULT_ANCHOR_FEE_BPS,
    ReserveAnchor,
    prepare_market_tape,
)
from oct_trading_agent.sim.replay.simulator import ReplaySimulator, SimConfig

from .bonding import bonding_curve_seed_liquidity
from .env import EnvConfig, TradingEnv

__all__ = [
    "MarketRegime",
    "MarketReplayEnv",
    "build_market_regime",
    "market_sim_config",
    "PUMPFUN_TOTAL_SUPPLY_UI",
]

#: pump.fun tokens have a fixed 1e9 total supply; market cap (SOL) = mid(SOL/token) * supply — used to
#: resolve the pump.fun-AMM fee tier per token (mirrors ``sim/calibration_independent``).
PUMPFUN_TOTAL_SUPPLY_UI = Decimal(1_000_000_000)

# Representative fees the anchor DEPTH fit uses per venue family (the real FILL uses the venue curve).
_VENUE_FIT_FEE_BPS: dict[str, int] = {
    "pumpfun_amm": 30,
    "raydium_amm_v4": 25,
    "raydium_cpmm": 25,
    "meteora_daam": 25,
    "orca_whirlpool": 30,
    "raydium_clmm": 30,
    "meteora_dlmm": 30,
}


@dataclass(frozen=True)
class MarketRegime:
    """The resolved fill regime for one token: its venue, curve, anchor, and tradeability.

    ``tradeable`` is the branch discriminator. When ``False``, ``reason`` says why (unsupported venue
    like ``jupiter_v6``, too few swaps to fit an anchor, …) and ``curve``/``sim_tape`` are ``None`` —
    the caller skips the token and records the reason, never fabricating a fill.
    """

    mint: Mint
    protocol: str | None
    tradeable: bool
    curve: Curve | None = None
    anchor: ReserveAnchor | None = None
    sim_tape: list[TapeEvent] | None = None
    decision_times: list[datetime] | None = None
    reason: str | None = None


def _dominant_protocol(swaps: list[SwapEvent]) -> str | None:
    """The most common ``protocol`` across the token's swaps (its venue for the pull)."""
    counts = Counter(s.protocol for s in swaps if s.protocol is not None)
    if not counts:
        return None
    return counts.most_common(1)[0][0]


def _observations(swaps: list[SwapEvent]) -> list[LocalSwapObservation]:
    from oct_trading_agent.core import Side

    return [
        LocalSwapObservation(
            side=s.side,
            amount_in=s.quote_amount if s.side is Side.BUY else s.base_amount,
            observed_out=s.base_amount if s.side is Side.BUY else s.quote_amount,
        )
        for s in swaps
    ]


def _specialise_curve(
    template: Curve, protocol: str, swaps: list[SwapEvent], anchor: ReserveAnchor
) -> Curve:
    """Turn a registry curve TEMPLATE into a token-specific curve.

    * ``PumpFunAmmCurve`` — rebuild at the market-cap fee tier implied by the anchor mid.
    * ``ConcentratedLiquidityCurve`` — fit the effective liquidity ``L`` from the token's own swaps
      (the registry hands back an ``L``-less template that cannot price a fill until specialised).
    * anything else (constant-product, bonding curve) — used as resolved.
    """
    if isinstance(template, PumpFunAmmCurve):
        market_cap_sol = anchor.mid_price * PUMPFUN_TOTAL_SUPPLY_UI
        return PumpFunAmmCurve.for_market_cap_sol(market_cap_sol)
    if isinstance(template, ConcentratedLiquidityCurve):
        fee_bps = _VENUE_FIT_FEE_BPS.get(protocol, DEFAULT_ANCHOR_FEE_BPS)
        curve, _estimate = ConcentratedLiquidityCurve.from_recent_swaps(
            _observations(swaps), fee_bps=fee_bps, protocol=protocol
        )
        return curve
    return template


def build_market_regime(swaps: list[SwapEvent], *, min_swaps: int = 8) -> MarketRegime:
    """Resolve the venue, curve, and reserve anchor for one token's full-life swap tape.

    Groups nothing (the caller passes one mint's swaps). Returns a non-tradeable :class:`MarketRegime`
    (with a reason) for an unsupported venue, a token with too few swaps, or a failed anchor fit —
    the honest "skip/flag, do not fabricate" outcome the task mandates for ``jupiter_v6`` and friends.
    """
    if not swaps:
        return MarketRegime(mint="", protocol=None, tradeable=False, reason="no swaps")
    mint = swaps[0].mint
    ordered = sorted(swaps, key=lambda s: (s.slot, s.block_time))
    if len(ordered) < min_swaps:
        return MarketRegime(
            mint=mint, protocol=None, tradeable=False,
            reason=f"too few swaps ({len(ordered)} < {min_swaps})",
        )

    protocol = _dominant_protocol(ordered)
    resolution = try_resolve_curve(protocol)
    if not resolution.supported or resolution.curve is None:
        return MarketRegime(
            mint=mint, protocol=protocol, tradeable=False,
            reason=f"unsupported venue: {resolution.reason}",
        )
    template = resolution.curve

    # Bonding-curve tokens anchor on the KNOWN pump.fun virtual seed, not a fit (the curve prices off
    # those exact constants — a fitted anchor would break its graduation math).
    try:
        if isinstance(template, PumpFunBondingCurve):
            seed = bonding_curve_seed_liquidity(mint, ordered[0])
            anchor = ReserveAnchor(
                base_reserve=seed.base_amount,
                quote_reserve=seed.quote_amount,
                slot=seed.slot,
                source="pumpfun_bonding_seed",
            )
            sim_tape: list[TapeEvent] = [seed, *ordered]
        else:
            fee_bps = _VENUE_FIT_FEE_BPS.get(protocol or "", DEFAULT_ANCHOR_FEE_BPS)
            sim_tape, anchor = prepare_market_tape(ordered, fee_bps=fee_bps)
    except ValueError as exc:
        return MarketRegime(
            mint=mint, protocol=protocol, tradeable=False,
            reason=f"anchor reconstruction failed: {exc}",
        )

    curve = _specialise_curve(template, protocol or "", ordered, anchor)
    decision_times = sorted({s.block_time for s in ordered})
    return MarketRegime(
        mint=mint,
        protocol=protocol,
        tradeable=True,
        curve=curve,
        anchor=anchor,
        sim_tape=sim_tape,
        decision_times=decision_times,
    )


def market_sim_config(
    *,
    risk_budget_quote: Decimal = Decimal("0.05"),
    execution: ExecutionParams | None = None,
    seed: int = 0,
    min_quote_reserve: Decimal = Decimal(0),
    max_price_impact_bps: Decimal = Decimal(0),
) -> SimConfig:
    """A :class:`SimConfig` for the generic env. The venue curve carries the fee — the ``PoolConfig``
    fee here is unused by :class:`MarketReplaySimulator` (which fills through the curve), so it is left
    at 0; ``risk_budget_quote`` / execution frictions / liquidity guards behave exactly as the
    bonding-curve config's."""
    return SimConfig(
        risk_budget_quote=risk_budget_quote,
        pool=PoolConfig(
            fee_bps=0,
            min_quote_reserve=min_quote_reserve,
            max_price_impact_bps=max_price_impact_bps,
        ),
        execution=execution or ExecutionParams(),
        seed=seed,
    )


class MarketReplayEnv(TradingEnv):
    """A :class:`TradingEnv` whose fill path is venue-appropriate (see the module docstring).

    Build it from a resolved tradeable :class:`MarketRegime` via :meth:`from_regime`, or directly with
    the sim-ready ``tape`` + resolved ``curve``. Every other part of the RL contract — action,
    observation, reward, episode boundaries — is inherited from :class:`TradingEnv` verbatim, so the
    same eval battery and baselines score it unchanged.
    """

    def __init__(
        self,
        tape: list[TapeEvent],
        mint: Mint,
        sim_config: SimConfig,
        *,
        curve: Curve,
        decision_times: list[datetime] | None = None,
        feature_store: FeatureStore | None = None,
        config: EnvConfig | None = None,
    ) -> None:
        super().__init__(
            tape, mint, sim_config,
            decision_times=decision_times, feature_store=feature_store, config=config,
        )
        self._curve = curve

    @classmethod
    def from_regime(
        cls,
        regime: MarketRegime,
        sim_config: SimConfig,
        *,
        decision_times: list[datetime] | None = None,
        feature_store: FeatureStore | None = None,
        config: EnvConfig | None = None,
    ) -> MarketReplayEnv:
        """Construct from a tradeable :class:`MarketRegime`. Raises if the regime is not tradeable."""
        if not regime.tradeable or regime.curve is None or regime.sim_tape is None:
            raise ValueError(f"regime for {regime.mint} is not tradeable: {regime.reason}")
        return cls(
            regime.sim_tape,
            regime.mint,
            sim_config,
            curve=regime.curve,
            decision_times=decision_times if decision_times is not None else regime.decision_times,
            feature_store=feature_store,
            config=config,
        )

    @property
    def curve(self) -> Curve:
        return self._curve

    def _build_simulator(self) -> ReplaySimulator:
        return MarketReplaySimulator(self._tape, self._sim_config, curve=self._curve)
