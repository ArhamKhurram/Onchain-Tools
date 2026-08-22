"""agent/critics — distributional critics (C51/QR-DQN/IQN), CVaR objectives (paper §6.3).

Fat-tailed new-pair returns require a distribution, not a scalar value: the sizing head reads a
risk measure (CVaR) off the critic. Output shape is
:class:`~oct_trading_agent.core.decision.ValueDistribution` (mean() and cvar() already implemented).

TODO(Wave-1: agent agent): implement the distributional critic heads on the shared encoder.
"""

from __future__ import annotations
