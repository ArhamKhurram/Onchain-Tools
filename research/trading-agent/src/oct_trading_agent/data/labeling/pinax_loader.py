"""Pull a tracked trader's on-chain swaps from Pinax by ``signer`` → a :class:`LabeledWallet`.

This is the Phase-2 realization of the ``load_labeled_wallets`` swap-point promised in
:mod:`.fixtures`: instead of a JSON fixture, we pull each trader's **full** swap history from Pinax
REST (``/v1/svm/swaps?network=solana&signer=<addr>``), decode every WSOL-quoted leg into a
:class:`LabeledTrade`, and hand the same :class:`LabeledWallet` object to
:func:`~.reconstruct.build_trajectories`. Nothing downstream changes.

Design commitments:

* **Reuse, don't fork.** Pagination, throttle, disk-cache, and 429/5xx retry all live in the shared
  :class:`~oct_trading_agent.data.pinax_client.rest.PinaxRestClient`; row decoding reuses
  :func:`~oct_trading_agent.data.pinax_client.decode.decode_swap_row`. This module only adds the
  ``signer`` query (the shared client has no dedicated helper for it) and the SwapEvent→LabeledTrade
  mapping. The ``User-Agent`` + key handling is the client's.
* **Full history, wins and losses.** We do not filter rows by outcome — the whole point of the
  labeled-wallet warm-start is that losing episodes are first-class (04-data-spec leakage rule 7;
  paper §9.3). We only drop rows that are not a tracked↔WSOL swap (token→token routes) or carry
  degenerate amounts.
* **Bounded.** ``max_pages`` caps the pull per wallet; the caller caps the number of wallets. A live
  pull is gated on ``PINAX_API_KEY`` (the client raises otherwise).

A swap pulled by ``signer`` can be on *any* token, so — unlike a by-pool pull — the tracked mint is
inferred per row as the non-WSOL leg before decoding.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from typing import Any

from oct_trading_agent.config import PINAX_SWAPS_REST_PATH
from oct_trading_agent.core import SwapEvent
from oct_trading_agent.data.pinax_client.decode import WSOL, decode_swap_row
from oct_trading_agent.data.pinax_client.rest import DEFAULT_PAGE_LIMIT, PinaxRestClient

from .schema import LabeledTrade, LabeledWallet


def _tracked_mint(row: Mapping[str, Any], quote_mint: str) -> str | None:
    """The non-quote leg of a swap row, or ``None`` if it is not a ``quote_mint``-paired swap."""
    input_mint = row.get("input_mint")
    output_mint = row.get("output_mint")
    if input_mint == quote_mint and isinstance(output_mint, str) and output_mint:
        return output_mint
    if output_mint == quote_mint and isinstance(input_mint, str) and input_mint:
        return input_mint
    return None


def iter_signer_swaps(
    client: PinaxRestClient,
    signer: str,
    *,
    network: str = "solana",
    quote_mint: str = WSOL,
    limit: int = DEFAULT_PAGE_LIMIT,
    max_pages: int = 8,
    use_cache: bool = True,
) -> Iterator[SwapEvent]:
    """Yield every decodable WSOL-quoted :class:`SwapEvent` a ``signer`` made, across bounded pages.

    Paginates ``/v1/svm/swaps?signer=<signer>`` newest-first (a page shorter than ``limit`` ends the
    scan, like the shared client's own loop), inferring each row's tracked mint as its non-WSOL leg.
    """
    if not 1 <= limit <= 1000:
        raise ValueError(f"limit must be in [1, 1000], got {limit}")
    for page in range(1, max_pages + 1):
        params = {
            "network": network,
            "signer": signer,
            "limit": limit,
            "page": page,
        }
        payload = client.get_json(PINAX_SWAPS_REST_PATH, params, use_cache=use_cache)
        rows = [r for r in (payload.get("data") or []) if isinstance(r, dict)]
        for row in rows:
            tracked = _tracked_mint(row, quote_mint)
            if tracked is None:
                continue
            event = decode_swap_row(row, tracked, quote_mint=quote_mint)
            if event is not None:
                yield event
        if len(rows) < limit:
            return


def _to_labeled_trade(event: SwapEvent) -> LabeledTrade:
    """Map a decoded :class:`SwapEvent` onto the labeling-side :class:`LabeledTrade` contract."""
    return LabeledTrade(
        timestamp=event.block_time,
        mint=event.mint,
        side=event.side,
        base_amount=event.base_amount,
        quote_amount=event.quote_amount,
        price=event.price,
        signature=event.signature,
    )


def load_wallet_trades(
    client: PinaxRestClient,
    address: str,
    *,
    labels: list[str] | None = None,
    network: str = "solana",
    quote_mint: str = WSOL,
    limit: int = DEFAULT_PAGE_LIMIT,
    max_pages: int = 8,
    use_cache: bool = True,
) -> LabeledWallet:
    """Pull one tracked wallet's full WSOL-quoted swap history into a :class:`LabeledWallet`.

    ``labels`` is free-form provenance (e.g. ``["tracked", "high-balance"]``); it is metadata only —
    the reconstruction never filters on it. Trades are returned time-ordered.
    """
    # Drain the generator incrementally and KEEP whatever arrived before a failure.
    #
    # `list(...)` around the generator loses everything when any page raises, and deep pages are
    # exactly where Pinax fails: a deep query takes ~10-12s and intermittently exceeds a server-side
    # timeout, returning 500 (measured 2026-08-26 — failure rate rises with offset and is roughly
    # independent of page size, so a smaller `limit` is not the fix). The caller
    # (`load_cohort_from_pinax`) treats an exception as "skip this wallet entirely", so one failed
    # page discarded every page already fetched.
    #
    # That did not thin the cohort randomly — it removed exactly the wallets with enough history to
    # need a deep page, biasing the tracked-trader baseline toward LOW-VOLUME traders. A truncated
    # history is a far better baseline input than no wallet at all, so a partial pull now succeeds
    # and records how far it got.
    events = []
    truncated_at: int | None = None
    try:
        for event in iter_signer_swaps(
            client,
            address,
            network=network,
            quote_mint=quote_mint,
            limit=limit,
            max_pages=max_pages,
            use_cache=use_cache,
        ):
            events.append(event)
    except Exception:
        if not events:
            raise  # nothing salvageable — the caller's skip path is the right outcome
        truncated_at = len(events)

    events.sort(key=lambda e: (e.block_time, e.slot))
    trades = [_to_labeled_trade(e) for e in events]
    marks = list(labels or [])
    if truncated_at is not None:
        marks.append(f"truncated:{truncated_at}")
    return LabeledWallet(wallet=address, labels=marks, trades=trades)


__all__ = ["iter_signer_swaps", "load_wallet_trades"]
