"""Backfill historical swap tape for a token/time-range into the append-only log.

Ties the three pieces together: :class:`~.rest.PinaxRestClient` (paged REST) →
:func:`~.decode.decode_swap_row` (rows → :class:`SwapEvent`) → the log writer
(:class:`~oct_trading_agent.data.log.TapeLogWriter`). Idempotency is the log's job (dedupe on tx
``signature``), so re-running a backfill over an overlapping window is safe and — thanks to the
client's disk cache — free.

Two query modes:

* **By pool** (``amm_pool=...``) — one paged scan returns both buy and sell legs (the proven spike
  path).
* **By mint** (default) — two paged scans, ``output_mint=mint`` (buys) and ``input_mint=mint``
  (sells), merged; the log dedupes any overlap.

**Live backfill is gated on ``PINAX_API_KEY``** being set (config.py). Nothing here touches the
network in tests — a fake-transport client drives the whole path.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime

from oct_trading_agent.core import Mint, SwapEvent, TapeEvent

from ..log import TapeLogWriter
from .decode import WSOL, decode_swap_row
from .rest import DEFAULT_PAGE_LIMIT, PinaxRestClient


def _iso(dt: datetime | None) -> str | None:
    return None if dt is None else dt.strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass(frozen=True)
class BackfillSummary:
    """Outcome of a backfill run for one token."""

    mint: Mint
    rows_seen: int
    events_decoded: int
    events_written: int
    first_block_time: datetime | None
    last_block_time: datetime | None


def iter_swap_events(
    client: PinaxRestClient,
    tracked_mint: Mint,
    *,
    start: datetime | None = None,
    end: datetime | None = None,
    amm_pool: str | None = None,
    quote_mint: str = WSOL,
    network: str = "solana",
    limit: int = DEFAULT_PAGE_LIMIT,
    max_pages: int = 16,
    use_cache: bool = True,
) -> Iterator[SwapEvent]:
    """Yield decoded :class:`SwapEvent`\\ s for ``tracked_mint`` over ``[start, end)``.

    Decoded rows that are not a ``tracked_mint``↔``quote_mint`` swap are dropped; ``block_time`` is
    clamped to ``[start, end)`` when those bounds are given.
    """
    start_time, end_time = _iso(start), _iso(end)

    if amm_pool is not None:
        row_streams = [
            client.iter_swap_rows(
                network=network, amm_pool=amm_pool, start_time=start_time, end_time=end_time,
                limit=limit, max_pages=max_pages, use_cache=use_cache,
            )
        ]
    else:
        # Two passes: buys (mint on the output leg) and sells (mint on the input leg).
        row_streams = [
            client.iter_swap_rows(
                network=network, output_mint=tracked_mint, start_time=start_time,
                end_time=end_time, limit=limit, max_pages=max_pages, use_cache=use_cache,
            ),
            client.iter_swap_rows(
                network=network, input_mint=tracked_mint, start_time=start_time,
                end_time=end_time, limit=limit, max_pages=max_pages, use_cache=use_cache,
            ),
        ]

    for rows in row_streams:
        for row in rows:
            event = decode_swap_row(row, tracked_mint, quote_mint=quote_mint)
            if event is None:
                continue
            if start is not None and event.block_time < start:
                continue
            if end is not None and event.block_time >= end:
                continue
            yield event


def backfill_swaps(
    client: PinaxRestClient,
    writer: TapeLogWriter,
    tracked_mint: Mint,
    *,
    start: datetime | None = None,
    end: datetime | None = None,
    amm_pool: str | None = None,
    quote_mint: str = WSOL,
    network: str = "solana",
    limit: int = DEFAULT_PAGE_LIMIT,
    max_pages: int = 16,
    use_cache: bool = True,
) -> BackfillSummary:
    """Backfill ``tracked_mint``'s swap tape over ``[start, end)`` into ``writer``.

    Returns a :class:`BackfillSummary`. Safe to re-run: the log dedupes on ``signature``.
    """
    events = list(
        iter_swap_events(
            client, tracked_mint, start=start, end=end, amm_pool=amm_pool, quote_mint=quote_mint,
            network=network, limit=limit, max_pages=max_pages, use_cache=use_cache,
        )
    )
    written = writer.append(events)
    times = sorted(e.block_time for e in events)
    return BackfillSummary(
        mint=tracked_mint,
        rows_seen=len(events),
        events_decoded=len(events),
        events_written=written,
        first_block_time=times[0] if times else None,
        last_block_time=times[-1] if times else None,
    )


class PinaxRestTapeSource:
    """Adapts :class:`PinaxRestClient` to the :class:`~oct_trading_agent.data.connectors.TapeSource`
    seam so the backfill driver and any future consumer can treat REST like any other source.
    """

    def __init__(
        self,
        client: PinaxRestClient,
        *,
        amm_pool: str | None = None,
        quote_mint: str = WSOL,
        max_pages: int = 16,
    ) -> None:
        self._client = client
        self._amm_pool = amm_pool
        self._quote_mint = quote_mint
        self._max_pages = max_pages

    def stream_events(
        self, mint: Mint, start: datetime, end: datetime
    ) -> Iterator[TapeEvent]:
        yield from iter_swap_events(
            self._client, mint, start=start, end=end, amm_pool=self._amm_pool,
            quote_mint=self._quote_mint, max_pages=self._max_pages,
        )


__all__ = [
    "backfill_swaps",
    "iter_swap_events",
    "BackfillSummary",
    "PinaxRestTapeSource",
]
