"""agent/online — PPO fine-tune + prioritized recency buffer (02 §2 (4); paper §6.6).

Online fine-tune against the sim with a prioritized, recency-weighted replay buffer + a curated
core set. This is where the encoder co-training (agent's own interaction stream) actually happens.

TODO(Wave-1: agent agent): implement the PPO loop + prioritized recency buffer.
"""

from __future__ import annotations
