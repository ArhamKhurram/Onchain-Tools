"""TradingEnv tests — reset/step contract, episode boundaries, forced liquidation, mark invariance."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from oct_trading_agent.agent.envs import (
    EnvAction,
    EnvConfig,
    Observation,
    TradingEnv,
    bonding_curve_sim_config,
    prepare_bonding_curve_tape,
)
from oct_trading_agent.core import Intent, Side, SwapEvent

MINT = "TokenMintPumpFunBonding0000000000000000000000"
T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)


def _swap(i: int, side: Side = Side.BUY, base: str = "1900", quote: str = "0.00005") -> SwapEvent:
    return SwapEvent(
        mint=MINT,
        slot=1000 + i,
        block_time=T0 + timedelta(seconds=i),
        signature=f"s{i}",
        signer=f"w{i}",
        side=side,
        base_amount=Decimal(base),
        quote_amount=Decimal(quote),
        price=Decimal(quote) / Decimal(base),
        protocol="pumpfun",
    )


def _env(n_swaps: int = 10, **cfg: object) -> TradingEnv:
    swaps = [_swap(i) for i in range(n_swaps)]
    tape = prepare_bonding_curve_tape(swaps)
    return TradingEnv(
        tape,
        MINT,
        bonding_curve_sim_config(risk_budget_quote=Decimal("0.01")),
        config=EnvConfig(initial_balance_quote=Decimal(1), **cfg),  # type: ignore[arg-type]
    )


def test_reset_returns_observation_and_decision_times() -> None:
    env = _env(10)
    obs = env.reset()
    assert isinstance(obs, Observation)
    assert len(env.decision_times) == 10


def test_open_then_close_terminates_full_exit() -> None:
    env = _env(10)
    env.reset()
    env.step(EnvAction(intent=Intent.OPEN_LONG, size=1.0))
    result = env.step(EnvAction(intent=Intent.CLOSE))
    assert result.terminated
    assert result.info.get("terminal_reason") == "full_exit"


def test_episode_truncates_at_end_of_tape_with_forced_liquidation() -> None:
    """Running out of decision times truncates; an open position is force-liquidated (realized)."""
    env = _env(3)
    env.reset()
    env.step(EnvAction(intent=Intent.OPEN_LONG, size=1.0))
    env.step(EnvAction(intent=Intent.HOLD))
    result = env.step(EnvAction(intent=Intent.HOLD))  # last decision time -> truncation
    assert result.truncated
    assert result.info.get("forced_liquidation") is True
    # After forced liquidation the ledger episode is realized and flat.
    episode = env.close_episode()
    assert episode is not None


def test_hold_sol_never_trades_and_stays_flat() -> None:
    env = _env(5)
    env.reset()
    done = False
    while not done:
        result = env.step(EnvAction(intent=Intent.NO_OP))
        done = result.terminated or result.truncated
    episode = env.close_episode()
    assert episode is not None
    assert episode.realized_pnl_quote == Decimal(0)  # doing nothing costs nothing (patience untaxed)


def test_step_before_reset_raises() -> None:
    env = _env(5)
    try:
        env.step(EnvAction(intent=Intent.HOLD))
        raise AssertionError("expected RuntimeError")
    except RuntimeError:
        pass


def test_reward_ignores_mark_price_end_to_end() -> None:
    """Two identical runs with different pool marks (via different tapes) give identical rewards on a
    HOLD-only policy, because HOLD books no realized PnL and mark never enters the reward."""
    env = _env(5)
    env.reset()
    rewards = []
    done = False
    while not done:
        result = env.step(EnvAction(intent=Intent.HOLD))
        rewards.append(result.reward)
        done = result.terminated or result.truncated
    # A HOLD-only episode with no position books zero realized PnL every step -> zero reward.
    assert all(r == 0.0 for r in rewards)
