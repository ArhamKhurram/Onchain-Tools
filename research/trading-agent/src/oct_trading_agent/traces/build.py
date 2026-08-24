"""On-demand trace builder — one (actor, token) replay assembled at REQUEST time. Tier 2.

This is the piece that scales to "every trade of every actor": nothing is pre-rendered per pair.
:func:`build_trace` reads the (actor, mint) rows out of the trade-log parquet segments, the token's
chart out of its busiest pool parquet (via the cached mint index — one direct file read, never a
dataset scan), downsamples the chart with the honest sampling label, and returns the same trace
JSON contract the curated tier writes. A local replay-browser server calls this per click; the CLI
emits the JSON to stdout (or ``--out``), so a static viz + a trivial subprocess shim is enough — no
HTTP layer needed here.

Run (lean install)::

    uv run python -m oct_trading_agent.traces.build \
        --root data/replay_traces --dataset data/market_dataset_snap800 \
        --actor <wallet-or-agent-id> --mint <mint> [--group <run|cohort>]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

import polars as pl

from .curate import actor_meta
from .log import TradeLogStore, ensure_mint_index, price_series
from .schema import (
    DOWNSAMPLE_METHOD,
    PriceSeries,
    ReplayTrace,
    TraceStep,
    downsample_price,
    trace_to_json,
)


def build_trace(
    root: Path | str,
    dataset_root: Path | str,
    actor_id: str,
    mint: str,
    *,
    group_id: str | None = None,
    max_price_points: int = 500,
) -> ReplayTrace:
    """Assemble one (actor, token) replay trace from the trade log + the token's market tape.

    Raises ``ValueError`` when the pair has no logged trades, or when ``actor_id`` is ambiguous
    across groups (two runs can reuse an agent id like ``c0042``) — pass ``group_id`` to pin it.
    """
    store = TradeLogStore(root)
    rows = store.actor_token_rows(actor_id, mint, group_id=group_id)
    if rows.height == 0:
        raise ValueError(
            f"no logged trades for actor {actor_id!r} on mint {mint!r}"
            + (f" in group {group_id!r}" if group_id else "")
        )
    groups = sorted(set(rows.get_column("group_id").to_list()))
    if len(groups) > 1:
        raise ValueError(
            f"actor {actor_id!r} is ambiguous across groups {groups}; pass group_id to pin it"
        )
    resolved_group = str(groups[0])
    actor_kind = str(rows.get_column("actor_kind")[0])

    actors = store.load_actors()
    match = actors.filter(
        (pl.col("actor_id") == actor_id) & (pl.col("group_id") == resolved_group)
    )
    meta: dict[str, Any] = actor_meta(match.to_dicts()[0]) if match.height else {}

    mint_index = ensure_mint_index(store, Path(dataset_root))
    points, pool, n_pools = price_series(Path(dataset_root), mint, mint_index)
    sampled, downsampled = downsample_price(points, max_points=max_price_points)

    steps = [
        TraceStep(
            t=int(rec["t"]),
            seq=int(rec["seq"]),
            side=str(rec["side"]),
            fill=bool(rec["fill"]),
            intent=rec["intent"],
            size_frac=rec["size_frac"],
            base=rec["base"],
            quote=rec["quote"],
            price=rec["price"],
            bal=rec["bal_after"],
            realized_cum=rec["realized_cum"],
        )
        for rec in rows.to_dicts()
    ]
    return ReplayTrace(
        actor_id=actor_id,
        actor_kind=actor_kind,
        group_id=resolved_group,
        mint=mint,
        price=PriceSeries(
            points=sampled,
            n_source=len(points),
            downsampled=downsampled,
            method=DOWNSAMPLE_METHOD if downsampled else None,
            pool=pool,
            n_pools=n_pools,
        ),
        steps=steps,
        meta=meta,
    )


def main() -> None:  # pragma: no cover - CLI/IO
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=str, default="data/replay_traces", help="trace-store root")
    parser.add_argument("--dataset", type=str, required=True, help="captured MarketSwapDataset root")
    parser.add_argument("--actor", type=str, required=True, help="actor id (wallet address / agent id)")
    parser.add_argument("--mint", type=str, required=True)
    parser.add_argument("--group", type=str, default=None, help="run id / cohort (pins an ambiguous actor)")
    parser.add_argument("--max-price-points", type=int, default=500)
    parser.add_argument("--out", type=str, default=None, help="write here instead of stdout")
    args = parser.parse_args()

    start = time.perf_counter()
    trace = build_trace(
        args.root, args.dataset, args.actor, args.mint,
        group_id=args.group, max_price_points=args.max_price_points,
    )
    doc = json.dumps(trace_to_json(trace), indent=1)
    elapsed = time.perf_counter() - start
    if args.out:
        Path(args.out).write_text(doc, encoding="utf-8")
        print(f"[build] {args.actor} x {args.mint}: {len(trace.steps)} step(s), "
              f"{len(trace.price.points)} price point(s) -> {args.out} in {elapsed:.2f}s")
    else:
        print(doc)
        print(f"[build] {elapsed:.2f}s", file=sys.stderr)


if __name__ == "__main__":  # pragma: no cover
    main()


__all__ = ["build_trace"]
