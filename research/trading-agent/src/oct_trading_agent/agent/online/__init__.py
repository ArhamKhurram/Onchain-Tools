"""agent/online — PPO fine-tune against the sim + on-policy rollout machinery (paper §6.6).

Phase 1 ships the online PPO loop: the pure-numpy :class:`RolloutBuffer` (GAE-λ + λ-returns) and
:class:`RunningNormalizer` (causal, missing-aware obs standardization) run in the base suite; the
torch :func:`collect_rollouts` and :class:`PPOTrainer` require the ``learn`` extra. Recent-window
replay weighting and the curated anti-forgetting core set (paper §6.6) are the next enhancement.
"""

from __future__ import annotations

from .buffer import RolloutBatch, RolloutBuffer, Transition
from .collect import collect_rollouts
from .normalize import NormalizerState, RunningNormalizer
from .ppo import PPOConfig, PPOTrainer, PPOUpdateStats

# collect.py / ppo.py import torch under a guard, so they import cleanly in a lean install; the
# functions/classes only raise (with a clear pointer to `uv sync --extra learn`) when actually used.
__all__ = [
    "NormalizerState",
    "PPOConfig",
    "PPOTrainer",
    "PPOUpdateStats",
    "RolloutBatch",
    "RolloutBuffer",
    "RunningNormalizer",
    "Transition",
    "collect_rollouts",
]
