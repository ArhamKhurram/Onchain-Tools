"""Bounded multi-token live tape loader — the substrate for a **held-out-tokens** walk-forward.

``eval/data.py`` loads ONE token (fixture or one live pool). The Phase-1 held-out-tokens axis needs
several *distinct real tokens*, held out by launch time. This module gets them the bounded way the
plan mandates: ONE network-wide page of ``/v1/svm/swaps`` (``limit ≤ 500``, ``User-Agent`` + key
from ``backend/.env`` — the same client ``eval/proof.py`` uses), grouped by AMM pool, filtered to
pump.fun **bonding-curve** pools (``protocol == "pumpfun"``) that quote against WSOL and carry enough
prints to form windows. It builds strictly on the fixed ``data/`` + ``eval/data`` decoders — it does
not touch them, only consumes them.

Deliberately small and read-only: one page, a handful of tokens, no pagination loop. The PR is the
deliverable, not open-ended data collection (the plan's own words). Gated on ``PINAX_API_KEY``;
raises if it is unset or the page yields too few usable tokens, so the caller can fall back to the
fixture and the held-out-time axis.
"""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Any

from oct_trading_agent.core import SwapEvent
from oct_trading_agent.eval.data import TokenTape

_WSOL = "So11111111111111111111111111111111111111112"
_BONDING_PROTOCOL = "pumpfun"


def _tracked_mint(row: dict[str, Any]) -> str | None:
    """The non-WSOL leg of a swap row, or ``None`` if it is not a WSOL-quoted pair."""
    for leg in (row.get("input_mint"), row.get("output_mint")):
        if isinstance(leg, str) and leg and leg != _WSOL:
            return leg
    return None


def load_live_bonding_curve_tapes(
    *,
    network: str = "solana",
    page_rows: int = 500,
    max_tokens: int = 4,
    min_swaps: int = 24,
    cache_dir: Path | None = None,
) -> list[TokenTape]:
    """Pull one network-wide page and return up to ``max_tokens`` pump.fun bonding-curve token tapes.

    Groups the page by ``amm_pool``, keeps only ``protocol == "pumpfun"`` pools quoting against WSOL
    with ``>= min_swaps`` decodable prints, and decodes each to a causal :class:`TokenTape`. Tokens
    are returned oldest-first (by earliest print) so a downstream time-holdout is well-defined.
    """
    from oct_trading_agent.data.pinax_client.decode import decode_swap_row
    from oct_trading_agent.data.pinax_client.rest import PinaxRestClient

    limit = max(1, min(500, page_rows))
    client = PinaxRestClient(cache_dir=cache_dir)
    payload = client.get_swaps(network=network, limit=limit, page=1, use_cache=cache_dir is not None)
    rows = [r for r in (payload.get("data") or []) if isinstance(r, dict)]

    # Group rows by pool, restricting to WSOL-quoted pump.fun bonding-curve pools.
    by_pool: dict[str, list[dict[str, Any]]] = defaultdict(list)
    pool_mint: dict[str, str] = {}
    for row in rows:
        pool = row.get("amm_pool")
        if not isinstance(pool, str) or not pool:
            continue
        if str(row.get("protocol")) != _BONDING_PROTOCOL:
            continue
        tracked = _tracked_mint(row)
        if tracked is None:
            continue
        by_pool[pool].append(row)
        pool_mint.setdefault(pool, tracked)

    tapes: list[TokenTape] = []
    for pool, pool_rows in by_pool.items():
        tracked = pool_mint[pool]
        swaps: list[SwapEvent] = []
        for row in pool_rows:
            event = decode_swap_row(row, tracked, quote_mint=_WSOL)
            if event is not None:
                swaps.append(event.model_copy(update={"protocol": _BONDING_PROTOCOL}))
        if len(swaps) < min_swaps:
            continue
        swaps.sort(key=lambda s: (s.slot, s.block_time))
        tapes.append(
            TokenTape(mint=tracked, swaps=swaps, source=f"live:pinax/{network}/pool={pool[:8]}...")
        )

    if len(tapes) < 2:
        raise RuntimeError(
            f"one page yielded {len(tapes)} bonding-curve token(s) with >= {min_swaps} swaps; "
            "need >= 2 for held-out-tokens (try again — the firehose is time-varying)"
        )
    tapes.sort(key=lambda t: min(e.block_time for e in t.swaps))
    return tapes[:max_tokens]


__all__ = ["load_live_bonding_curve_tapes"]
