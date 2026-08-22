"""Cost-inclusive position accounting — realized PnL only (paper §3.5.4).

A mutable per-mint book that folds fills into a running position. The invariants that matter:

* **Cost-inclusive average entry.** A buy's average entry price absorbs the buy-side network gas
  and any MEV penalty, so realized PnL on the eventual sell is net of *all* costs to acquire.
* **Realized only.** PnL is booked only when base leaves the position (a sell). ``mark_price`` is
  snapshotted for reporting from the pool mid and is NEVER folded into any realized figure — the
  wall between them is what stops a reward path from crediting unrealized/peak PnL.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from oct_trading_agent.core import Fill, Mint, PositionState


class PositionBook:
    """Mutable running position for one mint. Snapshots to the frozen ``PositionState`` contract."""

    def __init__(self, mint: Mint) -> None:
        self.mint = mint
        self.base_qty = Decimal(0)
        self.avg_entry_price: Decimal | None = None  # cost-inclusive quote per base
        self.realized_pnl_quote = Decimal(0)
        self.opened_at: datetime | None = None

    def apply_buy(self, fill: Fill, when: datetime) -> Decimal:
        """Fold a successful buy. Returns realized PnL booked this step (always 0 for a buy)."""
        total_cost = fill.quote_amount + fill.fee_quote + fill.mev_penalty_quote
        if self.base_qty <= 0 or self.avg_entry_price is None:
            self.avg_entry_price = total_cost / fill.base_amount
            self.base_qty = fill.base_amount
            self.opened_at = when
        else:
            prior_cost = self.avg_entry_price * self.base_qty
            self.base_qty += fill.base_amount
            self.avg_entry_price = (prior_cost + total_cost) / self.base_qty
        return Decimal(0)

    def apply_sell(self, fill: Fill) -> Decimal:
        """Fold a successful sell. Returns realized PnL booked this step (proceeds - cost basis)."""
        proceeds_net = fill.quote_amount - fill.fee_quote - fill.mev_penalty_quote
        basis = (self.avg_entry_price or Decimal(0)) * fill.base_amount
        realized = proceeds_net - basis
        self.realized_pnl_quote += realized
        self.base_qty -= fill.base_amount
        if self.base_qty <= 0:
            self.base_qty = Decimal(0)
            self.avg_entry_price = None
            self.opened_at = None
        return realized

    def snapshot(self, mark_price: Decimal | None) -> PositionState:
        """Frozen ``PositionState`` for a step result. ``mark_price`` is reporting-only."""
        return PositionState(
            mint=self.mint,
            base_qty=self.base_qty,
            avg_entry_price=self.avg_entry_price,
            realized_pnl_quote=self.realized_pnl_quote,
            opened_at=self.opened_at,
            mark_price=mark_price if self.base_qty > 0 else None,
        )
