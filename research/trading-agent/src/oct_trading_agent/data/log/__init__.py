"""log/ — the durable, replayable, append-only tape store (02 §2 (1); 04-data-spec §4).

Columnar (Parquet via polars), **time-partitioned** by UTC date, **idempotent on tx ``signature``**,
and **ordered by ``slot``** on replay. It is source-agnostic: whatever produced a
:data:`~oct_trading_agent.core.tape.TapeEvent` (REST backfill, WS live tail, later Substreams), it
lands here in the same shape and replays identically.

* :class:`TapeLogWriter` — append events; dedupe on ``event_id``; returns the count newly added.
* :class:`TapeLogReader` — replay a ``(token, [start, end))`` slice as ``TapeEvent``\\ s in slot order.
* :mod:`.schema` — the flat columnar schema and the (event ⇄ row) codec (Decimals as exact strings).

Replayability is the requirement, not the specific engine (04-data-spec §4): Parquet keeps the log
portable to DuckDB/Arrow for local analytics without changing this contract.
"""

from __future__ import annotations

from .reader import TapeLogReader
from .schema import POLARS_SCHEMA, event_id, row_to_tape_event, tape_event_to_row
from .writer import TapeLogWriter

__all__ = [
    "TapeLogWriter",
    "TapeLogReader",
    "POLARS_SCHEMA",
    "event_id",
    "tape_event_to_row",
    "row_to_tape_event",
]
