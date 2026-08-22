"""eval/walkforward — time-ordered splits only (03 governing rules; paper §8.5).

Walk-forward ONLY — never random splits. Held-out time periods AND held-out tokens. Random
k-fold over time-series is the classic way a trading backtest lies; this module makes the correct
split the only one available.
"""

from __future__ import annotations

from .splits import (
    TimeSplit,
    TokenHoldout,
    TokenSpan,
    assert_time_ordered,
    token_time_holdout,
    walk_forward_time_splits,
)

__all__ = [
    "TimeSplit",
    "TokenHoldout",
    "TokenSpan",
    "assert_time_ordered",
    "token_time_holdout",
    "walk_forward_time_splits",
]
