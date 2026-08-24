"""Trade-log store — the append-friendly parquet substrate every replay is rebuilt from.

Layout on disk (default root ``data/replay_traces/``)::

    <root>/trade_log/<segment>.parquet   # one file per producing run/cohort; one row per TRADE
    <root>/actors/<segment>.parquet      # the browsing index: one row per actor in that segment
    <root>/mint_index.parquet            # mint -> (amm_pool, n_rows) over the swap dataset's pools

**How a future run appends:** import :class:`TradeLogStore`, build its :class:`~.schema.TradeRow`
list (agents: :func:`~.record.record_policy_rollout` during any eval; wallets: their swaps), and
call :meth:`TradeLogStore.write_segment` with a segment name unique to that run. Segments are
whole-file atomic replacements — re-running a producer overwrites ITS segment idempotently and
never touches another run's rows; readers lazily scan ``trade_log/*.parquet``, so a new segment is
visible with zero coordination. No trainer/eval code is modified to feed this — producers opt in by
importing the writer.

The mint index is what keeps the on-demand builder fast: one bounded pass over the swap dataset's
``pools/*.parquet`` maps every mint to the pool files that traded it, so ``build_trace`` reads ONE
pool parquet (the busiest — trickshot's charting convention) instead of scanning thousands.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import polars as pl

from oct_trading_agent.agent.population.checkpoint import atomic_write, atomic_write_text
from oct_trading_agent.data.pinax_client.decode import WSOL

from .schema import PricePoint, TradeRow

#: The trade-log parquet schema — :meth:`.schema.TradeRow.to_record`'s columns, typed.
TRADE_LOG_SCHEMA: dict[str, pl.DataType] = {
    "actor_id": pl.String(),
    "actor_kind": pl.String(),
    "group_id": pl.String(),
    "mint": pl.String(),
    "t": pl.Int64(),
    "seq": pl.Int64(),
    "side": pl.String(),
    "fill": pl.Boolean(),
    "intent": pl.String(),
    "size_frac": pl.Float64(),
    "base": pl.Float64(),
    "quote": pl.Float64(),
    "price": pl.Float64(),
    "bal_after": pl.Float64(),
    "realized_cum": pl.Float64(),
}

#: The actors-index parquet schema (the browsing manifest; nullable per actor kind).
ACTORS_SCHEMA: dict[str, pl.DataType] = {
    "actor_id": pl.String(),
    "actor_kind": pl.String(),
    "group_id": pl.String(),
    "tokens_touched": pl.Int64(),
    "n_trades": pl.Int64(),
    "realized_pnl_quote": pl.Float64(),
    "role": pl.String(),  # agents: coarse archetype niche
    "style_cell": pl.String(),  # agents: fine 4-axis style cell
    "pnl_bps": pl.Float64(),  # agents: held-out fitness from the archive profile
    "win_rate": pl.Float64(),  # agents: held-out win rate from the archive profile
    "meta_json": pl.String(),  # kind-specific extras (census stats / eval provenance), JSON
}

def _safe_segment(name: str) -> str:
    """A filesystem-safe segment file stem (segment names come from run ids / cohort names)."""
    return "".join(c if (c.isalnum() or c in "-_.") else "_" for c in name)


class TradeLogStore:
    """The parquet trade log + actors index under one root directory. See the module docstring."""

    def __init__(self, root: Path | str) -> None:
        self._root = Path(root)

    @property
    def root(self) -> Path:
        return self._root

    @property
    def mint_index_path(self) -> Path:
        return self._root / "mint_index.parquet"

    # -- writing (one segment per producing run; atomic whole-file replace) -----------------------

    def write_segment(self, segment: str, rows: list[TradeRow]) -> Path:
        """Write (or idempotently REPLACE) one producer's trade rows as its own segment file."""
        frame = pl.DataFrame([r.to_record() for r in rows], schema=TRADE_LOG_SCHEMA)
        path = self._root / "trade_log" / f"{_safe_segment(segment)}.parquet"
        atomic_write(path, frame.write_parquet)
        return path

    def write_actors(self, segment: str, actors: list[dict[str, Any]]) -> Path:
        """Write the segment's actor-index rows (:data:`ACTORS_SCHEMA`; missing keys → null)."""
        records = [{k: a.get(k) for k in ACTORS_SCHEMA} for a in actors]
        frame = pl.DataFrame(records, schema=ACTORS_SCHEMA)
        path = self._root / "actors" / f"{_safe_segment(segment)}.parquet"
        atomic_write(path, frame.write_parquet)
        return path

    # -- reading (lazy scan across every segment) -------------------------------------------------

    def scan_trades(self) -> pl.LazyFrame:
        """Lazily scan ALL trade-log segments (empty frame if nothing has been written yet)."""
        seg_dir = self._root / "trade_log"
        if not seg_dir.exists() or not any(seg_dir.glob("*.parquet")):
            return pl.DataFrame(schema=TRADE_LOG_SCHEMA).lazy()
        return pl.scan_parquet(str(seg_dir / "*.parquet"))

    def load_actors(self) -> pl.DataFrame:
        """The full actors index across every segment (the replay browser's actor list)."""
        seg_dir = self._root / "actors"
        if not seg_dir.exists() or not any(seg_dir.glob("*.parquet")):
            return pl.DataFrame(schema=ACTORS_SCHEMA)
        return pl.read_parquet(str(seg_dir / "*.parquet"))

    def actor_token_rows(self, actor_id: str, mint: str, *, group_id: str | None = None) -> pl.DataFrame:
        """One (actor, mint)'s trades, replay-ordered — the on-demand builder's step source."""
        lf = self.scan_trades().filter(
            (pl.col("actor_id") == actor_id) & (pl.col("mint") == mint)
        )
        if group_id is not None:
            lf = lf.filter(pl.col("group_id") == group_id)
        return lf.sort(["t", "seq"]).collect()


# ---------------------------------------------------------------------------
# Mint index + price series over the captured swap dataset (READ-ONLY)
# ---------------------------------------------------------------------------


def build_mint_index(dataset_root: Path | str, *, quote_mint: str = WSOL) -> pl.DataFrame:
    """One pass over ``<dataset>/pools/*.parquet`` → (mint, amm_pool, n_rows) rows.

    A pool's mint is the non-quote leg of its WSOL-paired rows (the same rule the dataset's own
    tape loader uses). A mint that printed on several pools (bonding curve → AMM migration) gets
    one row per pool; the busiest is the charting pool.
    """
    pools = Path(dataset_root) / "pools"
    lf = pl.scan_parquet(str(pools / "*.parquet"))
    is_buy = pl.col("input_mint") == quote_mint
    is_sell = pl.col("output_mint") == quote_mint
    return (
        lf.filter(is_buy != is_sell)
        .select(
            pl.when(is_buy).then(pl.col("output_mint")).otherwise(pl.col("input_mint")).alias("mint"),
            pl.col("amm_pool"),
        )
        .group_by(["mint", "amm_pool"])
        .agg(pl.len().alias("n_rows"))
        .sort(["mint", "n_rows"], descending=[False, True])
        .collect()
    )


def ensure_mint_index(store: TradeLogStore, dataset_root: Path | str) -> pl.DataFrame:
    """Load the cached mint index, building + persisting it on first use (the one slow pass)."""
    if store.mint_index_path.exists():
        return pl.read_parquet(store.mint_index_path)
    index = build_mint_index(dataset_root)
    atomic_write(store.mint_index_path, index.write_parquet)
    return index


def price_series(
    dataset_root: Path | str,
    mint: str,
    mint_index: pl.DataFrame,
    *,
    quote_mint: str = WSOL,
) -> tuple[list[PricePoint], str | None, int]:
    """The mint's chart from its BUSIEST pool: time-ordered (t, quote/base) real trade prints.

    Returns ``(points, charting_pool, n_pools)``. Multi-pool mints chart the pool with the most
    rows (trickshot's convention) while the actor's trades — which may span pools — are overlaid
    in full by the caller. An unknown mint yields ``([], None, 0)`` rather than a fabricated chart.
    """
    pools = mint_index.filter(pl.col("mint") == mint).sort("n_rows", descending=True)
    if pools.height == 0:
        return [], None, 0
    busiest = str(pools.get_column("amm_pool")[0])
    path = Path(dataset_root) / "pools" / f"{busiest}.parquet"
    frame = pl.read_parquet(path)
    is_buy = pl.col("input_mint") == quote_mint
    is_sell = pl.col("output_mint") == quote_mint
    prints = (
        frame.lazy()
        .filter(is_buy != is_sell)
        .select(
            pl.col("timestamp").alias("t"),
            pl.when(is_buy).then(pl.col("output_value")).otherwise(pl.col("input_value")).alias("base"),
            pl.when(is_buy).then(pl.col("input_value")).otherwise(pl.col("output_value")).alias("quote"),
            pl.col("block_num"),
            pl.col("transaction_index"),
            pl.col("instruction_index"),
        )
        .filter((pl.col("base") > 0) & (pl.col("quote") > 0))
        .sort(["block_num", "transaction_index", "instruction_index"])
        .collect()
    )
    points = [
        PricePoint(t=int(rec["t"]), p=float(rec["quote"]) / float(rec["base"]))
        for rec in prints.to_dicts()
    ]
    return points, busiest, pools.height


# ---------------------------------------------------------------------------
# Curated-manifest helper (tier 3's index.json)
# ---------------------------------------------------------------------------


def write_curated_index(root: Path, groups: list[dict[str, Any]]) -> Path:
    """Merge ``groups`` into ``<root>/curated/index.json`` (keyed by ``group_id``, atomic write).

    Each exporter contributes its own group entries; existing entries for OTHER groups are kept, so
    the agent and wallet exporters compose into one browsing manifest without coordination.
    """
    path = root / "curated" / "index.json"
    existing: list[dict[str, Any]] = []
    if path.exists():
        existing = list(json.loads(path.read_text(encoding="utf-8")).get("groups", []))
    replaced = {str(g.get("group_id")) for g in groups}
    merged = [g for g in existing if str(g.get("group_id")) not in replaced] + groups
    doc = {
        "schema": "replay-trace-index/v1",
        "generated_at": datetime.now(UTC).isoformat(),
        "groups": sorted(merged, key=lambda g: str(g.get("group_id"))),
    }
    atomic_write_text(path, json.dumps(doc, indent=2))
    return path


__all__ = [
    "TRADE_LOG_SCHEMA",
    "ACTORS_SCHEMA",
    "TradeLogStore",
    "build_mint_index",
    "ensure_mint_index",
    "price_series",
    "write_curated_index",
]
