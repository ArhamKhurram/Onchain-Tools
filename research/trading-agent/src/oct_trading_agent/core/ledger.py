"""Episode + paper-trading ledger contracts (02 §2 (4), paper §3.4).

The ledger books realized, cost-inclusive results — the ground truth every downstream metric
and reward reads (paper §3.5.2 class 2). ``Episode`` is the per-token unit (paper §3.4): it runs
from watchlist entry to a natural terminal (full exit / token death / liquidity floor / rug),
under a single generous ~3-day hard cap that bounds compute and does NOT shape behavior.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from pydantic import Field

from .base import Frozen
from .enums import Intent, TerminalReason
from .sim import Fill
from .tape import Mint


class LedgerEntry(Frozen):
    """One booked step in the paper ledger: an intent, its fill, and the balance after.

    ``realized_pnl_quote`` is realized only (never unrealized/peak, paper §3.5.4).
    ``balance_after_quote`` is the running paper balance in quote/SOL after this fill's costs.
    """

    timestamp: datetime
    mint: Mint
    intent: Intent
    fill: Fill
    realized_pnl_quote: Decimal = Field(default=Decimal(0))
    balance_after_quote: Decimal


class Episode(Frozen):
    """A per-token episode: an ordered list of ledger entries and its terminal outcome."""

    episode_id: str
    mint: Mint
    started_at: datetime
    ended_at: datetime | None = None
    entries: list[LedgerEntry] = Field(default_factory=list)
    terminal_reason: TerminalReason | None = None
    realized_pnl_quote: Decimal = Field(
        default=Decimal(0), description="Total realized PnL over the episode (sum of entries)."
    )
