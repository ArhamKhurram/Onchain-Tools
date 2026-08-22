"""Append-only, idempotent, time-partitioned Parquet writer for the tape log.

Layout on disk::

    <root>/date=YYYY-MM-DD/events.parquet

Each ``append`` groups incoming events by their UTC date, and for each touched partition merges the
new rows with any existing file, **deduping on ``event_id`` (keeping the already-stored row)** and
re-sorting by ``(slot, event_id)``. That makes the log **idempotent on tx ``signature``**:
re-running a backfill over an overlapping window writes nothing new. Append returns the count of
genuinely new events (useful for backfill summaries and idempotency assertions).
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import polars as pl

from oct_trading_agent.core import TapeEvent

from .schema import POLARS_SCHEMA, tape_event_to_row

_PART_FILE = "events.parquet"


class TapeLogWriter:
    """Writes :data:`TapeEvent`\\ s to the append-only Parquet log rooted at ``root``."""

    def __init__(self, root: Path | str) -> None:
        self._root = Path(root)

    @property
    def root(self) -> Path:
        return self._root

    def _partition_file(self, date: str) -> Path:
        return self._root / f"date={date}" / _PART_FILE

    def append(self, events: Iterable[TapeEvent]) -> int:
        """Persist ``events``; return how many were newly added (duplicates by ``event_id`` skipped)."""
        rows_by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for event in events:
            row = tape_event_to_row(event)
            rows_by_date[row["date"]].append(row)

        written = 0
        for date, rows in rows_by_date.items():
            new_df = pl.DataFrame(rows, schema=POLARS_SCHEMA)
            # Within-batch dedupe first so the "new ids" count is honest.
            new_df = new_df.unique(subset=["event_id"], keep="first")
            new_ids = set(new_df.get_column("event_id").to_list())

            part_file = self._partition_file(date)
            if part_file.exists():
                existing = pl.read_parquet(part_file)
                existing_ids = set(existing.get_column("event_id").to_list())
                combined = pl.concat([existing, new_df], how="vertical")
            else:
                existing_ids = set()
                combined = new_df

            written += len(new_ids - existing_ids)
            # keep="first" → existing rows win over re-supplied duplicates (idempotent).
            merged = combined.unique(subset=["event_id"], keep="first").sort(["slot", "event_id"])

            part_file.parent.mkdir(parents=True, exist_ok=True)
            merged.write_parquet(part_file)

        return written


__all__ = ["TapeLogWriter"]
