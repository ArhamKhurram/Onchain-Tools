"""ledger/ — the paper-trading ledger (02 §2 (4); paper §3.4).

Responsibility: book realized, cost-inclusive results — the ground truth every metric and reward
reads. Records ``LedgerEntry`` rows and closes ``Episode`` objects (both in
:mod:`oct_trading_agent.core.ledger`).

Two names live here:
    * ``LedgerProtocol`` — the minimal interface ``eval``/``agent`` depend on.
    * ``PaperLedger``    — the concrete in-memory implementation (``paper.py``).

A ``LedgerEntry`` carries a ``timestamp`` that a ``SimStepResult`` does not, so ``record`` takes the
decision instant explicitly (a small, deliberate refinement of the scaffold stub — the ledger cannot
book a dated row without the date). Realized only — no reward path may read ``mark_price`` (§3.5.4).
"""

from __future__ import annotations

from datetime import datetime
from typing import Protocol, runtime_checkable

from oct_trading_agent.core import Episode, LedgerEntry, Mint, SimStepResult

from .paper import PaperLedger


@runtime_checkable
class LedgerProtocol(Protocol):
    """Cost-correct paper-trading ledger interface."""

    def record(self, mint: Mint, result: SimStepResult, timestamp: datetime) -> LedgerEntry:
        """Book one sim step at ``timestamp``; update the running balance from fill costs."""
        ...

    def close_episode(self, mint: Mint) -> Episode:
        """Finalize and return the token's episode."""
        ...


__all__ = ["LedgerProtocol", "PaperLedger"]
