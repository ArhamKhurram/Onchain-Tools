"""Rollout runner — drive an :class:`EnvPolicy` through :class:`TradingEnv`, collect realized results.

This is the apples-to-apples harness (paper §8): every policy — random, hold-SOL, buy-and-hold, and
(later) a learned actor — runs through the *same* env with the *same* costs, and its realized,
after-cost outcome is measured with the *same* battery. Nothing here scores or shapes; it only
executes the standard ``reset``/``step`` loop and aggregates the realized ledger figures the env
reports in ``info``.

``return_pct`` is the episode's realized PnL divided by the starting balance — the per-token,
size-normalized quantity the metric battery consumes and the per-token-edge comparison ranks on.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

import numpy as np

from oct_trading_agent.agent.envs import TradingEnv
from oct_trading_agent.agent.policies import EnvPolicy
from oct_trading_agent.core import Mint

from .metrics import MetricReport, compute_metrics


@dataclass(frozen=True)
class EpisodeOutcome:
    """The realized, after-cost outcome of one token episode."""

    mint: Mint
    realized_pnl_quote: float
    return_pct: float
    initial_balance_quote: float
    final_balance_quote: float
    n_steps: int
    n_trades: int  # fills that actually moved base (a buy or a sell that executed)
    total_fees_quote: float
    total_mev_quote: float
    mean_slippage_bps: float
    terminal_reason: str | None


@dataclass(frozen=True)
class PolicyEvaluation:
    """A policy's outcomes across a set of token episodes, plus the battery over their returns."""

    policy_name: str
    outcomes: list[EpisodeOutcome]
    metrics: MetricReport

    @property
    def returns(self) -> np.ndarray:
        return np.array([o.return_pct for o in self.outcomes], dtype=np.float64)


def rollout(env: TradingEnv, policy: EnvPolicy) -> EpisodeOutcome:
    """Run one episode of ``policy`` in ``env`` and return its realized outcome.

    Drives the standard loop: ``reset`` → ``act``/``step`` until ``terminated or truncated``. Costs
    and trade counts are aggregated from each step's ``info``; the realized episode PnL is read from
    the closed ledger episode (realized-only, never from any mark).
    """
    policy.reset()
    obs = env.reset()
    initial_balance = float(env.config.initial_balance_quote)

    n_steps = 0
    n_trades = 0
    total_fees = 0.0
    total_mev = 0.0
    slippage_samples: list[float] = []

    done = False
    while not done:
        action = policy.act(obs)
        result = env.step(action)
        obs = result.observation
        info = result.info
        n_steps += 1
        total_fees += float(info.get("fee_quote", Decimal(0)))  # type: ignore[arg-type]
        total_mev += float(info.get("mev_penalty_quote", Decimal(0)))  # type: ignore[arg-type]
        if info.get("fill_success") and float(info.get("slippage_bps", 0.0)) > 0.0:  # type: ignore[arg-type]
            slippage_samples.append(float(info["slippage_bps"]))  # type: ignore[arg-type]
            n_trades += 1
        done = result.terminated or result.truncated

    episode = env.close_episode()
    realized = float(episode.realized_pnl_quote) if episode is not None else 0.0
    terminal_reason = (
        episode.terminal_reason.value if episode is not None and episode.terminal_reason else None
    )
    final_balance = float(env.balance_quote)
    return EpisodeOutcome(
        mint=env.mint,
        realized_pnl_quote=realized,
        return_pct=realized / initial_balance if initial_balance > 0 else 0.0,
        initial_balance_quote=initial_balance,
        final_balance_quote=final_balance,
        n_steps=n_steps,
        n_trades=n_trades,
        total_fees_quote=total_fees,
        total_mev_quote=total_mev,
        mean_slippage_bps=float(np.mean(slippage_samples)) if slippage_samples else 0.0,
        terminal_reason=terminal_reason,
    )


def evaluate_policy(
    envs: list[TradingEnv], policy: EnvPolicy, name: str, *, cvar_alpha: float = 0.05
) -> PolicyEvaluation:
    """Run ``policy`` once through each env (one episode per token) and compute the battery.

    The metric battery is over the per-episode return series; cost aggregates (fees, MEV, slippage,
    turnover) are folded in so a "works only at zero cost" policy is visible in the report.
    """
    outcomes = [rollout(env, policy) for env in envs]
    returns = np.array([o.return_pct for o in outcomes], dtype=np.float64)
    # Equity path for drawdown starts at the initial capital (1.0), not at 0, so the running peak is
    # well-defined even when cumulative returns are small/negative.
    equity = 1.0 + np.cumsum(returns) if returns.size else None
    base = compute_metrics(returns, equity_curve=equity, cvar_alpha=cvar_alpha)

    total_fees = sum(o.total_fees_quote for o in outcomes)
    total_mev = sum(o.total_mev_quote for o in outcomes)
    slippages = [o.mean_slippage_bps for o in outcomes if o.mean_slippage_bps > 0.0]
    total_trades = sum(o.n_trades for o in outcomes)
    metrics = MetricReport(
        **{
            **base.__dict__,
            "total_fees_quote": total_fees,
            "total_mev_quote": total_mev,
            "mean_slippage_bps": float(np.mean(slippages)) if slippages else 0.0,
            "turnover": float(total_trades),
        }
    )
    return PolicyEvaluation(policy_name=name, outcomes=outcomes, metrics=metrics)


@dataclass(frozen=True)
class PerTokenEdge:
    """Per-token realized edge of a policy vs a baseline (paper §8.2, §8.4 shape)."""

    per_token: dict[Mint, float]
    fraction_beaten: float
    mean_edge: float
    median_edge: float


def per_token_edge(
    policy_eval: PolicyEvaluation, baseline_eval: PolicyEvaluation
) -> PerTokenEdge:
    """Per-token ``policy.return - baseline.return`` and its summary (fraction beaten, mean/median).

    Matches on mint. This is the shape of §8.2 (per-token outperformance) reused here against the
    baselines; the same routine measures edge vs the labeled-trader cohort once that cohort is wired.
    """
    baseline_by_mint = {o.mint: o.return_pct for o in baseline_eval.outcomes}
    edges: dict[Mint, float] = {}
    for outcome in policy_eval.outcomes:
        if outcome.mint in baseline_by_mint:
            edges[outcome.mint] = outcome.return_pct - baseline_by_mint[outcome.mint]
    values = np.array(list(edges.values()), dtype=np.float64)
    if values.size == 0:
        return PerTokenEdge(per_token={}, fraction_beaten=0.0, mean_edge=0.0, median_edge=0.0)
    return PerTokenEdge(
        per_token=edges,
        fraction_beaten=float(np.mean(values > 0.0)),
        mean_edge=float(values.mean()),
        median_edge=float(np.median(values)),
    )


__all__ = [
    "EpisodeOutcome",
    "PerTokenEdge",
    "PolicyEvaluation",
    "evaluate_policy",
    "per_token_edge",
    "rollout",
]
