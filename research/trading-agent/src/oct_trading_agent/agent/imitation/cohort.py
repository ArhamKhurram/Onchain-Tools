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

from oct_trading_agent.console import safe_console_text
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


@dataclass(frozen=True)
class CohortPullResult:
    """Outcome of a live cohort pull: what survived, and what was skipped after exhausting retries.

    A skipped wallet is one that still failed *after* the REST client's own bounded backoff — it is
    counted and named, never allowed to abort the run. ``wallets`` holds only the ones that returned.
    """

    wallets: list[LabeledWallet]
    n_requested: int
    skipped: list[tuple[str, str]]  # (wallet name/address, one-line reason)

    @property
    def n_pulled(self) -> int:
        return len(self.wallets)

    @property
    def n_skipped(self) -> int:
        return len(self.skipped)

    @property
    def n_with_trades(self) -> int:
        return sum(1 for w in self.wallets if w.trades)


def load_cohort_from_pinax(
    tracked: Sequence[object],
    *,
    max_pages: int = 8,
    limit: int = 500,
    inter_request_delay_s: float = 0.35,
    max_retries: int = 5,
    base_delay_s: float = 1.0,
    cache_dir: object = None,
    client: object = None,
    log: Callable[[str], None] = lambda _m: None,
) -> CohortPullResult:
    """Pull each tracked wallet's swaps from Pinax into :class:`LabeledWallet`\\ s (bounded, live).

    ``tracked`` is a sequence of :class:`~oct_trading_agent.data.labeling.wallets_file.TrackedWallet`.
    Gated on ``PINAX_API_KEY`` (the client raises otherwise). Kept out of the pure orchestrator so the
    network boundary is explicit and the report logic stays unit-testable.

    **Fault isolation:** the shared REST client already retries each request with exponential backoff
    and jitter; a wallet that *still* fails after that is caught here, logged, counted, and skipped —
    it never aborts the cohort. The knobs (``inter_request_delay_s``, ``max_retries``, ``base_delay_s``)
    are forwarded to the client so a large pull can be paced politely from the CLI. A ``client`` may be
    injected (tests); otherwise one is built with the pacing/backoff knobs applied.
    """
    from pathlib import Path

    from oct_trading_agent.data.labeling.pinax_loader import load_wallet_trades
    from oct_trading_agent.data.labeling.wallets_file import TrackedWallet
    from oct_trading_agent.data.pinax_client.rest import PinaxRestClient

    if client is None:
        client = PinaxRestClient(
            cache_dir=cache_dir if isinstance(cache_dir, Path) else None,
            inter_request_delay_s=inter_request_delay_s,
            max_retries=max_retries,
            base_delay_s=base_delay_s,
        )

    def _log(message: str) -> None:
        # Wallet names and exception text are operator/user-supplied and may carry emoji a cp1252
        # console cannot encode — sanitise EVERY interpolated line so logging can never raise.
        log(safe_console_text(message))

    candidates = [tw for tw in tracked if isinstance(tw, TrackedWallet)]
    out: list[LabeledWallet] = []
    skipped: list[tuple[str, str]] = []
    for i, tw in enumerate(candidates):
        _log(f"  [{i + 1}/{len(candidates)}] pulling {tw.name} ({tw.address[:8]}...)")
        try:
            wallet = load_wallet_trades(
                client,  # type: ignore[arg-type]
                tw.address,
                labels=["tracked", "balance-ranked"],
                limit=limit,
                max_pages=max_pages,
            )
        except Exception as exc:  # backoff already exhausted — isolate, count, and keep going
            reason = f"{type(exc).__name__}: {exc}"
            _log(f"      SKIPPED after retries ({reason})")
            skipped.append((f"{tw.name} ({tw.address[:8]}...)", reason))
            continue
        out.append(wallet)
    return CohortPullResult(wallets=out, n_requested=len(candidates), skipped=skipped)


def format_pull_summary(result: CohortPullResult) -> str:
    """One-block summary of a live pull: pulled / with-trades / skipped, and the skip reasons."""
    lines = [
        f"cohort pull: {result.n_pulled}/{result.n_requested} wallets pulled "
        f"({result.n_with_trades} with trades), {result.n_skipped} skipped after retries",
    ]
    for name, reason in result.skipped:
        lines.append(f"  - skipped {name}: {reason}")
    return "\n".join(lines)


def cohort_is_usable(result: CohortPullResult, *, min_with_trades: int = 1) -> bool:
    """Did the pull yield enough to be worth training on? True unless it got essentially nothing.

    The exit-code contract: a run that pulled a usable cohort (at least ``min_with_trades`` wallets
    carrying trades) exits 0 even if many wallets were skipped; a run that got essentially nothing
    fails hard, because there is nothing to behavioural-clone.
    """
    return result.n_with_trades >= min_with_trades


def main() -> int:  # pragma: no cover - CLI wiring (the pieces it calls are unit-tested)
    import argparse

    from oct_trading_agent.data.labeling.wallets_file import parse_tracked_wallets, select_cohort

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wallets-file", required=True, help="path to the tracked-wallets export (NOT committed)")
    parser.add_argument("--max-wallets", type=int, default=40, help="bounded cohort size (top by SOL balance)")
    parser.add_argument("--max-pages", type=int, default=8, help="Pinax pages per wallet (bounded pull)")
    parser.add_argument("--cache-dir", type=str, default=None, help="optional disk cache for Pinax responses")
    parser.add_argument(
        "--inter-request-delay", type=float, default=0.35,
        help="deliberate pacing (s) before each Pinax request — raise it for large cohorts",
    )
    parser.add_argument(
        "--max-retries", type=int, default=5,
        help="retries per request on 429/5xx/transient errors (exponential backoff + jitter)",
    )
    parser.add_argument(
        "--base-delay", type=float, default=1.0,
        help="backoff base delay (s): sleep ~= base * 2**attempt, capped ~30s, plus jitter",
    )
    args = parser.parse_args()

    from pathlib import Path

    tracked = parse_tracked_wallets(args.wallets_file)
    cohort = select_cohort(tracked, max_wallets=args.max_wallets)
    print(f"selected {len(cohort)} / {len(tracked)} tracked wallets (top by balance)")
    result = load_cohort_from_pinax(
        cohort,
        max_pages=args.max_pages,
        inter_request_delay_s=args.inter_request_delay,
        max_retries=args.max_retries,
        base_delay_s=args.base_delay,
        cache_dir=Path(args.cache_dir) if args.cache_dir else None,
        log=print,
    )
    print(safe_console_text(format_pull_summary(result)))  # skip lines may carry emoji names
    if not cohort_is_usable(result):
        print("ABORT: cohort pull returned essentially nothing (no wallets with trades); not training.")
        return 1
    report = run_cohort_imitation(result.wallets, log=print)
    print(format_report(report))
    return 0


if __name__ == "__main__":  # pragma: no cover
    import sys

    sys.exit(main())


__all__ = [
    "CohortReport",
    "CohortPullResult",
    "run_cohort_imitation",
    "format_report",
    "load_cohort_from_pinax",
    "format_pull_summary",
    "cohort_is_usable",
]
