"""eval/ — the evaluation battery (02 §2, §6; 05-evaluation-plan.md).

Responsibility: measure edge honestly — risk-adjusted + distributional metrics, walk-forward-only
time splits, per-tier + leakage-guard + convergence ablations, and the backtest→paper→live
promotion gate. Pre-registered metrics; no post-hoc goalpost moves (03 governing rules).

Subpackages: metrics (Sharpe/Sortino/CVaR/drawdown/per-token edge), walkforward (time-ordered
splits only), ablations (per-tier + leakage-guard + convergence A/B), gate (promotion ladder).

TODO(Wave-1: eval agent): implement the metrics + walk-forward harness first (Phase 1 needs them).
"""

from __future__ import annotations
