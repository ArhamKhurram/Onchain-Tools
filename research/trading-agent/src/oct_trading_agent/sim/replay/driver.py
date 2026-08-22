"""Recent-window replay driver — the default episode driver (02 §2 (3)).

Recent-window replay (a rolling ~past-few-days tape) is the default training regime, with a retained
older core set for anti-forgetting and a frozen regime battery for re-eval (both out of Phase-0
scope; this is the rolling-window default). It selects the mints active in the window and, per mint,
the causal sequence of decision instants a policy may act on — then hands each ``(mint, as_of)`` to a
:class:`~oct_trading_agent.sim.replay.simulator.ReplaySimulator`.

The driver is deliberately policy-agnostic: it produces decision *points* and owns the simulator;
the agent (a parallel wave) owns turning a feature bundle into an :class:`~oct_trading_agent.core.sim.Order`.
Walk-forward only — decision times are strictly time-ordered and never look past ``as_of``.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from oct_trading_agent.core import Mint, SwapEvent, TapeEvent
from oct_trading_agent.sim.replay.simulator import ReplaySimulator, SimConfig

# Default rolling window: the "past few days" the paper names (02 §2 (3)).
DEFAULT_WINDOW = timedelta(days=3)


class RecentWindowReplay:
    """Selects active mints + causal decision instants over a rolling window ending at ``now``."""

    def __init__(self, tape: list[TapeEvent], window: timedelta = DEFAULT_WINDOW) -> None:
        self._tape = tape
        self.window = window

    def mints_active(self, now: datetime) -> list[Mint]:
        """Mints with at least one event in ``[now - window, now]`` (sorted, deduped)."""
        start = now - self.window
        mints = {
            e.mint for e in self._tape if start <= e.block_time <= now
        }
        return sorted(mints)

    def decision_times(self, mint: Mint, now: datetime) -> list[datetime]:
        """Sorted swap instants for ``mint`` inside the window — the points a policy may act on.

        Swaps are the natural decision cadence (a new print is new information). Times are unique
        and ascending, so a caller drives the episode strictly forward in time.
        """
        start = now - self.window
        times = sorted(
            {
                e.block_time
                for e in self._tape
                if isinstance(e, SwapEvent) and e.mint == mint and start <= e.block_time <= now
            }
        )
        return times

    def simulator(self, config: SimConfig | None = None) -> ReplaySimulator:
        """A fresh simulator over this driver's tape."""
        return ReplaySimulator(self._tape, config)
