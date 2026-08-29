"""Does the co-occurrence signal survive a point-in-time roster? (09 §8.1 — the live-wiring blocker)

PROGRESS 2026-08-28 (iv) found the strongest number this program has produced: the count of
"smart" wallets among a token's early buyers separates its out-of-sample >10x rate 0.003 -> 0.423.
Its "Open" section named the flaw: the smart label ranked wallets by earliness measured against
each token's **whole-tape peak** — and for tokens whose tape straddles the period-A/B boundary,
that peak includes period-B prices. The ranking therefore saw a sliver of the future it was
supposed to be blind to. 09-cooccurrence-feature.md §4(b) makes fixing this a PRECONDITION for
wiring the feature live.

THE INTERVENTION IS ONE LINE OF DATA FLOW. ``add_earliness(pairs, trades)`` computes peaks and
queue positions from whatever tape it is handed:

  * ``hindsight`` arm — the full tape, replicating (iv)'s construction.
  * ``pit`` arm — the tape truncated at the boundary T, so period-A earliness is computed only
    from prices and trades that existed at T. Nothing else differs.

Everything downstream — the boundary itself, the smart-quintile rule, the period-B token set, the
early-buyer window, the outcome measure — is shared code shared by both arms, so any difference in
the tables is attributable to the leak and only the leak.

HONESTY NOTES, up front rather than buried:

  * The original (iv) script was not preserved; the hindsight arm is a **replication of its
    described method**, not a bit-identical rerun. The ranking rule is stated explicitly here:
    wallets with >= MIN_PAIRS usable period-A pairs, ranked by median ``entry_price_pct_of_peak``
    (lower = earlier), earliest ROSTER_QUANTILE = smart. If the replicated hindsight table does
    not broadly reproduce (iv)'s shape, that discrepancy is itself a finding to report.
  * The outcome (``token p99 peak / first price`` over the period-B tape) is still "did it run",
    not "could you have traded it" — 09 §8.2's fee-net re-measure remains open regardless of what
    this script finds.
  * Same single ~21h capture as (iv); nothing here says anything about longer horizons.

Usage:
    uv run python scripts/pit_roster_check.py                     # market_dataset_large, both arms
    uv run python scripts/pit_roster_check.py --dataset data/market_dataset
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import polars as pl

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from oct_trading_agent.data.census.crawler import scan_swaps  # noqa: E402
from oct_trading_agent.data.census.earliness import EarlinessConfig, add_earliness  # noqa: E402

# --- The study's fixed knobs (mirroring PROGRESS (iv); change = different study) ---------------
MIN_PAIRS = 3            # a wallet needs >=3 usable period-A pairs to be rankable
ROSTER_QUANTILE = 0.20   # earliest quintile of rankable wallets = "smart"
EARLY_WINDOW = 0.20      # a period-B "early buyer" entered inside the first 20% of the queue
MIN_EARLY_BUYERS = 5     # tokens with fewer early buyers are not scored
MIN_TOKEN_TRADES = 8     # matches EarlinessConfig.min_trades_per_token
BANDS = [(0, 0, "0"), (1, 1, "1"), (2, 3, "2-3"), (4, 6, "4-6"), (7, 10**9, "7+")]


def first_buys(trades: pl.DataFrame) -> pl.DataFrame:
    """Per (wallet, mint): the first BUY's price and ts — the pair frame both arms rank from."""
    buys = trades.filter(pl.col("is_buy") & (pl.col("base") > 0)).with_columns(
        (pl.col("quote") / pl.col("base")).alias("price")
    )
    return (
        buys.sort("ts")
        .group_by(["wallet", "mint"], maintain_order=True)
        .agg(
            pl.col("price").first().alias("first_buy_price"),
            pl.col("ts").first().alias("first_buy_ts"),
        )
    )


def smart_roster(trades_for_ranking: pl.DataFrame, pairs_a: pl.DataFrame) -> pl.DataFrame:
    """The earliest-quintile wallet set, computed from the given tape.

    ``trades_for_ranking`` is the ONLY thing that differs between arms: full tape (hindsight)
    vs pre-boundary tape (pit). ``pairs_a`` is the same period-A pair frame for both.
    """
    scored = add_earliness(pairs_a, trades_for_ranking, EarlinessConfig())
    per_wallet = (
        scored.filter(pl.col("entry_price_pct_of_peak").is_not_null())
        .group_by("wallet")
        .agg(
            pl.col("entry_price_pct_of_peak").median().alias("median_entry_pct"),
            pl.len().alias("usable_pairs"),
        )
        .filter(pl.col("usable_pairs") >= MIN_PAIRS)
    )
    cutoff = per_wallet["median_entry_pct"].quantile(ROSTER_QUANTILE)
    return per_wallet.filter(pl.col("median_entry_pct") <= cutoff).select("wallet")


def period_b_tokens(trades: pl.DataFrame, boundary_ts: int) -> pl.DataFrame:
    """Per period-B token: its early-buyer set size hook, run multiple, and queue bookkeeping.

    A period-B token is one whose FIRST trade is after the boundary — the ranking, in either arm,
    never saw a single event of it. Run = p99 peak / first price over its own (all-post-T) tape.
    """
    priced = trades.filter(pl.col("base") > 0).with_columns(
        (pl.col("quote") / pl.col("base")).alias("price")
    )
    tok = priced.group_by("mint").agg(
        pl.col("ts").min().alias("token_first_ts"),
        pl.col("price").sort_by("ts").first().alias("first_price"),
        pl.col("price").quantile(0.99).alias("peak_p99"),
        pl.len().alias("token_trades"),
    )
    return tok.filter(
        (pl.col("token_first_ts") > boundary_ts)
        & (pl.col("token_trades") >= MIN_TOKEN_TRADES)
        & (pl.col("first_price") > 0)
    ).with_columns((pl.col("peak_p99") / pl.col("first_price")).alias("run"))


def early_buyers(trades: pl.DataFrame, tokens_b: pl.DataFrame) -> pl.DataFrame:
    """(mint, wallet) rows for buyers inside the first EARLY_WINDOW of each period-B token's queue."""
    b_mints = tokens_b.select("mint")
    priced = (
        trades.join(b_mints, on="mint", how="inner")
        .filter(pl.col("base") > 0)
        .sort(["mint", "ts"])
        .with_columns(pl.int_range(pl.len()).over("mint").alias("queue_pos"))
    )
    fb = (
        priced.filter(pl.col("is_buy"))
        .group_by(["mint", "wallet"])
        .agg(pl.col("queue_pos").min().alias("first_buy_pos"))
    )
    return (
        fb.join(tokens_b.select("mint", "token_trades"), on="mint")
        .filter(pl.col("first_buy_pos") < EARLY_WINDOW * pl.col("token_trades"))
        .select("mint", "wallet")
    )


def band_table(scored_tokens: pl.DataFrame) -> pl.DataFrame:
    rows = []
    for lo, hi, label in BANDS:
        seg = scored_tokens.filter(
            (pl.col("smart_count") >= lo) & (pl.col("smart_count") <= hi)
        )
        if len(seg) == 0:
            rows.append({"smart": label, "tokens": 0, "median_run": None, ">2x": None, ">10x": None})
            continue
        rows.append(
            {
                "smart": label,
                "tokens": len(seg),
                "median_run": round(float(seg["run"].median()), 2),
                ">2x": round(float((seg["run"] > 2).mean()), 3),
                ">10x": round(float((seg["run"] > 10).mean()), 3),
            }
        )
    return pl.DataFrame(rows)


def share_control_table(scored_tokens: pl.DataFrame) -> pl.DataFrame:
    """The (iv) confound check: within early-buyer-count bands, does smart SHARE still separate?"""
    rows = []
    for lo, hi, label in [(5, 9, "5-9"), (10, 19, "10-19"), (20, 49, "20-49"), (50, 10**9, "50+")]:
        seg = scored_tokens.filter(
            (pl.col("early_buyers") >= lo) & (pl.col("early_buyers") <= hi)
        )
        if len(seg) < 10:
            continue
        med_share = seg["smart_share"].median()
        low, high = seg.filter(pl.col("smart_share") <= med_share), seg.filter(
            pl.col("smart_share") > med_share
        )
        if len(low) == 0 or len(high) == 0:
            continue
        rows.append(
            {
                "early_buyers": label,
                "low_n/high_n": f"{len(low)}/{len(high)}",
                "low_med_run": round(float(low["run"].median()), 2),
                "high_med_run": round(float(high["run"].median()), 2),
                "low_>10x": round(float((low["run"] > 10).mean()), 3),
                "high_>10x": round(float((high["run"] > 10).mean()), 3),
            }
        )
    return pl.DataFrame(rows)


def run_arm(name: str, trades: pl.DataFrame, pairs: pl.DataFrame, boundary_ts: int) -> pl.DataFrame:
    pairs_a = pairs.filter(pl.col("first_buy_ts") <= boundary_ts)
    ranking_tape = trades if name == "hindsight" else trades.filter(pl.col("ts") <= boundary_ts)
    roster = smart_roster(ranking_tape, pairs_a)
    print(f"\n[{name}] roster: {len(roster)} smart wallets "
          f"(ranking tape: {'full — replicates (iv)' if name == 'hindsight' else 'truncated at T'})",
          flush=True)

    tokens_b = period_b_tokens(trades, boundary_ts)
    eb = early_buyers(trades, tokens_b)
    counts = eb.group_by("mint").agg(pl.len().alias("early_buyers"))
    smart_counts = (
        eb.join(roster, on="wallet", how="inner").group_by("mint").agg(pl.len().alias("smart_count"))
    )
    scored = (
        tokens_b.join(counts, on="mint", how="inner")
        .filter(pl.col("early_buyers") >= MIN_EARLY_BUYERS)
        .join(smart_counts, on="mint", how="left")
        .with_columns(pl.col("smart_count").fill_null(0))
        .with_columns((pl.col("smart_count") / pl.col("early_buyers")).alias("smart_share"))
    )
    print(f"[{name}] period-B tokens scored: {len(scored)}", flush=True)
    print(band_table(scored), flush=True)
    print(f"[{name}] share control (within early-buyer bands, low vs high smart share):", flush=True)
    print(share_control_table(scored), flush=True)
    return roster


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dataset", type=Path, default=REPO / "data" / "market_dataset_large")
    args = ap.parse_args()

    print(f"[pit-check] loading {args.dataset.name}...", flush=True)
    trades = scan_swaps(args.dataset).collect()
    pairs = first_buys(trades)
    boundary_ts = int(pairs["first_buy_ts"].median())
    n_a = len(pairs.filter(pl.col("first_buy_ts") <= boundary_ts))
    print(f"[pit-check] {len(trades)} trades, {len(pairs)} pairs; boundary T = median first-buy ts "
          f"({n_a} period-A pairs)", flush=True)

    roster_h = run_arm("hindsight", trades, pairs, boundary_ts)
    roster_p = run_arm("pit", trades, pairs, boundary_ts)

    inter = len(set(roster_h["wallet"]) & set(roster_p["wallet"]))
    print(f"\n[pit-check] roster overlap: {inter} wallets in both "
          f"({inter/max(1,len(roster_h)):.1%} of hindsight, {inter/max(1,len(roster_p)):.1%} of pit)",
          flush=True)

    # Export the PIT roster as a WalkForwardRosterProvider snapshot: every wallet here was ranked
    # only from data <= effective_from_ts, so loading it with that effective_from is leakage-safe
    # by construction (09 §4a). One snapshot only — a rolling refresh needs a longer capture.
    out_path = args.dataset.parent / "pit_smart_roster.csv"
    roster_p.with_columns(pl.lit(boundary_ts).alias("effective_from_ts")).write_csv(out_path)
    print(f"[pit-check] PIT roster snapshot -> {out_path} "
          f"({len(roster_p)} wallets, effective_from={boundary_ts})", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
