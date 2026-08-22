"""sim/replay — recent-window replay + frozen regime battery (02 §2 (3)).

Recent-window replay (rolling past few days) is the default, with a retained older core set for
anti-forgetting and a frozen regime battery for re-eval. This is where episodes are driven through
the ``Simulator``.

Public surface:
    * ``simulator`` — ``ReplaySimulator`` (implements ``core.sim.Simulator``) + ``SimConfig``.
    * ``driver``    — ``RecentWindowReplay`` (the rolling-window default driver).
    * ``position``  — ``PositionBook`` (cost-inclusive, realized-only accounting).
"""

from __future__ import annotations

from .driver import DEFAULT_WINDOW, RecentWindowReplay
from .position import PositionBook
from .simulator import ReplaySimulator, SimConfig

__all__ = [
    "ReplaySimulator",
    "SimConfig",
    "RecentWindowReplay",
    "DEFAULT_WINDOW",
    "PositionBook",
]
