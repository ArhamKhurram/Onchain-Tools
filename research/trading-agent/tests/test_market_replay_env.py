"""``MarketReplayEnv`` tests — venue dispatch, honest skips, and the RL-contract inheritance.

Network-free, torch-free. Synthetic single-venue tapes exercise every curve family plus the
unsupported-venue skip, and assert the generic env keeps the bonding env's reward/observation/episode
contract (it IS a ``TradingEnv``) — the one thing that must not change when only the fill path does.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from oct_trading_agent.agent.envs import (
    EnvAction,
    EnvConfig,
    MarketRegime,
    MarketReplayEnv,
    Observation,
    TradingEnv,
    build_market_regime,
    market_sim_config,
)
from oct_trading_agent.core import Intent, Side, SwapEvent
from oct_trading_agent.eval.baselines import BuyAndHoldPolicy, HoldSolPolicy
from oct_trading_agent.eval.runner import evaluate_policy

T0 = datetime(2026, 8, 22, tzinfo=UTC)


def _venue_swaps(protocol: str, *, n: int = 50, mint: str | None = None) -> list[SwapEvent]:
    """A synthetic single-venue tape off a constant-product-ish pool, alternating buy/sell."""
    mint = mint or f"Tok_{protocol}_000000000000000000000000000"
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


def _env(protocol: str, **cfg: object) -> MarketReplayEnv:
    regime = build_market_regime(_venue_swaps(protocol))
    assert regime.tradeable, regime.reason
    return MarketReplayEnv.from_regime(
        regime,
        market_sim_config(risk_budget_quote=Decimal("0.05")),
        config=EnvConfig(initial_balance_quote=Decimal(1), **cfg),  # type: ignore[arg-type]
    )


@pytest.mark.parametrize(
    "protocol,expected_curve",
    [
        ("pumpfun_amm", "PumpFunAmmCurve"),
        ("raydium_amm_v4", "ConstantProductCurve"),
        ("orca_whirlpool", "ConcentratedLiquidityCurve"),
        ("raydium_clmm", "ConcentratedLiquidityCurve"),
        ("meteora_dlmm", "ConcentratedLiquidityCurve"),
        ("pumpfun", "PumpFunBondingCurve"),
    ],
)
def test_venue_resolves_to_expected_curve(protocol: str, expected_curve: str) -> None:
    regime = build_market_regime(_venue_swaps(protocol))
    assert regime.tradeable, regime.reason
    assert regime.curve is not None
    assert type(regime.curve).__name__ == expected_curve


def test_jupiter_router_is_flagged_not_faked() -> None:
    """A jupiter_v6 router token has no single curve — it must be skipped with a reason, never faked."""
    regime = build_market_regime(_venue_swaps("jupiter_v6"))
    assert regime.tradeable is False
    assert regime.curve is None
    assert regime.reason is not None and "unsupported" in regime.reason


def test_unknown_venue_is_flagged() -> None:
    regime = build_market_regime(_venue_swaps("some_new_dex_v9"))
    assert regime.tradeable is False
    assert regime.reason is not None


def test_too_few_swaps_is_flagged() -> None:
    regime = build_market_regime(_venue_swaps("pumpfun_amm", n=4))
    assert regime.tradeable is False
    assert "too few" in (regime.reason or "")


def test_from_regime_rejects_untradeable() -> None:
    regime = MarketRegime(mint="x", protocol="jupiter_v6", tradeable=False, reason="router")
    with pytest.raises(ValueError, match="not tradeable"):
        MarketReplayEnv.from_regime(regime, market_sim_config())


def test_market_env_is_a_trading_env() -> None:
    """The generic env IS a TradingEnv, so the eval runner / baselines accept it unchanged."""
    assert issubclass(MarketReplayEnv, TradingEnv)
    env = _env("pumpfun_amm")
    assert isinstance(env.reset(), Observation)


def test_buy_then_close_is_realistic_not_catastrophic() -> None:
    """The bug this env fixes: a long-only buy→close must book a small, cost-scale loss — NOT −2000×."""
    env = _env("pumpfun_amm")
    env.reset()
    env.step(EnvAction(intent=Intent.OPEN_LONG, size=1.0))
    for _ in range(4):
        env.step(EnvAction(intent=Intent.HOLD))
    result = env.step(EnvAction(intent=Intent.CLOSE))
    assert result.terminated
    assert result.info.get("terminal_reason") == "full_exit"
    episode = env.close_episode()
    assert episode is not None
    # A single round-trip on a stable pool loses only fees+slippage: bounded to a few percent of the
    # risk budget, never a multiple of the whole balance.
    realized = float(episode.realized_pnl_quote)
    assert -0.02 < realized <= 0.0


def test_hold_only_books_zero_reward() -> None:
    """The §3.5 reward contract is inherited verbatim: HOLD-only books no realized PnL, zero reward."""
    env = _env("pumpfun_amm")
    env.reset()
    rewards = []
    done = False
    while not done:
        r = env.step(EnvAction(intent=Intent.HOLD))
        rewards.append(r.reward)
        done = r.terminated or r.truncated
    assert all(x == 0.0 for x in rewards)


def test_baselines_run_through_market_env() -> None:
    """hold-SOL and buy-and-hold both run through the generic env and produce bounded returns."""
    envs: list[TradingEnv] = [_env("pumpfun_amm"), _env("raydium_amm_v4"), _env("orca_whirlpool")]
    hold = evaluate_policy(envs, HoldSolPolicy(), "hold_sol")
    buy_envs: list[TradingEnv] = [
        _env("pumpfun_amm"), _env("raydium_amm_v4"), _env("orca_whirlpool")
    ]
    buy = evaluate_policy(buy_envs, BuyAndHoldPolicy(size=1.0), "buy_and_hold")
    assert hold.metrics.mean_return == 0.0  # never trades -> flat
    # buy-and-hold on a mean-reverting synthetic pool loses only costs — bounded, not catastrophic.
    assert all(-0.1 < o.return_pct <= 0.05 for o in buy.outcomes)
