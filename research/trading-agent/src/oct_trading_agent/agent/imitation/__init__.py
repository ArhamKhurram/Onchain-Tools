"""agent/imitation — BC, GAIL/AIRL, DAgger corrections (02 §2 (4); paper §6.5).

Warm-start from labeled traders (full win-and-loss histories from ``data/labeling``), then RL to
surpass via the benchmark-relative reward.

TODO(Wave-1: agent agent): implement behavioral cloning + adversarial imitation over the
demonstration trajectories.
"""

from __future__ import annotations
