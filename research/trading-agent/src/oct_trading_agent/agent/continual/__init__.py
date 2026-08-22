"""agent/continual — regime detection, meta-adaptation, anti-forgetting (02 §2 (4); paper §6.6).

Always-on regime detection, fast meta-adaptation, EWC-style anti-forgetting, and a frozen-regime
re-eval battery — the self-feeding continual-learning loop that keeps the policy current under
non-stationarity.

TODO(Wave-2: continual agent): implement regime detection + EWC + the frozen-regime battery.
"""

from __future__ import annotations
