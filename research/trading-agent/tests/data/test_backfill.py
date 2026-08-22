"""Backfill: pagination, decode, and write-to-log — driven by real fixture rows, no network."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from oct_trading_agent.data.log import TapeLogReader, TapeLogWriter
from oct_trading_agent.data.pinax_client.backfill import backfill_swaps, iter_swap_events
from oct_trading_agent.data.pinax_client.rest import PinaxRestClient
from oct_trading_agent.data.pinax_client.transport import HttpResponse

from .conftest import FakeTransport, json_response


def _paged_handler(
    rows: list[dict[str, Any]], page_size: int
) -> Callable[[str, dict[str, str], float], HttpResponse]:
    """Serve `rows` split into pages of `page_size`, keyed by the ?page= query param."""

    pages = [rows[i : i + page_size] for i in range(0, len(rows), page_size)] or [[]]

    def handler(url: str, headers: dict[str, str], timeout: float) -> HttpResponse:
        qs = parse_qs(urlparse(url).query)
        page = int(qs.get("page", ["1"])[0])
        data = pages[page - 1] if 1 <= page <= len(pages) else []
        return json_response({"data": data, "pagination": {"current_page": page}})

    return handler


def _client(transport: FakeTransport) -> PinaxRestClient:
    return PinaxRestClient(
        transport=transport, min_interval_s=0.0, api_key_provider=lambda: "k", sleep=lambda _s: None
    )


def test_pagination_stops_on_short_page(swaps_page: dict[str, Any]) -> None:
    rows = swaps_page["data"]  # 7 real base<->WSOL rows
    transport = FakeTransport(_paged_handler(rows, page_size=4))
    client = _client(transport)

    got = list(
        client.iter_swap_rows(amm_pool="pool", limit=4, max_pages=16, use_cache=False)
    )
    assert len(got) == len(rows)
    # page 1 (4 rows, == limit) then page 2 (3 rows, < limit -> stop). Exactly 2 requests.
    assert len(transport.calls) == 2


def test_max_pages_caps_requests() -> None:
    # Every page is full (== limit), so only max_pages stops it.
    full_rows = [{"input_mint": "x", "output_mint": "y"}] * 6
    transport = FakeTransport(_paged_handler(full_rows, page_size=2))
    client = _client(transport)
    list(client.iter_swap_rows(amm_pool="pool", limit=2, max_pages=2, use_cache=False))
    assert len(transport.calls) == 2


def test_backfill_decodes_and_writes(tmp_path: Path, swaps_page: dict[str, Any]) -> None:
    base = swaps_page["base_mint"]
    rows = swaps_page["data"]
    transport = FakeTransport(_paged_handler(rows, page_size=100))
    client = _client(transport)
    writer = TapeLogWriter(tmp_path)

    summary = backfill_swaps(client, writer, base, amm_pool="pool", limit=100, use_cache=False)
    assert summary.mint == base
    assert summary.events_written == len(rows)
    assert summary.first_block_time is not None

    replayed = list(TapeLogReader(tmp_path).replay(base))
    assert len(replayed) == len(rows)


def test_iter_swap_events_filters_time_window(swaps_page: dict[str, Any]) -> None:
    base = swaps_page["base_mint"]
    rows = swaps_page["data"]
    transport = FakeTransport(_paged_handler(rows, page_size=100))
    client = _client(transport)

    all_events = list(iter_swap_events(client, base, amm_pool="pool", use_cache=False))
    assert all_events
    times = sorted(e.block_time for e in all_events)
    # Window that excludes the earliest event -> fewer events.
    cutoff = times[1]
    windowed = list(
        iter_swap_events(client, base, amm_pool="pool", start=cutoff, use_cache=False)
    )
    assert all(e.block_time >= cutoff for e in windowed)
    assert len(windowed) < len(all_events)


def test_backfill_is_idempotent(tmp_path: Path, swaps_page: dict[str, Any]) -> None:
    base = swaps_page["base_mint"]
    rows = swaps_page["data"]
    client = _client(FakeTransport(_paged_handler(rows, page_size=100)))
    writer = TapeLogWriter(tmp_path)
    first = backfill_swaps(client, writer, base, amm_pool="pool", limit=100, use_cache=False)
    second = backfill_swaps(client, writer, base, amm_pool="pool", limit=100, use_cache=False)
    assert first.events_written == len(rows)
    assert second.events_written == 0  # log dedupes on signature
