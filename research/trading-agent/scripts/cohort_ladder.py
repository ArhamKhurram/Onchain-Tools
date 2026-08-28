"""Cohort ladder — does training against MORE (and BETTER-CHOSEN) wallets produce a better policy?

WHY THIS EXPERIMENT EXISTS. The 1000-token tier-A run returned NO-GO, and the most useful number
in its baseline table was not the agent's: the 40 tracked wallets were the ONLY profitable policy,
on 51 trades, and beat the agent on 97% of held-out tokens. Those 40 were selected by SOL balance —
i.e. by size, not by skill. The 2026-08-28 earliness work then showed that *how a wallet is
selected* carries out-of-sample signal.

So there are two questions, and this ladder separates them:

  1. **Does cohort SIZE matter?**  Rungs at 10, 20, 30, ... wallets.
  2. **Does cohort SELECTION matter?**  Each rung runs twice — wallets ranked by earliness, and a
     size-matched control ranked by realized PnL alone. Same N, same pipeline, different choice.

Without the control arm the ladder could only say "more is better", never "better-chosen is
better", and the second is the claim actually worth testing.

METHOD. Behavioural cloning against the cohort's real decisions (`imitation/bc.py`), which is the
literal form of "train the agent against these wallets". BC reports held-out-by-token intent
accuracy and whether the resulting policy actually trades rather than collapsing to a single
intent — the from-scratch failure mode PROGRESS 2026-08-23 (e/f) documents.

EVERY WALLET AND TRADE COMES FROM DISK. `market_dataset_large` already holds the swaps, and
`LabeledTrade` maps one-to-one onto the census trade frame, so no Pinax call is made and no rate
limit applies. That also means a rung is reproducible: same dataset, same seed, same answer.

SEEDS RUN IN PARALLEL, rungs run in sequence. Each (rung x seed) is an independent process, so a
crash in one costs one cell rather than the run. Parallelism defaults to CPU-bound sizing rather
than the number of wallets — 50 concurrent trainers on one box would thrash, and the point of
repeated seeds is agreement between them, which a starved run cannot give.

Usage:
    python scripts/cohort_ladder.py --rungs 10,20,30,40,50 --seeds 5
    python scripts/cohort_ladder.py --rungs 10,20 --seeds 3 --arms earliness
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from decimal import Decimal
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

DEFAULT_DATASET = REPO / "data" / "market_dataset_large"
DEFAULT_RANKING = REPO / "data" / "early_selective_wallets.csv"
DEFAULT_OUT = REPO / "data" / "cohort_ladder"


@dataclass
class Cell:
    """One (arm, rung, seed) result — the unit a crash can cost."""

    arm: str
    n_wallets: int
    seed: int
    n_demos: int
    n_train: int
    n_val: int
    val_intent_accuracy: float
    train_loss: float
    val_loss: float
    trades: bool
    mean_size_sized: float
    expert_distribution: dict
    bc_distribution: dict
    seconds: float
    error: str | None = None


def load_ranking(path: Path) -> list[str]:
    """Wallets in earliness-rank order (best first), as written by the census export."""
    with path.open(encoding="utf-8") as fh:
        return [row["wallet"] for row in csv.DictReader(fh)]


def build_labeled_wallets(dataset: Path, wanted: set[str]) -> dict:
    """LabeledWallet objects for `wanted`, assembled from the dataset's own swaps.

    The census trade frame already carries (wallet, mint, is_buy, base, quote, ts, signature), which
    is exactly LabeledTrade's shape. Reading it here instead of calling Pinax is what keeps this
    experiment reproducible and rate-limit-free.
    """
    from oct_trading_agent.data.census.crawler import scan_swaps
    from oct_trading_agent.data.labeling.schema import LabeledTrade, LabeledWallet
    from oct_trading_agent.core import Side
    import datetime as dt

    frame = scan_swaps(dataset).collect()
    frame = frame.filter(frame["wallet"].is_in(list(wanted)))

    by_wallet: dict[str, list] = {}
    for row in frame.sort(["wallet", "ts"]).iter_rows(named=True):
        by_wallet.setdefault(row["wallet"], []).append(
            LabeledTrade(
                timestamp=dt.datetime.fromtimestamp(int(row["ts"]), dt.timezone.utc),
                mint=row["mint"],
                side=Side.BUY if row["is_buy"] else Side.SELL,
                base_amount=Decimal(str(max(0.0, float(row["base"])))),
                quote_amount=Decimal(str(max(0.0, float(row["quote"])))),
                signature=row.get("signature"),
            )
        )
    return {
        w: LabeledWallet(wallet=w, labels=["census"], trades=trades)
        for w, trades in by_wallet.items()
    }


def run_cell(arm: str, wallets: list, n: int, seed: int) -> dict:
    """Train BC for one (arm, rung, seed). Runs in its own process."""
    start = time.time()
    try:
        from oct_trading_agent.agent.imitation.bc import BCConfig, train_bc
        from oct_trading_agent.agent.imitation.demos import build_demos

        demos = build_demos(wallets)
        steps = demos.steps
        if len(steps) < 32:
            return asdict(
                Cell(arm, n, seed, len(steps), 0, 0, 0.0, 0.0, 0.0, False, 0.0, {}, {},
                     time.time() - start, error="too few demonstration steps")
            )
        result = train_bc(steps, BCConfig(seed=seed))
        return asdict(
            Cell(
                arm=arm, n_wallets=n, seed=seed,
                n_demos=result.n_demos, n_train=result.n_train, n_val=result.n_val,
                val_intent_accuracy=result.val_intent_accuracy,
                train_loss=result.train_loss, val_loss=result.val_loss,
                trades=result.trades, mean_size_sized=result.mean_size_sized,
                expert_distribution=result.expert_distribution,
                bc_distribution=result.bc_distribution,
                seconds=time.time() - start,
            )
        )
    except Exception as exc:  # one cell dies, the ladder continues
        return asdict(
            Cell(arm, n, seed, 0, 0, 0, 0.0, 0.0, 0.0, False, 0.0, {}, {},
                 time.time() - start, error=f"{type(exc).__name__}: {exc}")
        )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--rungs", default="10,20,30,40,50", help="comma-separated cohort sizes")
    ap.add_argument("--seeds", type=int, default=5, help="independent seeds per rung")
    ap.add_argument("--arms", default="earliness,pnl_control",
                    help="earliness | pnl_control | both, comma-separated")
    ap.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    ap.add_argument("--ranking", type=Path, default=DEFAULT_RANKING)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--workers", type=int, default=0,
                    help="parallel processes (0 = CPU count - 2, minimum 2)")
    args = ap.parse_args()

    rungs = [int(r) for r in args.rungs.split(",") if r.strip()]
    arms = [a.strip() for a in args.arms.split(",") if a.strip()]
    workers = args.workers or max(2, (os.cpu_count() or 4) - 2)
    args.out.mkdir(parents=True, exist_ok=True)

    ranked = load_ranking(args.ranking)
    print(f"[ladder] {len(ranked)} ranked wallets; rungs={rungs} seeds={args.seeds} "
          f"arms={arms} workers={workers}", flush=True)

    # The control arm re-ranks the SAME candidate pool by realized PnL alone, so the two arms differ
    # only in the ordering — not in which wallets were eligible.
    import polars as pl
    census = pl.read_parquet(REPO / "data" / "wallet_census_large" / "census_wallets.parquet")
    pnl_ranked = (
        census.filter(pl.col("wallet").is_in(ranked))
        .sort("total_realized", descending=True)["wallet"]
        .to_list()
    )

    order = {"earliness": ranked, "pnl_control": pnl_ranked}
    needed = {w for arm in arms for w in order[arm][: max(rungs)]}
    print(f"[ladder] loading trades for {len(needed)} wallets from {args.dataset.name}...", flush=True)
    labeled = build_labeled_wallets(args.dataset, needed)
    print(f"[ladder] {len(labeled)} wallets have trades on disk", flush=True)

    jobs = []
    for arm in arms:
        for n in rungs:
            cohort = [labeled[w] for w in order[arm][:n] if w in labeled]
            if len(cohort) < max(2, n // 2):
                print(f"[ladder] skip {arm} n={n}: only {len(cohort)} wallets have trades", flush=True)
                continue
            for seed in range(args.seeds):
                jobs.append((arm, cohort, n, seed))

    print(f"[ladder] {len(jobs)} cells to run", flush=True)
    results: list[dict] = []
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(run_cell, *job): job for job in jobs}
        for done in as_completed(futures):
            row = done.result()
            results.append(row)
            tag = "ERR " if row["error"] else "    "
            print(f"  {tag}{row['arm']:<12} n={row['n_wallets']:>3} seed={row['seed']} "
                  f"demos={row['n_demos']:>6} val_acc={row['val_intent_accuracy']:.3f} "
                  f"trades={row['trades']} {row['seconds']:.1f}s"
                  + (f"  {row['error']}" if row["error"] else ""), flush=True)
            (args.out / "cells.jsonl").open("a", encoding="utf-8").write(json.dumps(row) + "\n")

    summarise(results)
    return 0


def summarise(results: list[dict]) -> None:
    """Per (arm, rung): the mean and the SPREAD across seeds.

    The spread is the point. A single seed cannot distinguish "this cohort size is better" from
    "this seed was lucky", and the whole reason for running seeds in parallel is to see whether
    they agree.
    """
    import statistics as st

    print("\n" + "=" * 78)
    print(f"{'arm':<14}{'N':>4}{'seeds':>7}{'val_acc mean':>14}{'spread':>9}{'trades':>8}{'demos':>9}")
    print("-" * 78)
    keys = sorted({(r["arm"], r["n_wallets"]) for r in results if not r["error"]},
                  key=lambda k: (k[0], k[1]))
    for arm, n in keys:
        cells = [r for r in results if r["arm"] == arm and r["n_wallets"] == n and not r["error"]]
        accs = [c["val_intent_accuracy"] for c in cells]
        spread = (max(accs) - min(accs)) if len(accs) > 1 else 0.0
        traded = sum(1 for c in cells if c["trades"])
        demos = int(st.mean(c["n_demos"] for c in cells))
        print(f"{arm:<14}{n:>4}{len(cells):>7}{st.mean(accs):>14.3f}{spread:>9.3f}"
              f"{traded:>4}/{len(cells):<3}{demos:>9}")
    failed = [r for r in results if r["error"]]
    if failed:
        print(f"\n{len(failed)} cell(s) failed:")
        for r in failed[:8]:
            print(f"  {r['arm']} n={r['n_wallets']} seed={r['seed']}: {r['error']}")


if __name__ == "__main__":
    raise SystemExit(main())
