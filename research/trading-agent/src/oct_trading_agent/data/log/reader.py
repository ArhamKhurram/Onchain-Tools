"""Replay reader for the append-only tape log.

Answers the one query the sim and feature store need: *replay ``(token, [start, end))`` back as
``TapeEvent``\\ s in ``slot`` order.* It selects only the date partitions overlapping the window
(cheap), filters to the ``mint`` and the precise ``[start, end)`` bounds, sorts by
``(slot, event_id)``, and yields decoded events. ``end`` is exclusive.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import polars as pl

from oct_trading_agent.core import Mint, TapeEvent

from .schema import row_to_tape_event

_PART_FILE = "events.parquet"


def _as_utc(dt: datetime) -> datetime:
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


class TapeLogReader:
    """Reads/replays the append-only Parquet log rooted at ``root``."""

    def __init__(self, root: Path | str) -> None:
        self._root = Path(root)

    def _partition_dirs_in_range(
        self, start: datetime | None, end: datetime | None
    ) -> list[Path]:
        if not self._root.exists():
            return []
        lo = start.astimezone(UTC).date().isoformat() if start else None
        hi = end.astimezone(UTC).date().isoformat() if end else None
        out: list[Path] = []
        for part_dir in sorted(self._root.glob("date=*")):
            date = part_dir.name.split("=", 1)[1]
            if lo is not None and date < lo:
                continue
            if hi is not None and date > hi:
                continue
            if (part_dir / _PART_FILE).exists():
                out.append(part_dir)
        return out

    def replay(
        self,
        mint: Mint,
        start: datetime | None = None,
        end: datetime | None = None,
    ) -> Iterator[TapeEvent]:
        """Yield ``mint``'s events with ``start <= block_time < end`` in ``(slot, event_id)`` order."""
        part_dirs = self._partition_dirs_in_range(start, end)
        if not part_dirs:
            return

        frames = [pl.read_parquet(d / _PART_FILE) for d in part_dirs]
        df = pl.concat(frames) if len(frames) > 1 else frames[0]
        df = df.filter(pl.col("mint") == mint)
        if start is not None:
            df = df.filter(pl.col("block_time") >= _as_utc(start))
        if end is not None:
            df = df.filter(pl.col("block_time") < _as_utc(end))
        df = df.sort(["slot", "event_id"])

        for row in df.iter_rows(named=True):
            yield row_to_tape_event(row)


__all__ = ["TapeLogReader"]
