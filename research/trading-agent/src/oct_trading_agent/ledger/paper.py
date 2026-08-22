"""``PaperLedger`` — the concrete cost-inclusive paper-trading ledger.

Applies each :class:`~oct_trading_agent.core.sim.SimStepResult` to a running quote (SOL) balance and
appends a dated :class:`~oct_trading_agent.core.ledger.LedgerEntry`. Balance mechanics (the AMM/LP
fee is already embedded in ``quote_amount`` — see ``sim/amm/curve.py`` — so only network gas + MEV
are added on top):

* **Buy**  (``OPEN_LONG``/``ADD``):  ``balance -= quote_amount + fee_quote + mev_penalty_quote``
* **Sell** (``TRIM``/``CLOSE``):     ``balance += quote_amount - fee_quote - mev_penalty_quote``
* **No-op / failed** (no base moved): ``balance -= fee_quote`` (a failed tx still burns gas)

``realized_pnl_quote`` is copied straight from the sim step (booked on sells only, cost-inclusive);
the ledger never derives PnL from ``mark_price`` (paper §3.5.4). An :class:`Episode` accumulates
entries until :meth:`close_episode`; a terminal step marks the open episode's terminal reason so the
close finalizes it correctly. A record after a terminal step opens a fresh episode for that mint.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

from oct_trading_agent.core import (
    Episode,
    Fill,
    Intent,
    LedgerEntry,
    Mint,
    SimStepResult,
    TerminalReason,
)

_BUY_INTENTS = frozenset({Intent.OPEN_LONG, Intent.ADD})
_SELL_INTENTS = frozenset({Intent.TRIM, Intent.CLOSE})


@dataclass
class _OpenEpisode:
    episode_id: str
    mint: Mint
    started_at: datetime
    entries: list[LedgerEntry] = field(default_factory=list)
    realized_pnl_quote: Decimal = Decimal(0)
    terminal_reason: TerminalReason | None = None
    ended_at: datetime | None = None


class PaperLedger:
    """In-memory paper ledger. Satisfies ``ledger.LedgerProtocol``."""

    def __init__(self, initial_balance_quote: Decimal = Decimal(0)) -> None:
        self.initial_balance_quote = initial_balance_quote
        self.balance_quote = initial_balance_quote
        self._open: dict[Mint, _OpenEpisode] = {}
        self._seq: dict[Mint, int] = {}

    # -- protocol -----------------------------------------------------------------------------

    def record(self, mint: Mint, result: SimStepResult, timestamp: datetime) -> LedgerEntry:
        """Book one sim step; update the running balance and append the entry to its episode."""
        fill = result.fill
        self.balance_quote += self._balance_delta(fill.intent, fill)

        entry = LedgerEntry(
            timestamp=timestamp,
            mint=mint,
            intent=fill.intent,
            fill=fill,
            realized_pnl_quote=result.realized_pnl_quote,
            balance_after_quote=self.balance_quote,
        )

        episode = self._episode_for(mint, timestamp)
        episode.entries.append(entry)
        episode.realized_pnl_quote += result.realized_pnl_quote
        if result.terminal:
            episode.terminal_reason = result.terminal_reason
            episode.ended_at = timestamp
        return entry

    def close_episode(self, mint: Mint) -> Episode:
        """Finalize and return the mint's open episode. Raises if none is open."""
        episode = self._open.pop(mint, None)
        if episode is None:
            raise KeyError(f"no open episode for mint {mint!r}")
        ended_at = episode.ended_at
        if ended_at is None and episode.entries:
            ended_at = episode.entries[-1].timestamp
        return Episode(
            episode_id=episode.episode_id,
            mint=episode.mint,
            started_at=episode.started_at,
            ended_at=ended_at,
            entries=list(episode.entries),
            terminal_reason=episode.terminal_reason,
            realized_pnl_quote=episode.realized_pnl_quote,
        )

    # -- introspection ------------------------------------------------------------------------

    def open_episode(self, mint: Mint) -> Episode | None:
        """A read-only snapshot of the mint's in-progress episode (None if none open)."""
        episode = self._open.get(mint)
        if episode is None:
            return None
        return Episode(
            episode_id=episode.episode_id,
            mint=episode.mint,
            started_at=episode.started_at,
            ended_at=episode.ended_at,
            entries=list(episode.entries),
            terminal_reason=episode.terminal_reason,
            realized_pnl_quote=episode.realized_pnl_quote,
        )

    # -- internals ----------------------------------------------------------------------------

    @staticmethod
    def _balance_delta(intent: Intent, fill: Fill) -> Decimal:
        net_cost = fill.fee_quote + fill.mev_penalty_quote
        if intent in _BUY_INTENTS:
            return -(fill.quote_amount + net_cost)
        if intent in _SELL_INTENTS:
            return fill.quote_amount - net_cost
        # NO_OP / HOLD: nothing traded; only gas (usually zero) is burned.
        return -fill.fee_quote

    def _episode_for(self, mint: Mint, timestamp: datetime) -> _OpenEpisode:
        existing = self._open.get(mint)
        if existing is not None and existing.terminal_reason is None:
            return existing
        # No open episode, or the previous one already terminated -> start a fresh episode.
        seq = self._seq.get(mint, 0)
        self._seq[mint] = seq + 1
        episode = _OpenEpisode(
            episode_id=f"{mint}:{seq}",
            mint=mint,
            started_at=timestamp,
        )
        self._open[mint] = episode
        return episode
