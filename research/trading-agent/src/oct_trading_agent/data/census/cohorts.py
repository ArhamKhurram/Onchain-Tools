"""Cohort extraction — cross-token quartile ranking, wash filtering, and gene-pool exports.

Takes the crawler's per-(wallet, token) FIFO stats and applies the two honesty steers the
operator's gene-pool idea needs (paper §9.3 — this harvest is the data-driven answer to the
operator-picked cohort):

* **Cross-token ranking.** Within each token (with at least ``min_wallets_per_token``
  participants), wallets are percentile-ranked by realized PnL. A *winner* is a wallet repeatedly
  in the top quartile (``>= min_tokens_ranked`` top-quartile placements, each requiring positive
  realized PnL) — never a one-token peak. One-token wonders are recorded and flagged, not
  cohorted. *Losers* mirror it in the bottom quartile with negative realized PnL. *Holders* are a
  separate dimension — top net-accumulators by quote still deployed in unclosed lots — tagged
  distinctly because their "PnL" is largely unrealized and the census refuses to mark it.
* **Wash/sybil filter.** Per-wallet structural heuristics (self-ping-pong at near-constant size,
  metronomic inter-arrival, single-token-only hyperactivity, machine-scale trade count for the
  capture window — the multi-token arb/MEV shape the first three miss) EXCLUDE a wallet from every
  cohort;
  flagged wallets land in a ``suspects`` bucket with their reasons. **What this cannot catch,
  stated plainly:** fresh-wallet sybils (one entity split across many signers, each individually
  organic-looking), cross-wallet wash rings, and cost-basis laundering via token transfers (the
  FIFO engine's uncosted-sell exclusion blunts, but does not eliminate, that one). The filter
  reduces, it does not eliminate — same identification limit as the flow-level suspicion channel
  (:mod:`oct_trading_agent.agent.encoders.manipulation`, §9.10).

Exports are written in the **operator-export (wallets-file) shape** that
:func:`oct_trading_agent.data.labeling.wallets_file.parse_tracked_wallets` already reads, so the
ENTIRE existing BC pipeline consumes a harvested cohort unchanged. ``fundingInfo.nativeBalance``
carries the cohort's own ranking score (winners: total realized PnL; losers: loss magnitude;
holders: residual cost deployed) so ``select_cohort`` orders by census merit instead of wealth —
documented here because the field name says "balance" and the value deliberately is not one.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import polars as pl


@dataclass(frozen=True)
class CensusConfig:
    """Knobs for ranking, cohort admission, and the wash filter (defaults sized for snap800)."""

    min_wallets_per_token: int = 8  # below this, a token's quartiles are noise — not ranked
    min_tokens_ranked: int = 3  # N: repeated-quartile placements required to cohort
    top_quantile: float = 0.75
    bottom_quantile: float = 0.25
    max_cohort: int = 200  # per-cohort export cap (keeps downstream pulls bounded)
    holder_min_tokens: int = 2  # single-token holders are usually the dev/insiders
    # Wash-filter thresholds (structural, per wallet):
    ping_pong_min_trades: int = 20
    ping_pong_alternation: float = 0.8
    ping_pong_size_cv: float = 0.05
    metronome_min_trades: int = 20
    metronome_gap_cv: float = 0.15
    hyperactive_single_token_trades: int = 100
    # Machine-scale total trade count for the capture window. Sized for snap800's ~7-hour window
    # (2,000 ≈ a trade every 13s, nonstop — no human); SCALE THIS UP for longer captures.
    machine_trade_count: int = 2000


@dataclass(frozen=True)
class CensusCohorts:
    """The extracted gene pool: census tables plus the four buckets."""

    pairs: pl.DataFrame  # per-(wallet, token), quartile-annotated
    wallets: pl.DataFrame  # per-wallet cross-token aggregate, flags included
    winners: pl.DataFrame
    losers: pl.DataFrame
    holders: pl.DataFrame
    suspects: pl.DataFrame


def add_quartiles(pairs: pl.DataFrame, config: CensusConfig) -> pl.DataFrame:
    """Annotate each (wallet, token) row with its within-token realized-PnL percentile + flags.

    ``ranked`` is only true on tokens with enough participants; ``top_q`` additionally requires
    positive realized PnL (top-quartile of an all-losing token is "least bad", not a winner) and
    ``bottom_q`` requires negative realized PnL, symmetrically.
    """
    annotated = pairs.with_columns(
        pl.len().over("mint").alias("token_wallets"),
        pl.col("realized_pnl").rank(method="average").over("mint").alias("pnl_rank"),
    ).with_columns(
        (pl.col("token_wallets") >= config.min_wallets_per_token).alias("ranked"),
        pl.when(pl.col("token_wallets") > 1)
        .then((pl.col("pnl_rank") - 1) / (pl.col("token_wallets") - 1))
        .otherwise(0.5)
        .alias("pnl_pct"),
    )
    return annotated.with_columns(
        (
            pl.col("ranked")
            & (pl.col("pnl_pct") >= config.top_quantile)
            & (pl.col("realized_pnl") > 0)
        ).alias("top_q"),
        (
            pl.col("ranked")
            & (pl.col("pnl_pct") <= config.bottom_quantile)
            & (pl.col("realized_pnl") < 0)
        ).alias("bottom_q"),
    )


#: A pair counts as an EARLY entry when the wallet bought at or below this fraction of the token's
#: exitable peak. 0.10 = "got in with a 10x still on the table". Deliberately strict: the point of
#: the count is to separate wallets that repeatedly find things early from wallets that were
#: occasionally lucky, and a loose threshold makes almost everyone look early.
EARLY_ENTRY_PCT_OF_PEAK = 0.10


def _earliness_aggs(pairs: pl.DataFrame, config: CensusConfig) -> list[pl.Expr]:
    """Per-wallet earliness rollups — empty when the pair frame predates the earliness pass.

    Returned as expressions rather than folded into the aggregate so a census run over an older
    pairs parquet keeps working instead of raising on a missing column.
    """
    if "entry_price_pct_of_peak" not in pairs.columns:
        return []
    return [
        # MEDIAN, not mean: one 500x outlier would otherwise define a wallet's whole profile.
        pl.col("entry_price_pct_of_peak").median().alias("median_entry_pct_of_peak"),
        pl.col("max_multiple_available").median().alias("median_max_multiple"),
        pl.col("entry_trade_rank_pct").median().alias("median_entry_rank_pct"),
        (pl.col("entry_price_pct_of_peak") <= EARLY_ENTRY_PCT_OF_PEAK)
        .sum()
        .alias("early_entries"),
        pl.col("entry_price_pct_of_peak").is_not_null().sum().alias("tokens_with_earliness"),
    ]


def aggregate_wallets(pairs: pl.DataFrame, config: CensusConfig) -> pl.DataFrame:
    """Aggregate quartile-annotated pairs per wallet ACROSS tokens, with wash + wonder flags."""
    pair_ping = (
        (pl.col("n_trades") >= config.ping_pong_min_trades)
        & (pl.col("alternation") >= config.ping_pong_alternation)
        & pl.col("buy_size_cv").is_not_null()
        & (pl.col("buy_size_cv") <= config.ping_pong_size_cv)
    )
    pair_metro = (
        (pl.col("n_trades") >= config.metronome_min_trades)
        & pl.col("gap_cv").is_not_null()
        & (pl.col("gap_cv") <= config.metronome_gap_cv)
    )
    agg = pairs.group_by("wallet").agg(
        pl.len().alias("tokens_touched"),
        pl.col("ranked").sum().alias("tokens_ranked"),
        pl.col("top_q").sum().alias("top_q_count"),
        pl.col("bottom_q").sum().alias("bottom_q_count"),
        pl.col("realized_pnl").sum().alias("total_realized"),
        pl.col("realized_pnl").median().alias("median_realized"),
        (pl.col("realized_pnl") > 0).sum().alias("profitable_tokens"),
        pl.col("n_trades").sum().alias("n_trades"),
        (pl.col("n_sells") > 0).sum().alias("tokens_with_sells"),
        pl.col("residual_cost_quote").sum().alias("residual_cost_quote"),
        pl.col("uncosted_sell_quote").sum().alias("uncosted_sell_quote"),
        pl.col("mean_hold_s").mean().alias("mean_hold_s"),
        pair_ping.any().alias("flag_ping_pong"),
        pair_metro.any().alias("flag_metronome"),
        *_earliness_aggs(pairs, config),
    )
    return agg.with_columns(
        (
            (pl.col("tokens_touched") == 1)
            & (pl.col("n_trades") >= config.hyperactive_single_token_trades)
        ).alias("flag_hyperactive"),
        (pl.col("n_trades") >= config.machine_trade_count).alias("flag_machine"),
        (pl.col("profitable_tokens") / pl.col("tokens_touched")).alias("consistency"),
    ).with_columns(
        (
            pl.col("flag_ping_pong")
            | pl.col("flag_metronome")
            | pl.col("flag_hyperactive")
            | pl.col("flag_machine")
        ).alias("suspect"),
        (
            (pl.col("top_q_count") >= 1)
            & (pl.col("tokens_ranked") < config.min_tokens_ranked)
        ).alias("one_token_wonder"),
    )


def extract_cohorts(pairs: pl.DataFrame, config: CensusConfig | None = None) -> CensusCohorts:
    """Rank, aggregate, filter — the full harvest from per-pair stats to the four buckets."""
    cfg = config or CensusConfig()
    annotated = add_quartiles(pairs, cfg)
    wallets = aggregate_wallets(annotated, cfg)
    clean = wallets.filter(~pl.col("suspect"))
    winners = (
        clean.filter(
            (pl.col("top_q_count") >= cfg.min_tokens_ranked)
            & (pl.col("tokens_ranked") >= cfg.min_tokens_ranked)
            & (pl.col("total_realized") > 0)
        )
        .sort("total_realized", descending=True)
        .head(cfg.max_cohort)
    )
    losers = (
        clean.filter(
            (pl.col("bottom_q_count") >= cfg.min_tokens_ranked)
            & (pl.col("tokens_ranked") >= cfg.min_tokens_ranked)
            & (pl.col("total_realized") < 0)
        )
        .sort("total_realized")
        .head(cfg.max_cohort)
    )
    holders = (
        clean.filter(
            (pl.col("residual_cost_quote") > 0)
            & (pl.col("tokens_touched") >= cfg.holder_min_tokens)
        )
        .sort("residual_cost_quote", descending=True)
        .head(cfg.max_cohort)
    )
    suspects = wallets.filter(pl.col("suspect"))
    return CensusCohorts(
        pairs=annotated,
        wallets=wallets,
        winners=winners,
        losers=losers,
        holders=holders,
        suspects=suspects,
    )


def _suspect_reasons(row: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    if row.get("flag_ping_pong"):
        reasons.append("ping-pong: buy/sell alternation at near-constant size")
    if row.get("flag_metronome"):
        reasons.append("metronomic inter-arrival times")
    if row.get("flag_hyperactive"):
        reasons.append("single-token hyperactivity")
    if row.get("flag_machine"):
        reasons.append("machine-scale trade count for the capture window (arb/MEV-like flow)")
    return reasons


_RANK_FIELD: dict[str, str] = {
    "winner": "total_realized",
    "loser": "total_realized",
    "holder": "residual_cost_quote",
    "suspect": "n_trades",
}


def to_wallets_file_rows(cohort: pl.DataFrame, kind: str) -> list[dict[str, Any]]:
    """Render one cohort in the operator-export shape ``parse_tracked_wallets`` reads.

    ``fundingInfo.nativeBalance`` is the cohort's ranking score (absolute value, so
    ``select_cohort``'s ``min_balance >= 0`` never drops a loser) — NOT a SOL balance. Every row
    carries its full census stats under ``census`` (unknown keys are ignored by the parser).
    """
    rows: list[dict[str, Any]] = []
    rank_field = _RANK_FIELD[kind]
    for i, rec in enumerate(cohort.to_dicts()):
        entry: dict[str, Any] = {
            "address": rec["wallet"],
            "name": f"census-{kind}-{i + 1:03d}",
            "chain": "solana",
            "fundingInfo": {"nativeBalance": abs(float(rec[rank_field]))},
            "labels": [f"census-{kind}", "harvested"],
            "census": {k: v for k, v in rec.items() if k != "wallet"},
        }
        if kind == "suspect":
            entry["suspect_reasons"] = _suspect_reasons(rec)
        rows.append(entry)
    return rows


def write_census_outputs(
    cohorts: CensusCohorts,
    out_dir: Path,
    *,
    config: CensusConfig | None = None,
    source: str = "",
) -> dict[str, Path]:
    """Write the census tables (parquet) + cohort JSONs (wallets-file shape) under ``out_dir``."""
    cfg = config or CensusConfig()
    out_dir.mkdir(parents=True, exist_ok=True)
    paths: dict[str, Path] = {}

    pairs_path = out_dir / "census_pairs.parquet"
    cohorts.pairs.write_parquet(pairs_path)
    paths["pairs"] = pairs_path
    wallets_path = out_dir / "census_wallets.parquet"
    cohorts.wallets.write_parquet(wallets_path)
    paths["wallets"] = wallets_path

    for kind, frame in (
        ("winner", cohorts.winners),
        ("loser", cohorts.losers),
        ("holder", cohorts.holders),
        ("suspect", cohorts.suspects),
    ):
        path = out_dir / f"{kind}s.json"
        path.write_text(
            json.dumps(to_wallets_file_rows(frame, kind), indent=2), encoding="utf-8"
        )
        paths[f"{kind}s"] = path

    summary = {
        "source": source,
        "config": asdict(cfg),
        "n_pairs": cohorts.pairs.height,
        "n_wallets": cohorts.wallets.height,
        "n_tokens": int(cohorts.pairs.get_column("mint").n_unique()),
        "n_tokens_ranked": int(
            cohorts.pairs.filter(pl.col("ranked")).get_column("mint").n_unique()
        ),
        "n_winners": cohorts.winners.height,
        "n_losers": cohorts.losers.height,
        "n_holders": cohorts.holders.height,
        "n_suspects": cohorts.suspects.height,
        "n_one_token_wonders": int(
            cohorts.wallets.get_column("one_token_wonder").sum()
        ),
    }
    summary_path = out_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    paths["summary"] = summary_path
    return paths


__all__ = [
    "CensusConfig",
    "CensusCohorts",
    "add_quartiles",
    "aggregate_wallets",
    "extract_cohorts",
    "to_wallets_file_rows",
    "write_census_outputs",
]
