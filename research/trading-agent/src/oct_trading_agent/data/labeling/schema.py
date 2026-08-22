"""Labeling contracts — the FIXTURE schema (input) and the demonstration trajectory (output).

The **input** side (:class:`LabeledWallet` / :class:`LabeledTrade`) is the schema the Phase-1
labeled-wallet DB must satisfy. It is deliberately defined here, in code, against a documented
fixture so Phase 0 can build and test the whole reconstruction pipeline **without** the real DB:
when Phase 1 begins, only the loader source changes (swap :func:`~.fixtures.load_labeled_wallets`
for a DB-backed loader that yields the same :class:`LabeledWallet`\\ s). See 03 §Phase 0 and
04-data-spec §1.2.

The **output** side (:class:`DemonstrationStep` / :class:`DemonstrationTrajectory`) is a labeled
trader's history reconstructed into per-token episodes usable as imitation/IRL demonstrations
(Phase 1 warm-start). Crucially it keeps the trader's **full win-and-loss** record — losing
episodes are first-class, not filtered — which is what defuses survivorship bias (04-data-spec
§1.2, paper §9.3). All PnL is **realized only** (paper §3.5.4): an episode that never fully exits
is marked ``open`` and its realized figure covers only the parts actually sold — no unrealized/peak
PnL is ever invented.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import Field

from oct_trading_agent.core import Mint, Wallet
from oct_trading_agent.core.base import Frozen
from oct_trading_agent.core.enums import Intent, Side

TrajectoryOutcome = Literal["win", "loss", "flat", "open"]


class LabeledTrade(Frozen):
    """One realized on-chain trade by a labeled wallet (FIXTURE / Phase-1-DB input row).

    Amounts are UI units; ``quote_amount`` is the SOL/quote leg. ``price`` is optional (derivable
    as ``quote_amount / base_amount`` when absent). Losses are included — this is the wallet's
    *full* history, not a hindsight-selected winner set (04-data-spec leakage rule 7).
    """

    timestamp: datetime
    mint: Mint
    side: Side
    base_amount: Decimal = Field(ge=0, description="Tracked-token amount (UI units).")
    quote_amount: Decimal = Field(ge=0, description="Quote/SOL amount (UI units).")
    price: Decimal | None = Field(default=None, ge=0, description="Quote per base; else derived.")
    signature: str | None = None


class LabeledWallet(Frozen):
    """A labeled trader and their full trade history (FIXTURE / Phase-1-DB input record)."""

    wallet: Wallet
    labels: list[str] = Field(
        default_factory=list, description="e.g. smart-money, fresh, bot, creator (04-data-spec §1.2)."
    )
    trades: list[LabeledTrade] = Field(default_factory=list)


class DemonstrationStep(Frozen):
    """One step of a demonstration trajectory: the action the trader took and its realized result.

    ``intent`` is the discrete :class:`~oct_trading_agent.core.enums.Intent` inferred from the trade
    side and the running position (OPEN_LONG / ADD / TRIM / CLOSE — long-only alpha). ``base_qty_after``
    is the position size after this step; ``realized_pnl_quote`` is realized on THIS step (0 unless a
    sell booked against cost basis).
    """

    timestamp: datetime
    side: Side
    intent: Intent
    base_amount: Decimal = Field(ge=0)
    quote_amount: Decimal = Field(ge=0)
    price: Decimal = Field(ge=0, description="Realized quote per base on this step.")
    base_qty_after: Decimal = Field(ge=0)
    avg_cost_after: Decimal | None = Field(default=None, ge=0)
    realized_pnl_quote: Decimal = Field(default=Decimal(0))
    signature: str | None = None


class DemonstrationTrajectory(Frozen):
    """A labeled wallet's per-token episode, from first entry to full exit (or end-of-data).

    ``outcome`` classifies the realized result: ``win``/``loss``/``flat`` for a fully-exited
    episode, or ``open`` when a residual position remained at end-of-data (realized figure then
    covers only the sold portion — never an unrealized mark).
    """

    wallet: Wallet
    mint: Mint
    labels: list[str] = Field(default_factory=list)
    started_at: datetime
    ended_at: datetime
    steps: list[DemonstrationStep] = Field(default_factory=list)
    realized_pnl_quote: Decimal = Field(default=Decimal(0))
    quote_invested: Decimal = Field(default=Decimal(0), description="Total quote spent buying.")
    quote_returned: Decimal = Field(default=Decimal(0), description="Total quote received selling.")
    outcome: TrajectoryOutcome = "flat"


__all__ = [
    "LabeledTrade",
    "LabeledWallet",
    "DemonstrationStep",
    "DemonstrationTrajectory",
    "TrajectoryOutcome",
]
