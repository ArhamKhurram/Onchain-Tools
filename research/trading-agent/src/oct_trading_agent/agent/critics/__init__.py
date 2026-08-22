"""agent/critics — distributional critics (C51/QR-DQN/IQN), CVaR objectives (paper §6.3).

Fat-tailed new-pair returns require a distribution, not a scalar value: the sizing head reads a
risk measure (CVaR) off the critic. Output shape is
:class:`~oct_trading_agent.core.decision.ValueDistribution` (mean() and cvar() already implemented).

Phase 1 ships the **quantile** critic (:mod:`.quantile`) — a QR-DQN-style distributional value head
regressed with the quantile-Huber loss, plus the pure-numpy risk measures (``distribution_mean``,
``distribution_cvar``, ``risk_blended_value``) the PPO loop reads. The torch pieces
(:class:`QuantileValueHead`, :func:`quantile_huber_loss`) require the ``learn`` extra; the numpy
helpers run in the base suite.
"""

from __future__ import annotations

from .quantile import (
    TORCH_AVAILABLE,
    distribution_cvar,
    distribution_mean,
    quantile_levels,
    risk_blended_value,
    to_value_distribution,
)

__all__ = [
    "TORCH_AVAILABLE",
    "distribution_cvar",
    "distribution_mean",
    "quantile_levels",
    "risk_blended_value",
    "to_value_distribution",
]

if TORCH_AVAILABLE:
    from .quantile import QuantileValueHead, quantile_huber_loss

    __all__ += ["QuantileValueHead", "quantile_huber_loss"]
