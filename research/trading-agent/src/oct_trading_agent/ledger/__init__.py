"""ledger/ — the paper-trading ledger (02 §2 (4); paper §3.4).

Responsibility: book realized, cost-inclusive results — the ground truth every metric and reward
reads. Records ``LedgerEntry`` rows and closes ``Episode`` objects (both in
:mod:`oct_trading_agent.core.ledger`).

TODO(Wave-1: sim/eval agent): implement ``PaperLedger`` — apply a ``SimStepResult`` to the running
balance, book realized PnL (never unrealized), and close episodes at their terminal.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from oct_trading_agent.core import Episode, LedgerEntry, Mint, SimStepResult


@runtime_checkable
class PaperLedger(Protocol):
    """Cost-correct paper-trading ledger interface."""

    def record(self, mint: Mint, result: SimStepResult) -> LedgerEntry:
        """Book one sim step; update the running balance from realized PnL + fees."""
        ...

    def close_episode(self, mint: Mint) -> Episode:
        """Finalize and return the token's episode."""
        ...
