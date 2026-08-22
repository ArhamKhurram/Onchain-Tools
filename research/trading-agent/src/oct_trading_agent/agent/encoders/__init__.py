"""agent/encoders — per-token encoder → cross-token context; the trade-flow attention encoder.

The Phase-B representation is the trade-flow attention encoder (paper §4.4), which compresses the
swap tape into an :class:`~oct_trading_agent.core.attention.AttentionState`.

CODEPENDENT TRAINING (load-bearing, paper §4.4): the encoder is co-trained end-to-end with the
policy — after SSL pretraining it stays UNFROZEN and RL gradients flow into it alongside a standing
self-supervised loss. A STOP-GRADIENT copy of the SSL representation feeds convergence/alerts, so
the shared signal stays flow-derived and independent of the agent's objective. It is NOT a frozen
feed-forward encoder.

TODO(Wave-1: agent agent): implement the encoder + the Hawkes-distillation SSL objective + the
stop-gradient boundary for the convergence copy.
"""

from __future__ import annotations
