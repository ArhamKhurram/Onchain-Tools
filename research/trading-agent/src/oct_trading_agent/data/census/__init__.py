"""Wallet census — harvest data-driven cohorts (winners / losers / holders) from captured swaps.

The operator's gene-pool idea, made honest: FIFO realized-only PnL per (wallet, token)
(:mod:`.fifo`), crawled over a captured dataset (:mod:`.crawler`), ranked cross-token with a
wash/sybil filter (:mod:`.cohorts`), and exported in the operator-export shape so the existing BC
pipeline consumes the harvest unchanged (:mod:`.loader`). This is the designed answer to the
paper's §9.3 cohort-selection caveat.
"""

from .cohorts import (
    CensusCohorts,
    CensusConfig,
    add_quartiles,
    aggregate_wallets,
    extract_cohorts,
    to_wallets_file_rows,
    write_census_outputs,
)
from .crawler import build_pair_stats, crawl_dataset, scan_swaps
from .fifo import PairPnL, fifo_pair_pnl
from .loader import build_labeled_wallets, load_cohort_file, load_cohort_wallets

__all__ = [
    "PairPnL",
    "fifo_pair_pnl",
    "scan_swaps",
    "build_pair_stats",
    "crawl_dataset",
    "CensusConfig",
    "CensusCohorts",
    "add_quartiles",
    "aggregate_wallets",
    "extract_cohorts",
    "to_wallets_file_rows",
    "write_census_outputs",
    "load_cohort_file",
    "build_labeled_wallets",
    "load_cohort_wallets",
]
