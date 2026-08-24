"""Gene-pool seam — load a harvested census cohort into the existing BC pipeline, offline.

A cohort JSON written by :func:`~.cohorts.write_census_outputs` is already in the operator-export
shape, so the **live** path needs nothing new::

    python -m oct_trading_agent.agent.imitation.cohort \
        --wallets-file data/wallet_census/winners.json --max-wallets 40

(``select_cohort`` there ranks by ``fundingInfo.nativeBalance``, which the census fills with the
cohort's ranking score — so "top by balance" becomes "top by cross-token realized PnL".)

But the census was computed FROM a local capture — every cohort wallet's trades are already on
disk. This module is the offline seam: rebuild each cohort wallet's :class:`LabeledWallet` straight
from the dataset parquets (same normalization as the crawler), skipping the Pinax re-pull
entirely. The offline BC recipe end-to-end::

    from oct_trading_agent.agent.imitation.cohort import format_report, run_cohort_imitation
    from oct_trading_agent.data.census.loader import load_cohort_wallets

    wallets = load_cohort_wallets("data/wallet_census/winners.json",
                                  "data/market_dataset_snap800", max_wallets=40)
    print(format_report(run_cohort_imitation(wallets)))

The same invocation with ``losers.json`` builds **loser-clones as eval baselines** — a floor an
admitted agent must beat. That is the bottom cohort's first honest use; "invert the losers" is NOT
implemented (inverting a losing strategy still pays spread/fees/impact both ways), and winner-vs-
loser discrimination (GAIL-style) is deferred to the wallet-flow tier.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import polars as pl

from oct_trading_agent.core.enums import Side
from oct_trading_agent.data.labeling.schema import LabeledTrade, LabeledWallet
from oct_trading_agent.data.labeling.wallets_file import (
    TrackedWallet,
    parse_tracked_wallets,
    select_cohort,
)
from oct_trading_agent.data.pinax_client.decode import WSOL

from .crawler import scan_swaps


def load_cohort_file(path: Path | str, *, max_wallets: int = 40) -> list[TrackedWallet]:
    """Parse a census cohort JSON via the operator-export parser and take the top ``max_wallets``.

    Ranking is ``select_cohort``'s — by ``nativeBalance``, which a census export fills with the
    cohort's own score (realized PnL / loss magnitude / residual cost), so this is a merit ranking.
    """
    return select_cohort(parse_tracked_wallets(path), max_wallets=max_wallets)


def build_labeled_wallets(
    addresses: list[str],
    dataset_root: Path | str,
    *,
    labels: list[str] | None = None,
    quote_mint: str = WSOL,
) -> list[LabeledWallet]:
    """Rebuild ``addresses``' full WSOL-quoted trade histories from a captured dataset (offline).

    Same normalization as the census crawler (WSOL-paired legs only, fills of one signature
    collapsed), mapped onto :class:`LabeledTrade` so ``build_trajectories`` → ``build_demos`` →
    ``train_bc`` consume the harvest exactly like an operator-export pull. Full histories — wins
    AND losses — nothing hindsight-filtered (04-data-spec leakage rule 7).
    """
    wanted = set(addresses)
    df = (
        scan_swaps(Path(dataset_root), quote_mint=quote_mint)
        .filter(pl.col("wallet").is_in(list(wanted)))
        .collect()
        .sort(["wallet", "ts", "signature"])
    )
    trades_by_wallet: dict[str, list[LabeledTrade]] = {a: [] for a in addresses}
    for rec in df.to_dicts():
        trades_by_wallet[str(rec["wallet"])].append(
            LabeledTrade(
                timestamp=datetime.fromtimestamp(int(rec["ts"]), tz=UTC),
                mint=str(rec["mint"]),
                side=Side.BUY if rec["is_buy"] else Side.SELL,
                base_amount=Decimal(str(rec["base"])),
                quote_amount=Decimal(str(rec["quote"])),
                signature=str(rec["signature"]),
            )
        )
    tags = list(labels or ["census-harvested"])
    return [
        LabeledWallet(wallet=address, labels=tags, trades=trades_by_wallet[address])
        for address in addresses
    ]


def load_cohort_wallets(
    cohort_file: Path | str,
    dataset_root: Path | str,
    *,
    max_wallets: int = 40,
    quote_mint: str = WSOL,
) -> list[LabeledWallet]:
    """Cohort JSON + captured dataset → BC-ready :class:`LabeledWallet`\\ s, no network."""
    tracked = load_cohort_file(cohort_file, max_wallets=max_wallets)
    return build_labeled_wallets(
        [tw.address for tw in tracked],
        dataset_root,
        labels=["census-harvested"],
        quote_mint=quote_mint,
    )


__all__ = ["load_cohort_file", "build_labeled_wallets", "load_cohort_wallets"]
