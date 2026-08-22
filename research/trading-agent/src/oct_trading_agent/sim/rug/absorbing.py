"""Rug/honeypot absorbing states — a ``RugEvent`` makes a mint terminally untradeable.

Rugs and honeypots are **absorbing zero states** (paper §6.2; ``core.tape.RugEvent``): once one is
seen for a mint, no later swap on that mint is tradeable and the episode terminates. Avoidance is a
first-class *learned* objective, so this lives in the environment (the sim), not only in the reward.

``RugTracker`` answers "is this mint rugged as-of this instant?" causally — a rug at a future slot
must not retroactively kill an earlier decision.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from oct_trading_agent.core import Mint, RugEvent, TapeEvent


@dataclass(frozen=True)
class RugMarker:
    """The first rug seen for a mint: its slot, time, and kind."""

    slot: int
    block_time: datetime
    rug_kind: str
    detail: str | None


class RugTracker:
    """Indexes the earliest ``RugEvent`` per mint and answers as-of terminality causally."""

    def __init__(self, tape: list[TapeEvent]) -> None:
        self._first_rug: dict[Mint, RugMarker] = {}
        for ev in tape:
            if not isinstance(ev, RugEvent):
                continue
            existing = self._first_rug.get(ev.mint)
            if existing is None or ev.slot < existing.slot:
                self._first_rug[ev.mint] = RugMarker(
                    slot=ev.slot,
                    block_time=ev.block_time,
                    rug_kind=ev.rug_kind,
                    detail=ev.detail,
                )

    def rug_marker(self, mint: Mint) -> RugMarker | None:
        """The earliest rug marker for the mint, or None if the tape never rugs it."""
        return self._first_rug.get(mint)

    def is_rugged_as_of(
        self, mint: Mint, as_of: datetime, as_of_slot: int | None = None
    ) -> bool:
        """True iff a rug for ``mint`` occurred at/before ``as_of`` (and ``as_of_slot`` if given).

        Terminal is *inclusive* of the rug instant: a swap attempted at the rug slot is not
        tradeable (the pool is already gone / frozen at that point).
        """
        marker = self._first_rug.get(mint)
        if marker is None:
            return False
        if as_of_slot is not None:
            return marker.slot <= as_of_slot
        return marker.block_time <= as_of
