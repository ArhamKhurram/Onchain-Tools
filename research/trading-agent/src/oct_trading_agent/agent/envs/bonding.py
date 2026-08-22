"""Bonding-curve regime setup — seed the replay sim with pump.fun's known virtual reserves.

Phase 1 trades the **pump.fun pre-migration bonding curve** — protocol ``pumpfun``, the earliest-life
regime and the highest-fidelity phase (its fill law is a closed form off *on-chain-constant* virtual
reserves, so the sim reproduces real fills to ~0 bps; see ``sim/curves/bonding_curve.py``). The
replay simulator fills against reconstructed pool depth (``sim/replay/simulator.py`` →
``PoolReconstructor``), but a decoded swap stream carries **no reserves** and there is no LP-``add``
event for a bonding-curve token — so, left alone, the pool never anchors and nothing fills.

We bridge this the honest way the reconstructor already supports: **prepend one synthetic
pool-creation ``add``** carrying pump.fun's published seed virtual reserves
(``1,073,000,000`` virtual tokens, ``30`` virtual SOL — ``BondingCurveParams.mainnet_ui``). The
reconstructor then anchors on that add and folds each real swap's amount deltas onto it, recovering
the *virtual reserve trajectory* at every instant — which is exactly the constant-product state the
bonding curve prices off. We do not invent per-swap reserves or perturb the historical flow; we
supply the one known creation fact and let the sim's own causal fold do the rest.

The agent's own fills are counterfactual and never enter the tape (conservative own-impact-only,
``sim/replay/simulator.py``), and the pool is re-reconstructed from the tape each step, so the small
"fee retained in pool" difference between the constant-product fill and the fee-external bonding
curve does not accumulate across the agent's actions.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

from oct_trading_agent.core import LiquidityEvent, Mint, SwapEvent, TapeEvent
from oct_trading_agent.sim.amm.fees import PoolConfig
from oct_trading_agent.sim.curves.bonding_curve import (
    PUMPFUN_BONDING_CURVE_STANDARD_FEE,
    BondingCurveParams,
)
from oct_trading_agent.sim.execution.model import ExecutionParams
from oct_trading_agent.sim.replay.simulator import SimConfig

#: The venue tag for pump.fun's pre-migration bonding curve (Pinax ``protocol``).
PUMPFUN_PROTOCOL = "pumpfun"

#: Total mainnet bonding-curve trader fee: protocol 95 + creator 30 = 125 bps (external, not LP).
PUMPFUN_BONDING_FEE_BPS = int(PUMPFUN_BONDING_CURVE_STANDARD_FEE.total_bps)


def bonding_curve_seed_liquidity(
    mint: Mint,
    first_swap: SwapEvent,
    *,
    params: BondingCurveParams | None = None,
) -> LiquidityEvent:
    """A synthetic pool-creation ``add`` carrying pump.fun's seed VIRTUAL reserves (UI units).

    Placed one slot / one second before ``first_swap`` so it is the causal anchor the reconstructor
    folds subsequent swaps onto. ``base_amount`` = initial virtual tokens, ``quote_amount`` = initial
    virtual SOL — the same units the swap amounts are in.
    """
    seeds = params or BondingCurveParams.mainnet_ui()
    return LiquidityEvent(
        mint=mint,
        slot=max(0, first_swap.slot - 1),
        block_time=first_swap.block_time - timedelta(seconds=1),
        signature=f"pumpfun-seed-{mint}",
        action="add",
        base_amount=seeds.initial_virtual_token_reserves,
        quote_amount=seeds.initial_virtual_sol_reserves,
    )


def prepare_bonding_curve_tape(
    swaps: list[SwapEvent],
    *,
    params: BondingCurveParams | None = None,
) -> list[TapeEvent]:
    """Return a sim-ready tape: the seed ``add`` prepended to a token's causal swap sequence.

    ``swaps`` must be one token's swaps in causal order (the caller sorts; this asserts a single
    mint). The returned tape anchors the pool at the pump.fun seed and lets the reconstructor recover
    virtual reserves at any ``as_of``. An empty input yields an empty tape (nothing to trade).
    """
    if not swaps:
        return []
    mints = {s.mint for s in swaps}
    if len(mints) != 1:
        raise ValueError(f"prepare_bonding_curve_tape expects one mint, got {len(mints)}")
    ordered = sorted(swaps, key=lambda s: (s.slot, s.block_time))
    seed = bonding_curve_seed_liquidity(ordered[0].mint, ordered[0], params=params)
    tape: list[TapeEvent] = [seed]
    tape.extend(ordered)
    return tape


def bonding_curve_sim_config(
    *,
    risk_budget_quote: Decimal = Decimal("0.05"),
    fee_bps: int = PUMPFUN_BONDING_FEE_BPS,
    execution: ExecutionParams | None = None,
    seed: int = 0,
    min_quote_reserve: Decimal = Decimal(0),
    max_price_impact_bps: Decimal = Decimal(0),
) -> SimConfig:
    """A :class:`SimConfig` for the bonding-curve regime.

    Defaults: a small ``0.05`` SOL full-size risk budget (new pairs are thin; a realistic scalp),
    the real ``125`` bps bonding-curve trader fee (so PnL is *after realistic costs* — the "~0 bps"
    fidelity refers to fill reproduction, not the trader fee), and the conservative default execution
    frictions (latency + gas; no MEV/tx-fail by default — a learner can turn those on). Liquidity
    floor defaults off because virtual SOL only grows on a live bonding curve.
    """
    return SimConfig(
        risk_budget_quote=risk_budget_quote,
        pool=PoolConfig(
            fee_bps=fee_bps,
            min_quote_reserve=min_quote_reserve,
            max_price_impact_bps=max_price_impact_bps,
        ),
        execution=execution or ExecutionParams(),
        seed=seed,
    )


__all__ = [
    "PUMPFUN_BONDING_FEE_BPS",
    "PUMPFUN_PROTOCOL",
    "bonding_curve_seed_liquidity",
    "bonding_curve_sim_config",
    "prepare_bonding_curve_tape",
]
