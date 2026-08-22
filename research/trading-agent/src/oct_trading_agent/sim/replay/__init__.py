"""sim/replay — recent-window replay + frozen regime battery (02 §2 (3)).

Recent-window replay (rolling past few days) is the default, with a retained older core set for
anti-forgetting and a frozen regime battery for re-eval. This is where episodes are driven through
the ``Simulator``.

TODO(Wave-1: sim agent): implement the replay driver (per-token + per-session episodes, paper §3.4)
over the append-only log, honoring walk-forward time splits only.
"""

from __future__ import annotations
