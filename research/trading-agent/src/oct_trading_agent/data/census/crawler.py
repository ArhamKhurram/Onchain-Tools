"""Census crawler — scan a captured swap dataset into per-(wallet, token) FIFO stats.

Input is the on-disk :class:`~oct_trading_agent.data.dataset.MarketSwapDataset` layout
(``<root>/pools/<amm_pool>.parquet`` of raw Pinax swap rows, venue-tagged, one file per pool) —
READ-ONLY here. Every row carries its ``signer``, so the same capture that feeds the replay env is
also a wallet census waiting to be taken (the operator's "top/bottom 25% of every token we run
through" gene-pool idea; paper §9.3's designed answer to operator-picked cohorts).

Pipeline (polars-first, then one numpy pass):

1. **Normalize** — keep only WSOL-paired rows; derive wallet / mint (the non-WSOL leg) / side /
   base / quote; drop degenerate amounts; dedupe on the swap identity
   ``(signature, transaction_index, instruction_index, amm_pool)`` (overlapping pulls are
   idempotent, mirroring the dataset's own dedup).
2. **Collapse fills** — rows sharing ``(wallet, mint, signature, side)`` are legs of ONE economic
   trade routed across pools/instructions; they are summed into a single trade (min timestamp).
   Without this, route splits masquerade as machine-gun trading and poison the inter-arrival and
   alternation wash heuristics.
3. **FIFO per pair** — group by (wallet, mint), time-ordered, and run
   :func:`~.fifo.fifo_pair_pnl`; alongside it compute the per-pair wash-heuristic inputs
   (buy/sell alternation share, trade-size CV, inter-arrival CV).

Output is one row per (wallet, token) pair — the substrate :mod:`.cohorts` ranks and aggregates.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import polars as pl

from oct_trading_agent.data.pinax_client.decode import WSOL

from .fifo import fifo_pair_pnl

# Wash-heuristic inputs need a handful of gaps/sizes before a CV means anything.
_MIN_GAPS_FOR_CV = 5
_MIN_SIZES_FOR_CV = 2


def scan_swaps(dataset_root: Path, *, quote_mint: str = WSOL) -> pl.LazyFrame:
    """Lazy-scan a dataset's ``pools/*.parquet`` into the normalized census trade frame.

    One output row per collapsed economic trade: ``wallet, mint, is_buy, base, quote, ts``.
    """
    pools = dataset_root / "pools"
    lf = pl.scan_parquet(str(pools / "*.parquet"))
    is_buy = pl.col("input_mint") == quote_mint
    is_sell = pl.col("output_mint") == quote_mint
    return (
        lf.filter(is_buy != is_sell)  # exactly one WSOL leg (drops token→token routes)
        .unique(subset=["signature", "transaction_index", "instruction_index", "amm_pool"])
        .select(
            pl.col("signer").alias("wallet"),
            pl.when(is_buy)
            .then(pl.col("output_mint"))
            .otherwise(pl.col("input_mint"))
            .alias("mint"),
            is_buy.alias("is_buy"),
            pl.when(is_buy)
            .then(pl.col("output_value"))
            .otherwise(pl.col("input_value"))
            .alias("base"),
            pl.when(is_buy)
            .then(pl.col("input_value"))
            .otherwise(pl.col("output_value"))
            .alias("quote"),
            pl.col("timestamp").alias("ts"),
            pl.col("signature"),
        )
        .filter((pl.col("base") > 0) & (pl.col("quote") > 0))
        # Collapse multi-pool/multi-instruction fills of one signed trade into one economic trade.
        .group_by(["wallet", "mint", "signature", "is_buy"])
        .agg(pl.col("base").sum(), pl.col("quote").sum(), pl.col("ts").min())
    )


def _cv(values: np.ndarray, *, min_n: int) -> float | None:
    """Coefficient of variation (population std / mean), or ``None`` when unreliable."""
    v = np.asarray(values, dtype=float).ravel()
    if v.shape[0] < min_n:
        return None
    mean = float(np.mean(v))
    if mean <= 0.0:
        return None
    return float(np.std(v) / mean)


def build_pair_stats(trades: pl.DataFrame) -> pl.DataFrame:
    """One numpy pass over the sorted trade frame → one stats row per (wallet, token) pair."""
    df = trades.sort(["wallet", "mint", "ts", "signature"])
    wallets = df.get_column("wallet").to_list()
    mints = df.get_column("mint").to_list()
    is_buy = df.get_column("is_buy").to_numpy()
    base = df.get_column("base").to_numpy()
    quote = df.get_column("quote").to_numpy()
    ts = df.get_column("ts").to_numpy()

    cols: dict[str, list[object]] = {
        "wallet": [],
        "mint": [],
        "n_trades": [],
        "n_buys": [],
        "n_sells": [],
        "quote_in": [],
        "quote_out": [],
        "realized_pnl": [],
        "uncosted_sell_quote": [],
        "residual_base": [],
        "residual_cost_quote": [],
        "mean_hold_s": [],
        "first_ts": [],
        "last_ts": [],
        "alternation": [],
        "size_cv": [],
        "buy_size_cv": [],
        "gap_cv": [],
    }

    n = len(wallets)
    start = 0
    for i in range(1, n + 1):
        if i < n and wallets[i] == wallets[start] and mints[i] == mints[start]:
            continue
        seg = slice(start, i)
        pnl = fifo_pair_pnl(is_buy[seg], base[seg], quote[seg], ts[seg])
        seg_buy = is_buy[seg]
        seg_quote = quote[seg]
        seg_ts = ts[seg]
        n_trades = i - start
        alternation = float(np.mean(seg_buy[1:] != seg_buy[:-1])) if n_trades >= 2 else 0.0
        cols["wallet"].append(wallets[start])
        cols["mint"].append(mints[start])
        cols["n_trades"].append(n_trades)
        cols["n_buys"].append(pnl.n_buys)
        cols["n_sells"].append(pnl.n_sells)
        cols["quote_in"].append(pnl.quote_in)
        cols["quote_out"].append(pnl.quote_out)
        cols["realized_pnl"].append(pnl.realized_pnl)
        cols["uncosted_sell_quote"].append(pnl.uncosted_sell_quote)
        cols["residual_base"].append(pnl.residual_base)
        cols["residual_cost_quote"].append(pnl.residual_cost_quote)
        cols["mean_hold_s"].append(pnl.mean_hold_s)
        cols["first_ts"].append(int(seg_ts[0]))
        cols["last_ts"].append(int(seg_ts[-1]))
        cols["alternation"].append(alternation)
        cols["size_cv"].append(_cv(seg_quote, min_n=_MIN_SIZES_FOR_CV))
        # Buys-only CV: a ping-pong bot's buy legs are near-identical while its sell legs drift
        # with price, so the combined-size CV under-detects exactly the shape we hunt.
        cols["buy_size_cv"].append(_cv(seg_quote[seg_buy], min_n=_MIN_SIZES_FOR_CV))
        cols["gap_cv"].append(_cv(np.diff(seg_ts), min_n=_MIN_GAPS_FOR_CV))
        start = i

    return pl.DataFrame(
        cols,
        schema={
            "wallet": pl.String,
            "mint": pl.String,
            "n_trades": pl.Int64,
            "n_buys": pl.Int64,
            "n_sells": pl.Int64,
            "quote_in": pl.Float64,
            "quote_out": pl.Float64,
            "realized_pnl": pl.Float64,
            "uncosted_sell_quote": pl.Float64,
            "residual_base": pl.Float64,
            "residual_cost_quote": pl.Float64,
            "mean_hold_s": pl.Float64,
            "first_ts": pl.Int64,
            "last_ts": pl.Int64,
            "alternation": pl.Float64,
            "size_cv": pl.Float64,
            "buy_size_cv": pl.Float64,
            "gap_cv": pl.Float64,
        },
    )


def crawl_dataset(dataset_root: Path, *, quote_mint: str = WSOL) -> pl.DataFrame:
    """Scan a captured dataset (READ-ONLY) into the per-(wallet, token) census stats table."""
    return build_pair_stats(scan_swaps(dataset_root, quote_mint=quote_mint).collect())


__all__ = ["scan_swaps", "build_pair_stats", "crawl_dataset"]
