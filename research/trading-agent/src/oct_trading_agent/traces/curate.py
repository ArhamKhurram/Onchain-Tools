"""Curated trace showcase (tier 3) — the ONE writer both exporters share.

Takes a group's trade rows + actors-index rows (already bounded by the caller — the agent re-eval
is bounded by construction; the wallet exporter picks its top slice) and writes one trace JSON per
(actor, token) under ``<root>/curated/<group>/<actor>/<mint>.json``, returning the group's manifest
entry for :func:`~.log.write_curated_index`. Price series come from the mint's busiest pool and are
downsampled with the honest sampling label (:data:`~.schema.DOWNSAMPLE_METHOD`).
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from .log import TradeLogStore, ensure_mint_index, price_series
from .schema import (
    DOWNSAMPLE_METHOD,
    PriceSeries,
    ReplayTrace,
    TraceStep,
    TradeRow,
    downsample_price,
    trace_to_json,
)


def actor_meta(actor: dict[str, Any]) -> dict[str, Any]:
    """An actor-index row's browsing metadata: its ``meta_json`` plus the typed agent columns."""
    meta: dict[str, Any] = json.loads(str(actor.get("meta_json") or "{}"))
    for key in ("role", "style_cell", "pnl_bps", "win_rate"):
        if actor.get(key) is not None:
            meta[key] = actor[key]
    return meta


def _token_weight(mint_rows: list[TradeRow]) -> float:
    """How consequential an (actor, token) pair is: |final realized PnL|, else its trade count."""
    final = max(mint_rows, key=lambda r: (r.t, r.seq)).realized_cum
    return abs(final) if final is not None else float(len(mint_rows))


def curate_group(
    store: TradeLogStore,
    dataset_root: Path,
    *,
    group_id: str,
    actor_kind: str,
    rows: list[TradeRow],
    actors: list[dict[str, Any]],
    max_price_points: int = 500,
    max_tokens_per_actor: int | None = None,
) -> dict[str, Any]:
    """Write every (actor, token) trace JSON for ``actors`` and return the group manifest entry.

    ``max_tokens_per_actor`` keeps the showcase BOUNDED against hyperactive actors (a census bot
    can touch 900 tokens): each actor's most consequential pairs — largest |realized PnL|, then
    most trades — are curated, the rest stay reachable through the on-demand builder. The group's
    curated directory is regenerated from scratch, so a re-run never leaves stale traces behind.
    """
    wanted = {str(a["actor_id"]) for a in actors}
    by_actor: dict[str, dict[str, list[TradeRow]]] = {}
    for row in rows:
        if row.actor_id in wanted:
            by_actor.setdefault(row.actor_id, {}).setdefault(row.mint, []).append(row)
    if max_tokens_per_actor is not None:
        for actor_id, mints in by_actor.items():
            keep = sorted(mints, key=lambda m: -_token_weight(mints[m]))[:max_tokens_per_actor]
            by_actor[actor_id] = {m: mints[m] for m in keep}

    group_dir = store.root / "curated" / group_id
    if group_dir.exists():
        shutil.rmtree(group_dir)

    mint_index = ensure_mint_index(store, dataset_root)
    entry: dict[str, Any] = {"group_id": group_id, "actor_kind": actor_kind, "actors": []}
    for actor in actors:
        actor_id = str(actor["actor_id"])
        meta = actor_meta(actor)
        tokens: list[dict[str, Any]] = []
        for mint, mint_rows in sorted(by_actor.get(actor_id, {}).items()):
            points, pool, n_pools = price_series(dataset_root, mint, mint_index)
            sampled, downsampled = downsample_price(points, max_points=max_price_points)
            trace = ReplayTrace(
                actor_id=actor_id,
                actor_kind=actor_kind,
                group_id=group_id,
                mint=mint,
                price=PriceSeries(
                    points=sampled,
                    n_source=len(points),
                    downsampled=downsampled,
                    method=DOWNSAMPLE_METHOD if downsampled else None,
                    pool=pool,
                    n_pools=n_pools,
                ),
                steps=[
                    TraceStep.from_row(r) for r in sorted(mint_rows, key=lambda r: (r.t, r.seq))
                ],
                meta=meta,
            )
            path = store.root / "curated" / group_id / actor_id / f"{mint}.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(trace_to_json(trace), indent=1), encoding="utf-8")
            tokens.append(
                {
                    "mint": mint,
                    "path": path.relative_to(store.root).as_posix(),
                    "n_steps": len(trace.steps),
                    "bytes": path.stat().st_size,
                }
            )
        entry["actors"].append(
            {
                "actor_id": actor_id,
                "meta": meta,
                "n_trades": actor.get("n_trades"),
                "realized_pnl_quote": actor.get("realized_pnl_quote"),
                "tokens": tokens,
            }
        )
    return entry


__all__ = ["actor_meta", "curate_group"]
