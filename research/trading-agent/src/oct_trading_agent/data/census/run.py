"""Census CLI — crawl a captured dataset, extract the gene-pool cohorts, write + report.

Usage (READ-ONLY over the dataset; writes only under ``--out``)::

    python -m oct_trading_agent.data.census.run \
        --dataset data/market_dataset_snap800 --out data/wallet_census

The report leads with the honesty framing: cohorts are cross-token quartile REPEATERS by realized
FIFO PnL (never one-token peaks, never unrealized marks), wash-flagged wallets are excluded into a
suspects bucket, and the whole harvest is the data-driven cohort answering the §9.3 operator-
selection caveat.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import polars as pl

from .cohorts import CensusConfig, extract_cohorts, write_census_outputs
from .crawler import crawl_dataset


def format_census_report(
    cohorts_summary: dict[str, object], winners: pl.DataFrame, *, sample: int = 5
) -> str:
    """Render the census result: sizes, then a short top-winners sample (short-form wallets)."""
    width = 96
    lines = [
        "=" * width,
        "OCT trading-agent — WALLET CENSUS (data-driven gene-pool harvest, paper §9.3)",
        "=" * width,
    ]
    for key in (
        "n_pairs",
        "n_wallets",
        "n_tokens",
        "n_tokens_ranked",
        "n_winners",
        "n_losers",
        "n_holders",
        "n_suspects",
        "n_one_token_wonders",
    ):
        lines.append(f"{key:<22}: {cohorts_summary.get(key)}")
    lines.append("-" * width)
    lines.append(f"top {sample} winners (by cross-token realized PnL, wash-filtered):")
    for rec in winners.head(sample).to_dicts():
        wallet = str(rec["wallet"])
        lines.append(
            f"  {wallet[:4]}..{wallet[-4:]}  realized {float(rec['total_realized']):+9.3f} SOL  "
            f"top-quartile on {rec['top_q_count']}/{rec['tokens_ranked']} ranked tokens  "
            f"({rec['tokens_touched']} touched, consistency {float(rec['consistency']):.2f}, "
            f"{rec['n_trades']} trades)"
        )
    lines.append("=" * width)
    return "\n".join(lines)


def main() -> int:  # pragma: no cover - CLI wiring (the pieces it calls are unit-tested)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", default="data/market_dataset_snap800")
    parser.add_argument("--out", default="data/wallet_census")
    parser.add_argument("--min-wallets-per-token", type=int, default=8)
    parser.add_argument("--min-tokens-ranked", type=int, default=3)
    parser.add_argument("--max-cohort", type=int, default=200)
    args = parser.parse_args()

    config = CensusConfig(
        min_wallets_per_token=args.min_wallets_per_token,
        min_tokens_ranked=args.min_tokens_ranked,
        max_cohort=args.max_cohort,
    )
    print(f"crawling {args.dataset} (read-only)...")
    pairs = crawl_dataset(Path(args.dataset))
    print(f"  {pairs.height} (wallet, token) pairs")
    cohorts = extract_cohorts(pairs, config)
    paths = write_census_outputs(cohorts, Path(args.out), config=config, source=args.dataset)
    import json

    summary = json.loads(paths["summary"].read_text(encoding="utf-8"))
    print(format_census_report(summary, cohorts.winners))
    print(f"outputs -> {paths['summary'].parent}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    import sys

    sys.exit(main())


__all__ = ["format_census_report", "main"]
