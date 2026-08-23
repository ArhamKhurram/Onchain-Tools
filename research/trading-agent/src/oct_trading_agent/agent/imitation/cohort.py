"""Cohort imitation report — pull a bounded set of tracked traders, build demos, BC, and report.

The Phase-2 "learn from traders" first pass, end-to-end: take the operator's tracked-wallet export,
select a bounded high-balance cohort, pull each trader's full swap history from Pinax, reconstruct
per-token episodes (wins AND losses), build env-aligned demonstrations, behavioral-clone the hybrid
actor, and report the one question that matters at this stage — **does the BC'd policy actually
trade** (a mix of intents, unlike the from-scratch collapse), and how well does it imitate on
held-out tokens?

Two entry points:

* :func:`run_cohort_imitation` — the pure orchestrator over already-loaded :class:`LabeledWallet`\\ s
  (used by tests with fixtures; no network). Requires the ``learn`` extra for the BC step.
* :func:`main` — the CLI: read the export file, select the cohort, pull live from Pinax (gated on
  ``PINAX_API_KEY``), run, and print :func:`format_report`. The export file is operator data — pass
  its path explicitly; it is never committed.

The report leads with the **selection-bias caveat** (paper §9.3): the cohort is operator-chosen and
balance-ranked, and BC clones behaviour, not a proven edge. "How many demos / does it trade / held-out
accuracy" are honest; "these traders are profitable" is a separate measurement this does not make.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass

from oct_trading_agent.data.labeling.schema import LabeledWallet

from .bc import BCConfig, BCResult, train_bc
from .demos import DemoConfig, build_demos, intent_distribution


@dataclass(frozen=True)
class CohortReport:
    """The full first-pass result: how much data, and did BC produce a trading policy?"""

    n_wallets: int
    n_wallets_with_trades: int
    n_trajectories: int
    outcome_counts: dict[str, int]
    n_demos: int
    demo_intent_distribution: dict[str, int]
    bc: BCResult


def run_cohort_imitation(
    wallets: Sequence[LabeledWallet],
    *,
    demo_config: DemoConfig | None = None,
    bc_config: BCConfig | None = None,
    log: Callable[[str], None] = lambda _m: None,
) -> CohortReport:
    """Build demos from ``wallets`` and behavioral-clone the actor; return the cohort report.

    Requires the ``learn`` extra (the BC step trains torch). The demo build itself is torch-free.
    """
    log(f"building demos from {len(wallets)} wallet(s)...")
    dataset = build_demos(wallets, demo_config)
    log(f"  {dataset.n_trajectories} trajectories -> {len(dataset)} demos")
    log("behavioral-cloning the hybrid actor...")
    bc = train_bc(dataset.steps, bc_config)
    return CohortReport(
        n_wallets=len(wallets),
        n_wallets_with_trades=sum(1 for w in wallets if w.trades),
        n_trajectories=dataset.n_trajectories,
        outcome_counts=dataset.outcome_counts,
        n_demos=len(dataset),
        demo_intent_distribution=intent_distribution(dataset.steps),
        bc=bc,
    )


def format_report(report: CohortReport) -> str:
    """Render the cohort imitation report — data volume, class balance, and the BC verdict."""
    width = 96
    lines: list[str] = []
    lines.append("=" * width)
    lines.append("OCT trading-agent — Phase-2 IMITATION (behavioral cloning from tracked traders)")
    lines.append("=" * width)
    lines.append(
        f"wallets (with trades) : {report.n_wallets_with_trades} / {report.n_wallets}"
    )
    lines.append(f"trajectories          : {report.n_trajectories}  {report.outcome_counts}")
    lines.append(f"demonstrations        : {report.n_demos}")
    lines.append(f"  demo intent mix     : {report.demo_intent_distribution}")
    b = report.bc
    lines.append("")
    lines.append(f"BC train / val demos  : {b.n_train} / {b.n_val}  (val = held-out tokens)")
    lines.append(f"BC train / val loss   : {b.train_loss:.4f} / {b.val_loss:.4f}")
    lines.append(f"held-out intent acc.  : {b.val_intent_accuracy * 100:.1f}%")
    lines.append(f"expert val intents    : {b.expert_distribution}")
    lines.append(f"BC val predictions    : {b.bc_distribution}")
    lines.append(f"untrained (ref) preds : {b.untrained_distribution}")
    lines.append(f"mean size (sized)     : {b.mean_size_sized:.3f}")
    lines.append("")
    lines.append("-" * width)
    verdict = "TRADES" if b.trades else "DEGENERATE (no trading intents)"
    lines.append(f"BC POLICY VERDICT     : {verdict}")
    lines.append(
        "  A BC'd policy that emits OPEN_LONG/ADD/TRIM/CLOSE (not only HOLD/NO_OP) is the warm start "
        "the from-scratch PPO lacked — it can now be fine-tuned rather than collapsing."
    )
    lines.append("")
    lines.append("CAVEAT (paper §9.3): the cohort is operator-chosen + balance-ranked, and labels are")
    lines.append("the FULL win-and-loss history. BC clones behaviour, NOT a proven edge — whether these")
    lines.append("traders are profitable is a separate measurement this report does not make.")
    lines.append("=" * width)
    return "\n".join(lines)


def load_cohort_from_pinax(
    tracked: Sequence[object],
    *,
    max_pages: int = 8,
    limit: int = 500,
    cache_dir: object = None,
    log: Callable[[str], None] = lambda _m: None,
) -> list[LabeledWallet]:
    """Pull each tracked wallet's swaps from Pinax into :class:`LabeledWallet`\\ s (bounded, live).

    ``tracked`` is a sequence of :class:`~oct_trading_agent.data.labeling.wallets_file.TrackedWallet`.
    Gated on ``PINAX_API_KEY`` (the client raises otherwise). Kept out of the pure orchestrator so the
    network boundary is explicit and the report logic stays unit-testable.
    """
    from pathlib import Path

    from oct_trading_agent.data.labeling.pinax_loader import load_wallet_trades
    from oct_trading_agent.data.labeling.wallets_file import TrackedWallet
    from oct_trading_agent.data.pinax_client.rest import PinaxRestClient

    client = PinaxRestClient(cache_dir=cache_dir if isinstance(cache_dir, Path) else None)
    out: list[LabeledWallet] = []
    for i, tw in enumerate(tracked):
        if not isinstance(tw, TrackedWallet):
            continue
        log(f"  [{i + 1}/{len(tracked)}] pulling {tw.name} ({tw.address[:8]}...)")
        try:
            wallet = load_wallet_trades(
                client,
                tw.address,
                labels=["tracked", "balance-ranked"],
                limit=limit,
                max_pages=max_pages,
            )
        except Exception as exc:
            log(f"      skipped ({type(exc).__name__}: {exc})")
            continue
        out.append(wallet)
    return out


def main() -> None:  # pragma: no cover - CLI wiring (the pieces it calls are unit-tested)
    import argparse

    from oct_trading_agent.data.labeling.wallets_file import parse_tracked_wallets, select_cohort

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wallets-file", required=True, help="path to the tracked-wallets export (NOT committed)")
    parser.add_argument("--max-wallets", type=int, default=40, help="bounded cohort size (top by SOL balance)")
    parser.add_argument("--max-pages", type=int, default=8, help="Pinax pages per wallet (bounded pull)")
    parser.add_argument("--cache-dir", type=str, default=None, help="optional disk cache for Pinax responses")
    args = parser.parse_args()

    from pathlib import Path

    tracked = parse_tracked_wallets(args.wallets_file)
    cohort = select_cohort(tracked, max_wallets=args.max_wallets)
    print(f"selected {len(cohort)} / {len(tracked)} tracked wallets (top by balance)")
    wallets = load_cohort_from_pinax(
        cohort,
        max_pages=args.max_pages,
        cache_dir=Path(args.cache_dir) if args.cache_dir else None,
        log=print,
    )
    report = run_cohort_imitation(wallets, log=print)
    print(format_report(report))


if __name__ == "__main__":  # pragma: no cover
    main()


__all__ = [
    "CohortReport",
    "run_cohort_imitation",
    "format_report",
    "load_cohort_from_pinax",
]
