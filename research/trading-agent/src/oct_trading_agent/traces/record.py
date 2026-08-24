"""Recording rollout — drive any :class:`EnvPolicy` through a :class:`TradingEnv`, keep its trades.

The same ``reset``/``act``/``step`` loop as the eval runner (:mod:`oct_trading_agent.eval.runner`)
and the descriptor profiler — apples-to-apples with both — but its output is the replay substrate:
one :class:`~.schema.TradeRow` per REAL fill (the runner's own trade criterion: ``fill_success``
with positive slippage), plus the episode's realized summary. Torch-free: any policy satisfying the
protocol records identically, so a seeded :class:`RandomPolicy` exercises the whole path in tests.

Honesty notes, mirroring the env's own discipline:

* ``quote`` on an agent fill is the paper-balance moved by the step (cost-inclusive) — the env does
  not report per-fill execution amounts, and nothing here invents them.
* A position still open at truncation is realized by the env's FORCED liquidation; that close books
  PnL the per-step ``info`` never itemizes, so it surfaces as one final synthetic ``close`` row
  whose ``realized_cum`` is the episode's true realized total (the same residual treatment the
  behavioral profiler applies). Its ``quote`` is ``None`` — unknown, not zero.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from oct_trading_agent.agent.envs import TradingEnv
from oct_trading_agent.agent.policies import EnvPolicy

from .schema import BUY_INTENTS, SELL_INTENTS, TradeRow


@dataclass(frozen=True)
class RecordedEpisode:
    """One recorded (actor, token) episode: its trade rows + the realized summary line."""

    mint: str
    rows: list[TradeRow]
    n_steps: int
    realized_pnl_quote: float
    final_balance_quote: float


def _epoch(value: object) -> int:
    assert isinstance(value, datetime), f"env step info carried a non-datetime as_of: {value!r}"
    return int(value.timestamp())


def record_policy_rollout(
    env: TradingEnv,
    policy: EnvPolicy,
    *,
    actor_id: str,
    group_id: str,
) -> RecordedEpisode:
    """Run one episode and return every trade as a replay-ready :class:`~.schema.TradeRow`."""
    policy.reset()
    obs = env.reset()
    mint = str(env.mint)

    rows: list[TradeRow] = []
    n_steps = 0
    cum_realized = 0.0
    prev_balance = float(env.config.initial_balance_quote)
    last_t: int | None = None

    done = False
    while not done:
        action = policy.act(obs)
        result = env.step(action)
        info = result.info
        t = _epoch(info.get("as_of"))
        last_t = t
        balance = float(info.get("balance_quote", prev_balance))  # type: ignore[arg-type]
        realized = float(info.get("realized_pnl_quote", 0.0))  # type: ignore[arg-type]
        forced = bool(info.get("forced_liquidation"))
        intent = str(info.get("intent", ""))
        is_fill = bool(info.get("fill_success")) and float(info.get("slippage_bps", 0.0)) > 0.0  # type: ignore[arg-type]

        if is_fill and intent in (BUY_INTENTS | SELL_INTENTS):
            cum_realized += realized
            # The forced close (if any) also moved the balance this step; only attribute the
            # balance delta to the agent's own fill when the step held no second, forced booking.
            quote_moved = None if forced else abs(balance - prev_balance)
            rows.append(
                TradeRow(
                    actor_id=actor_id,
                    actor_kind="agent",
                    group_id=group_id,
                    mint=mint,
                    t=t,
                    seq=n_steps,
                    side="buy" if intent in BUY_INTENTS else "sell",
                    fill=True,
                    intent=intent,
                    size_frac=float(info.get("size", 0.0)),  # type: ignore[arg-type]
                    quote=quote_moved,
                    bal_after=balance,
                    realized_cum=cum_realized,
                )
            )
        elif realized != 0.0:
            cum_realized += realized  # a non-fill step can still book (e.g. a rug absorbs the position)

        prev_balance = balance
        n_steps += 1
        obs = result.observation
        done = result.terminated or result.truncated

    episode = env.close_episode()
    total_realized = float(episode.realized_pnl_quote) if episode is not None else 0.0
    final_balance = float(env.balance_quote)

    # Residual realized PnL the per-step info never itemized (the forced end-of-episode close):
    # surface it as one synthetic close row at the last decision instant, never silently drop it.
    if abs(total_realized - cum_realized) > 1e-12 and last_t is not None:
        rows.append(
            TradeRow(
                actor_id=actor_id,
                actor_kind="agent",
                group_id=group_id,
                mint=mint,
                t=last_t,
                seq=n_steps,
                side="sell",
                fill=True,
                intent="close",
                bal_after=final_balance,
                realized_cum=total_realized,
            )
        )

    return RecordedEpisode(
        mint=mint,
        rows=rows,
        n_steps=n_steps,
        realized_pnl_quote=total_realized,
        final_balance_quote=final_balance,
    )


__all__ = ["RecordedEpisode", "record_policy_rollout"]
