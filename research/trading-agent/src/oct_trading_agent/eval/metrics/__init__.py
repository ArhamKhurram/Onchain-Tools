"""eval/metrics — risk-adjusted + distributional metrics (paper §8.3).

Sharpe/Sortino, CVaR/drawdown, per-token edge vs baselines (hold-SOL, buy-and-hold) and vs the
labeled-trader cohort — all AFTER realistic costs, computed from the realized ledger.
"""

from __future__ import annotations

from .battery import (
    MetricReport,
    compute_metrics,
    cvar,
    max_drawdown,
    sharpe,
    sortino,
)

__all__ = [
    "MetricReport",
    "compute_metrics",
    "cvar",
    "max_drawdown",
    "sharpe",
    "sortino",
]
