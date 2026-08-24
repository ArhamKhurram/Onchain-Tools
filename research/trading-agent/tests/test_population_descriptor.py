"""Behavioral-descriptor + niche-binning tests (``agent/population/descriptor``). TORCH-FREE.

The descriptor→niche mapping is the QD engine's seam, so it is pinned hard here: synthetic
descriptors must land in the expected memecoin role for every grid cell, and a real (baseline-driven)
rollout must produce an honest descriptor (a buy-and-hold trades once and holds; a hold-SOL never
trades and reads as maximal entry latency).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from oct_trading_agent.agent.envs import (
    EnvConfig,
    MarketReplayEnv,
    TradingEnv,
    build_market_regime,
    market_sim_config,
)
from oct_trading_agent.agent.population.descriptor import (
    BehavioralDescriptor,
    behavioral_rollout,
    bin_descriptor,
    profile_policy,
    summarize_behavior,
)
from oct_trading_agent.core import Side, SwapEvent
from oct_trading_agent.eval.baselines import BuyAndHoldPolicy, HoldSolPolicy

T0 = datetime(2026, 8, 22, tzinfo=UTC)


def _venue_swaps(protocol: str = "pumpfun_amm", *, n: int = 50) -> list[SwapEvent]:
    mint = f"Tok_{protocol}_000000000000000000000000000"
    base_res, quote_res = Decimal("1500000"), Decimal("60")
    swaps: list[SwapEvent] = []
    for i in range(n):
        side = Side.BUY if i % 2 == 0 else Side.SELL
        if side is Side.BUY:
            q = Decimal("0.04")
            b = base_res * q / (quote_res + q)
            base_res -= b
            quote_res += q
            qa, ba = q, b
        else:
            b = Decimal("350")
            q = quote_res * b / (base_res + b)
            base_res += b
            quote_res -= q
            qa, ba = q, b
        swaps.append(
            SwapEvent(
                mint=mint, slot=1000 + i, block_time=T0 + timedelta(seconds=i * 3),
                signature=f"s{i}", signer=f"w{i % 5}", side=side,
                base_amount=ba, quote_amount=qa, price=qa / ba, protocol=protocol,
            )
        )
    return swaps


def _env() -> MarketReplayEnv:
    regime = build_market_regime(_venue_swaps())
    assert regime.tradeable, regime.reason
    return MarketReplayEnv.from_regime(
        regime,
        market_sim_config(risk_budget_quote=Decimal("0.05")),
        config=EnvConfig(initial_balance_quote=Decimal(1)),
    )


def _desc(trade_frequency: float, mean_hold_secs: float) -> BehavioralDescriptor:
    return BehavioralDescriptor(
        trade_frequency=trade_frequency, mean_hold_secs=mean_hold_secs,
        entry_latency_frac=0.5, sell_ratio=0.5, mean_size=0.5,
    )


def test_bin_descriptor_covers_the_full_grid() -> None:
    """Every one of the 3×2 (freq × hold) cells maps to its documented distinct memecoin role.

    Goofy codenames (desk-telemetry-schema.md), preserving the cell→name assignment: SHORT hold row
    is GREMLIN/GECKO/GOBLIN across LOW/MED/HIGH turnover, LONG hold row is GIZMO/PICKLE/NOODLE.
    """
    assert bin_descriptor(_desc(0.02, 10.0)) == "GREMLIN"  # LOW freq, SHORT hold
    assert bin_descriptor(_desc(0.12, 10.0)) == "GECKO"  # MED freq, SHORT hold
    assert bin_descriptor(_desc(0.30, 10.0)) == "GOBLIN"  # HIGH freq, SHORT hold
    assert bin_descriptor(_desc(0.02, 200.0)) == "GIZMO"  # LOW freq, LONG hold
    assert bin_descriptor(_desc(0.12, 200.0)) == "PICKLE"  # MED freq, LONG hold
    assert bin_descriptor(_desc(0.30, 200.0)) == "NOODLE"  # HIGH freq, LONG hold


def test_bin_descriptor_boundaries_are_inclusive_on_the_upper_band() -> None:
    """Threshold edges resolve deterministically (>= LONG, >= HIGH)."""
    assert bin_descriptor(_desc(0.08, 89.9)) == "GECKO"  # exactly FREQ_LOW_MAX -> MED, still SHORT
    assert bin_descriptor(_desc(0.20, 90.0)) == "NOODLE"  # exactly HIGH_MIN & exactly LONG


def test_non_trader_bins_to_gremlin() -> None:
    """A do-nothing agent (freq 0, no hold) lands in GREMLIN — the LOW-freq/SHORT-hold cell."""
    assert bin_descriptor(_desc(0.0, 0.0)) == "GREMLIN"
    assert bin_descriptor(summarize_behavior([]).descriptor) == "GREMLIN"


def test_summarize_empty_is_zeroed_and_honest() -> None:
    profile = summarize_behavior([])
    assert profile.pnl_bps == 0.0
    assert profile.n_trades == 0
    assert profile.win_rate == 0.0
    assert profile.descriptor.entry_latency_frac == 1.0  # never entered -> maximal latency


def test_behavioral_rollout_buy_and_hold_enters_once_and_holds() -> None:
    """Buy-and-hold: one early entry, a real hold span, and sells accounted at the forced close."""
    env = _env()
    sample = behavioral_rollout(env, BuyAndHoldPolicy(size=1.0))
    assert sample.n_buys == 1
    assert sample.first_entry_step == 0  # entered at the first decision instant
    assert sample.n_steps > 0
    assert len(sample.hold_secs) == 1  # the position is held from entry to the episode boundary
    assert sample.hold_secs[0] > 0.0
    assert len(sample.sizes) == 1


def test_behavioral_rollout_hold_sol_never_trades() -> None:
    env = _env()
    sample = behavioral_rollout(env, HoldSolPolicy())
    assert sample.n_trades == 0
    assert sample.first_entry_step is None
    assert sample.hold_secs == ()


def test_profile_policy_summarizes_across_tokens() -> None:
    """A multi-token profile carries a finite fitness, the right token count, and a real descriptor."""
    envs: list[TradingEnv] = [_env(), _env(), _env()]
    profile = profile_policy(envs, BuyAndHoldPolicy(size=1.0))
    assert profile.n_tokens == 3
    assert profile.n_trades >= 3  # one entry per token, plus the forced closes
    assert 0.0 <= profile.win_rate <= 1.0
    assert profile.descriptor.trade_frequency > 0.0
    # buy-and-hold on a mean-reverting synthetic pool only loses costs — bounded, not catastrophic.
    assert -2000.0 < profile.pnl_bps <= 500.0


def test_hold_sol_profile_bins_to_gremlin() -> None:
    envs: list[TradingEnv] = [_env(), _env()]
    profile = profile_policy(envs, HoldSolPolicy())
    assert profile.descriptor.trade_frequency == 0.0
    assert bin_descriptor(profile.descriptor) == "GREMLIN"
