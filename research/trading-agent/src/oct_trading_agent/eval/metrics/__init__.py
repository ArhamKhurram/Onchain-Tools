"""eval/metrics — risk-adjusted + distributional metrics (paper §8.3).

Sharpe/Sortino, CVaR/drawdown, per-token edge vs baselines (hold-SOL, buy-and-hold) and vs the
labeled-trader cohort — all AFTER realistic costs, computed from the realized ledger.

TODO(Wave-1: eval agent): implement the metric functions over ``core.ledger`` entries/episodes.
"""

from __future__ import annotations
