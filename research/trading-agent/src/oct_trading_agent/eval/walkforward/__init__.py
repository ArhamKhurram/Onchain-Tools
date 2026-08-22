"""eval/walkforward — time-ordered splits only (03 governing rules; paper §8.5).

Walk-forward ONLY — never random splits. Held-out time periods AND held-out tokens. Random
k-fold over time-series is the classic way a trading backtest lies; this module makes the correct
split the only one available.

TODO(Wave-1: eval agent): implement the walk-forward split generator + harness.
"""

from __future__ import annotations
