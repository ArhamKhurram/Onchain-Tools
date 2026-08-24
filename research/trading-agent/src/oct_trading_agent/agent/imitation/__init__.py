"""agent/imitation — BC warm-start from labeled traders (02 §2 (4); paper §2.4, §6.2).

Warm-start from real tracked traders' **full win-and-loss** histories (pulled by
``data/labeling``), then let PPO (``agent/online``) fine-tune. This is the seam that stops the
from-scratch degenerate collapse (always-buy / always-hold) the Phase-1 learner fell into.

* :mod:`.demos` — reconstruct traders' episodes into env-aligned (observation, expert-action)
  demonstrations (pure numpy, no torch).
* :mod:`.bc` — behavioral-clone the ``HybridActorCritic`` on those demonstrations (torch, ``learn``
  extra).
* :mod:`.cohort` — the bounded end-to-end report: pull a cohort, build demos, BC, and judge whether
  the cloned policy actually trades.

GAIL/AIRL + DAgger corrections remain future work; BC is the warm-start the offline/imitation phase
calls for.
"""

from __future__ import annotations

from .demos import (
    CohortAction,
    DemoConfig,
    DemoDataset,
    DemoStep,
    build_cohort_action_tape,
    build_cohort_tape,
    build_demos,
    demo_matrices,
    intent_distribution,
)

__all__ = [
    "CohortAction",
    "DemoConfig",
    "DemoDataset",
    "DemoStep",
    "build_cohort_action_tape",
    "build_cohort_tape",
    "build_demos",
    "demo_matrices",
    "intent_distribution",
]
