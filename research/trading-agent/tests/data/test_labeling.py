"""Trader-labeling pipeline: full win-and-loss reconstruction into demonstration trajectories."""

from __future__ import annotations

from collections import Counter
from decimal import Decimal
from pathlib import Path

from oct_trading_agent.core.enums import Intent, Side
from oct_trading_agent.data.labeling import (
    LabeledWallet,
    build_trajectories,
    build_trajectories_for,
    load_labeled_wallets,
)

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "labeled_wallets.json"


def _wallets() -> list[LabeledWallet]:
    return load_labeled_wallets(FIXTURE)


def test_loads_fixture_schema() -> None:
    wallets = _wallets()
    assert len(wallets) == 2
    smart = wallets[0]
    assert "smart-money" in smart.labels
    # Amounts parse as exact Decimal.
    assert smart.trades[0].base_amount == Decimal("1000000")
    assert smart.trades[0].price is None  # optional; derived downstream


def test_full_history_keeps_wins_and_losses() -> None:
    trajectories = build_trajectories_for(_wallets())
    outcomes = Counter(t.outcome for t in trajectories)
    # 3 wins (TOK_WIN, TOK_SCALE, TOK_MULTI ep2), 2 losses (TOK_LOSS, TOK_MULTI ep1), 1 open.
    assert outcomes["win"] == 3
    assert outcomes["loss"] == 2
    assert outcomes["open"] == 1
    # Losing episodes are first-class, not filtered out.
    assert any(t.outcome == "loss" for t in trajectories)


def test_win_episode_realized_pnl() -> None:
    smart = _wallets()[0]
    trajectories = build_trajectories(smart)
    win = next(t for t in trajectories if t.mint.startswith("TokWIN"))
    assert win.outcome == "win"
    assert win.realized_pnl_quote == Decimal("1.0")
    assert win.quote_invested == Decimal("1.0")
    assert win.quote_returned == Decimal("2.0")
    assert [s.intent for s in win.steps] == [Intent.OPEN_LONG, Intent.CLOSE]
    assert [s.side for s in win.steps] == [Side.BUY, Side.SELL]


def test_loss_episode_realized_pnl() -> None:
    smart = _wallets()[0]
    loss = next(t for t in build_trajectories(smart) if t.mint.startswith("TokLOSS"))
    assert loss.outcome == "loss"
    assert loss.realized_pnl_quote == Decimal("-1.0")


def test_scale_in_uses_average_cost() -> None:
    smart = _wallets()[0]
    scale = next(t for t in build_trajectories(smart) if t.mint.startswith("TokSCALE"))
    assert [s.intent for s in scale.steps] == [Intent.OPEN_LONG, Intent.ADD, Intent.CLOSE]
    # avg cost after two buys = (1.0 + 3.0) / 200000; sell 200000 @ 5.0 -> realized +1.0.
    assert scale.realized_pnl_quote == Decimal("1.0")
    # Derived price on the first buy (fixture leaves price null).
    assert scale.steps[0].price == Decimal("1.0") / Decimal("100000")


def test_open_episode_is_not_scored_as_win_or_loss() -> None:
    smart = _wallets()[0]
    open_traj = next(t for t in build_trajectories(smart) if t.mint.startswith("TokOPEN"))
    assert open_traj.outcome == "open"
    assert open_traj.realized_pnl_quote == Decimal(0)  # realized-only: no unrealized mark
    assert open_traj.quote_invested == Decimal("0.5")
    assert open_traj.steps[-1].base_qty_after > 0  # residual position remains


def test_multi_episode_same_token_splits() -> None:
    bot = _wallets()[1]
    trajectories = build_trajectories(bot)
    # One token, two full round trips -> two episodes.
    assert len(trajectories) == 2
    assert {t.outcome for t in trajectories} == {"loss", "win"}


def test_load_accepts_bare_list_and_mapping() -> None:
    payload = {
        "wallets": [
            {"wallet": "W", "labels": ["bot"], "trades": []},
        ]
    }
    assert len(load_labeled_wallets(payload)) == 1
    assert len(load_labeled_wallets(payload["wallets"])) == 1
