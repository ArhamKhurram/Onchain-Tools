"""Patiently fill the tracked-trader cohort cache so the next ladder launch starts warm.

Why this exists
---------------
The ladder resolves its cohort ONCE at startup, and the 2026-08-26 launch resolved only 8/40 —
the thin-cohort condition that makes the ``tracked_traders`` baseline degenerate.

**That was NOT rate limiting**, despite the ``SKIPPED after retries`` message reading like it. The
wallets that "failed" return HTTP 200 on a direct call, and pacing the pull ~9x gentler changed
nothing. The real cause was a deep-pagination timeout (a deep Pinax query takes ~10-12s and
intermittently exceeds a server-side limit, returning 500 — roughly independent of page size) which
combined with a data-loss bug in ``load_wallet_trades``: one failed page discarded every page already
fetched, so only wallets small enough to finish in ~2 pages ever survived. That biased the cohort
toward LOW-VOLUME traders rather than thinning it randomly. Both are fixed in ``pinax_loader.py``.

This script remains useful for the residue: whatever a single launch still misses can be filled in
out-of-band, since retrying a deep page does often succeed on a later attempt.

``resolve_cohort`` is cache-first and only pulls what the cache still lacks, and ``merge_cohorts``
unions at both the wallet and the trade level. So coverage can be built up out-of-band, slowly,
across as many rounds as it takes — and the next launch reads it in one shot with no stall.

Safety
------
The trainer touches the cache exactly once, at startup, before training. Run this AFTER the ladder
has printed ``[cohort] cached N resolved wallet(s)`` and there is no write race: the trainer will not
open that file again for the rest of the run.

This only ever ADDS coverage. A round that resolves nothing leaves the cache exactly as it was.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from oct_trading_agent.agent.imitation.cohort import load_cohort_from_pinax
from oct_trading_agent.agent.imitation.cohort_store import cohort_cache_path, read_cohort_cache
from oct_trading_agent.agent.train_market import resolve_cohort
from oct_trading_agent.data.labeling.wallets_file import parse_tracked_wallets, select_cohort


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--wallets-file", required=True)
    ap.add_argument("--max-wallets", type=int, default=40)
    ap.add_argument("--cohort-pages", type=int, default=8)
    ap.add_argument("--cohort-cache", default="data/cohort_cache")
    ap.add_argument("--rounds", type=int, default=40, help="max rounds before giving up")
    ap.add_argument(
        "--round-delay-s",
        type=float,
        default=180.0,
        help="sleep between rounds; the point is to be gentler than the trainer, not faster",
    )
    ap.add_argument(
        "--inter-request-delay-s",
        type=float,
        default=3.0,
        help="per-request pacing (trainer default is 0.35; gentler here, though pacing was NOT the bug)",
    )
    ap.add_argument("--max-retries", type=int, default=8)
    ap.add_argument("--base-delay-s", type=float, default=4.0)
    args = ap.parse_args()

    def log(msg: str) -> None:
        # ASCII-safe: this may run under a cp1252 console.
        print(msg.encode("ascii", "replace").decode("ascii"), flush=True)

    # parse_tracked_wallets takes the PATH (or an already-parsed list) — not the file's text.
    # Passing the contents makes it try to open them as a filename, which fails with the whole
    # export echoed into the traceback.
    wf = Path(args.wallets_file)
    tracked = parse_tracked_wallets(wf)
    cohort = select_cohort(tracked, max_wallets=args.max_wallets)
    target = {w.address for w in cohort}

    cache_path = cohort_cache_path(
        Path(args.cohort_cache),
        wallets_file=wf,
        max_wallets=args.max_wallets,
        max_pages=args.cohort_pages,
    )
    log(f"[warm] target cohort  : {len(target)} wallets")
    log(f"[warm] cache path     : {cache_path}")

    def pull(missing):
        return load_cohort_from_pinax(
            missing,
            max_pages=args.cohort_pages,
            inter_request_delay_s=args.inter_request_delay_s,
            max_retries=args.max_retries,
            base_delay_s=args.base_delay_s,
            cache_dir=Path(args.cohort_cache),
            log=log,
        )

    # read_cohort_cache returns a plain list[LabeledWallet] and never raises. Note LabeledWallet's
    # address field is `.wallet` — TrackedWallet's is `.address`.
    def cached_addresses() -> set[str]:
        return {w.wallet for w in read_cohort_cache(cache_path, log=log)}

    prev = -1
    for rnd in range(1, args.rounds + 1):
        have = len(cached_addresses())
        if have >= len(target):
            log(f"[warm] round {rnd}: cache already covers all {have} wallets - done.")
            return 0
        if have == prev:
            log(f"[warm] round {rnd}: no progress last round (still {have}) - continuing anyway.")
        prev = have
        log(f"[warm] round {rnd}: cache has {have}/{len(target)}; pulling the remainder")

        try:
            resolve_cohort(
                cohort,
                pull=pull,
                cache_path=cache_path,
                max_wallets=args.max_wallets,
                max_pages=args.cohort_pages,
                log=log,
            )
        except Exception as exc:
            log(f"[warm] round {rnd} raised {type(exc).__name__}: {exc} - retrying next round")

        now = len(cached_addresses())
        log(f"[warm] round {rnd}: cache now {now}/{len(target)} (+{now - have})")
        if now >= len(target):
            log("[warm] full coverage reached - done.")
            return 0
        if rnd < args.rounds:
            log(f"[warm] sleeping {args.round_delay_s:.0f}s before round {rnd + 1}")
            time.sleep(args.round_delay_s)

    log(f"[warm] gave up after {args.rounds} rounds; cache retains whatever it accumulated.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
