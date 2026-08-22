"""Reconstruct labeled wallets' full histories into per-token demonstration trajectories.

Algorithm (average-cost basis, long-only):

* Sort a wallet's trades by time, group by token.
* Walk each token's trades maintaining ``base_qty`` and ``avg_cost`` (quote per base):
  - **BUY** raises the position; ``avg_cost`` is the running quote-weighted average. Intent is
    ``OPEN_LONG`` from flat, else ``ADD``.
  - **SELL** books realized PnL against ``avg_cost`` (``proceeds - avg_cost * sold_base``) and
    lowers the position. Intent is ``CLOSE`` when it empties the position (within dust), else
    ``TRIM``. A sell with no cost basis (received/airdropped tokens) books full proceeds as PnL.
* An **episode** opens when the position leaves flat and closes when it returns to flat (full
  exit). Each closed episode is one :class:`DemonstrationTrajectory` classified win/loss/flat by
  its realized PnL. A residual position at end-of-data yields a final ``open`` trajectory whose
  realized figure covers only the sold portion (realized-only rule — no unrealized mark).

Every episode — winner **and** loser — is emitted; nothing is hindsight-filtered (04-data-spec
§1.2 / leakage rule 7).
"""

from __future__ import annotations

from collections import defaultdict
from decimal import Decimal

from oct_trading_agent.core.enums import Intent, Side

from .schema import (
    DemonstrationStep,
    DemonstrationTrajectory,
    LabeledTrade,
    LabeledWallet,
    TrajectoryOutcome,
)

# A position at or below this fraction of the episode's peak size counts as fully exited
# (guards against sell rounding leaving a nonzero-but-meaningless dust balance).
_DUST_FRACTION = Decimal("1e-9")


def _trade_price(trade: LabeledTrade) -> Decimal:
    if trade.price is not None and trade.price > 0:
        return trade.price
    if trade.base_amount > 0:
        return trade.quote_amount / trade.base_amount
    return Decimal(0)


class _EpisodeBuilder:
    """Accumulates steps for one open episode of a single token."""

    def __init__(self, wallet: str, mint: str, labels: list[str]) -> None:
        self.wallet = wallet
        self.mint = mint
        self.labels = labels
        self.steps: list[DemonstrationStep] = []
        self.base_qty = Decimal(0)
        self.avg_cost = Decimal(0)
        self.peak_base = Decimal(0)
        self.quote_invested = Decimal(0)
        self.quote_returned = Decimal(0)
        self.realized = Decimal(0)

    def is_open(self) -> bool:
        return self.base_qty > self.peak_base * _DUST_FRACTION

    def add_buy(self, trade: LabeledTrade) -> None:
        price = _trade_price(trade)
        total_cost = self.avg_cost * self.base_qty + trade.quote_amount
        new_qty = self.base_qty + trade.base_amount
        intent = Intent.ADD if self.base_qty > 0 else Intent.OPEN_LONG
        self.base_qty = new_qty
        self.avg_cost = (total_cost / new_qty) if new_qty > 0 else Decimal(0)
        self.peak_base = max(self.peak_base, self.base_qty)
        self.quote_invested += trade.quote_amount
        self._record(trade, intent, price, Decimal(0))

    def add_sell(self, trade: LabeledTrade) -> None:
        price = _trade_price(trade)
        sold_base = min(trade.base_amount, self.base_qty) if self.base_qty > 0 else Decimal(0)
        if sold_base > 0:
            # Proceeds are attributed pro-rata to the actually-sold base (caps oversell dust).
            proceeds = trade.quote_amount * (sold_base / trade.base_amount) if trade.base_amount > 0 else trade.quote_amount
            realized = proceeds - self.avg_cost * sold_base
            self.base_qty -= sold_base
        else:
            # No cost basis (received/airdropped tokens sold): full proceeds are realized.
            proceeds = trade.quote_amount
            realized = proceeds
        self.quote_returned += proceeds
        self.realized += realized
        closed = self.base_qty <= self.peak_base * _DUST_FRACTION
        intent = Intent.CLOSE if closed else Intent.TRIM
        if closed:
            self.base_qty = Decimal(0)
        self._record(trade, intent, price, realized)

    def _record(
        self, trade: LabeledTrade, intent: Intent, price: Decimal, realized: Decimal
    ) -> None:
        self.steps.append(
            DemonstrationStep(
                timestamp=trade.timestamp,
                side=trade.side,
                intent=intent,
                base_amount=trade.base_amount,
                quote_amount=trade.quote_amount,
                price=price,
                base_qty_after=self.base_qty,
                avg_cost_after=self.avg_cost if self.base_qty > 0 else None,
                realized_pnl_quote=realized,
                signature=trade.signature,
            )
        )

    def build(self, *, still_open: bool) -> DemonstrationTrajectory:
        outcome: TrajectoryOutcome
        if still_open:
            outcome = "open"
        elif self.realized > 0:
            outcome = "win"
        elif self.realized < 0:
            outcome = "loss"
        else:
            outcome = "flat"
        return DemonstrationTrajectory(
            wallet=self.wallet,
            mint=self.mint,
            labels=list(self.labels),
            started_at=self.steps[0].timestamp,
            ended_at=self.steps[-1].timestamp,
            steps=self.steps,
            realized_pnl_quote=self.realized,
            quote_invested=self.quote_invested,
            quote_returned=self.quote_returned,
            outcome=outcome,
        )


def build_trajectories(wallet: LabeledWallet) -> list[DemonstrationTrajectory]:
    """Reconstruct one labeled wallet's full history into per-token demonstration trajectories.

    Emits every episode — wins and losses alike — plus a trailing ``open`` trajectory per token that
    still holds a residual position at end-of-data.
    """
    by_token: dict[str, list[LabeledTrade]] = defaultdict(list)
    for trade in wallet.trades:
        by_token[trade.mint].append(trade)

    trajectories: list[DemonstrationTrajectory] = []
    for mint, trades in by_token.items():
        ordered = sorted(trades, key=lambda t: t.timestamp)
        builder: _EpisodeBuilder | None = None
        for trade in ordered:
            if builder is None:
                builder = _EpisodeBuilder(wallet.wallet, mint, wallet.labels)
            if trade.side is Side.BUY:
                builder.add_buy(trade)
            else:
                builder.add_sell(trade)
            if not builder.is_open():
                trajectories.append(builder.build(still_open=False))
                builder = None
        if builder is not None:  # residual open position at end-of-data
            trajectories.append(builder.build(still_open=True))

    trajectories.sort(key=lambda t: (t.started_at, t.mint))
    return trajectories


def build_trajectories_for(
    wallets: list[LabeledWallet],
) -> list[DemonstrationTrajectory]:
    """Reconstruct trajectories across many wallets (flattened, order-stable)."""
    out: list[DemonstrationTrajectory] = []
    for wallet in wallets:
        out.extend(build_trajectories(wallet))
    return out


__all__ = ["build_trajectories", "build_trajectories_for"]
