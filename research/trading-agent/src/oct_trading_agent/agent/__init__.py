"""agent/ — the RL training core + policy (02 §2 (4), §6).

Responsibility: turn causal feature bundles into typed decisions and learn to do so well —
offline pretrain (IQL/CQL) → distributional critic → online PPO fine-tune, warm-started by
imitation from labeled traders, bred as a diverse population (PBT/ES/MAP-Elites), kept current by
a continual-learning loop.

Subpackages: encoders (per-token → cross-token context; the co-trained trade-flow attention encoder),
policies (hybrid discrete-continuous actor heads), critics (distributional C51/QR-DQN/IQN, CVaR),
offline, imitation, online, population, continual.

Contracts (AgentDecision, ValueDistribution, SignalContribution, Policy) live in
:mod:`oct_trading_agent.core.decision`; the attention state in
:mod:`oct_trading_agent.core.attention`.

TODO(Wave-1: agent agent): implement the encoder + policy + distributional critic behind
``core.decision.Policy``. Ships a ``HoldPolicy`` stub today for the vertical slice.
"""

from __future__ import annotations

from .policies import HoldPolicy

__all__ = ["HoldPolicy"]
