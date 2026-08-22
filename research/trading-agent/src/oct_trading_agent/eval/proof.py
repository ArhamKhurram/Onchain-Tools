"""End-to-end proof: run the random policy + baselines through the env on REAL bonding-curve tape.

This is the Phase-1 substrate's "the loop runs" proof (03 §Phase 0 exit milestone: a trivial baseline
runs end-to-end through sim → paper ledger with correct costs). It is **not** a learned result and
makes **no** edge claim — it demonstrates that the environment, the reward, the episode boundaries,
the baselines, the metric battery, and the leakage guard all compose and execute on real pump.fun
bonding-curve data.

Flow:

1. Load one real bonding-curve token's tape (offline fixture by default; a bounded live Pinax pull
   with ``--live``).
2. Seed the pump.fun virtual reserves and build a point-in-time feature store over the tape.
3. Certify the raw-chart tier is causal on this tape (the leakage guard).
4. Split the token's life into time-ordered walk-forward windows (never random) — each a per-token
   episode — and run hold-SOL, buy-and-hold, and the random policy through the SAME envs.
5. Report the risk-adjusted metric battery per policy and the per-token edge vs the baselines.

Run: ``uv run python -m oct_trading_agent.eval.proof`` (add ``--live`` for the bounded live pull).
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from oct_trading_agent.agent.envs import (
    EnvConfig,
    TradingEnv,
    bonding_curve_sim_config,
    prepare_bonding_curve_tape,
)
from oct_trading_agent.agent.policies import EnvPolicy
from oct_trading_agent.core import SwapEvent
from oct_trading_agent.eval.ablations import assert_raw_chart_causal
from oct_trading_agent.eval.baselines import BuyAndHoldPolicy, HoldSolPolicy, RandomPolicy
from oct_trading_agent.eval.data import TokenTape, load_bonding_curve_fixture
from oct_trading_agent.eval.runner import PolicyEvaluation, evaluate_policy, per_token_edge
from oct_trading_agent.featurestore import PointInTimeFeatureStore


@dataclass(frozen=True)
class ProofResult:
    """The proof's outputs: source, sizes, the causality certificate, and per-policy evaluations."""

    source: str
    mint: str
    n_swaps: int
    n_windows: int
    causal_certified: bool
    evaluations: dict[str, PolicyEvaluation]
    edges: dict[str, dict[str, float]]  # policy -> {baseline_name -> mean per-token edge}


def _walk_forward_windows(times: list[datetime], n_windows: int) -> list[list[datetime]]:
    """Split sorted decision instants into ``n_windows`` contiguous, time-ordered windows.

    Contiguous and non-overlapping — never a random split (paper §8.5). Each window is one per-token
    episode; empty windows are dropped so every episode has at least one decision instant.
    """
    unique = sorted(set(times))
    if not unique:
        return []
    n = min(n_windows, len(unique))
    edges = [round(i * len(unique) / n) for i in range(n + 1)]
    windows = [unique[edges[i] : edges[i + 1]] for i in range(n)]
    return [w for w in windows if w]


def build_envs(
    tape: TokenTape,
    *,
    n_windows: int = 8,
    initial_balance_quote: Decimal = Decimal(1),
    risk_budget_quote: Decimal = Decimal("0.05"),
    seed: int = 0,
) -> list[TradingEnv]:
    """Build one :class:`TradingEnv` per time-ordered window over the token's bonding-curve tape.

    Every env shares the seeded, reserve-anchored tape and one point-in-time feature store (read-only);
    each acts only on its window's decision instants, giving a per-episode return distribution for the
    metric battery. The full tape is always available for causal reserve reconstruction.
    """
    sim_tape = prepare_bonding_curve_tape(list(tape.swaps))
    sim_config = bonding_curve_sim_config(risk_budget_quote=risk_budget_quote, seed=seed)
    store = PointInTimeFeatureStore(sim_tape)
    swap_times = [e.block_time for e in tape.swaps if isinstance(e, SwapEvent)]
    windows = _walk_forward_windows(swap_times, n_windows)
    config = EnvConfig(initial_balance_quote=initial_balance_quote)
    return [
        TradingEnv(
            sim_tape,
            tape.mint,
            sim_config,
            decision_times=window,
            feature_store=store,
            config=config,
        )
        for window in windows
    ]


def run_proof(
    *,
    live: bool = False,
    n_windows: int = 8,
    random_seed: int = 7,
    amm_pool: str | None = None,
) -> ProofResult:
    """Run the full end-to-end proof and return the collected :class:`ProofResult`.

    ``live`` attempts a bounded Pinax pull and falls back to the fixture on any failure (so the proof
    always produces output). The baselines and the random policy run through identical envs.
    """
    tape = _load_tape(live=live, amm_pool=amm_pool)

    # Certify the raw-chart tier is causal on this tape before trusting any features (leakage guard).
    # Pick an as_of with at least one strictly-later event — the second-largest DISTINCT swap time
    # (REST timestamps are second-granular, so a naive midpoint can land past the last event).
    sim_tape = prepare_bonding_curve_tape(list(tape.swaps))
    causal = True
    distinct_times = sorted({e.block_time for e in tape.swaps if isinstance(e, SwapEvent)})
    if len(distinct_times) >= 2:
        try:
            assert_raw_chart_causal(sim_tape, distinct_times[-2])
        except AssertionError:
            causal = False
        except ValueError:
            causal = True  # too few distinct instants to audit meaningfully; not a leak

    def fresh_envs() -> list[TradingEnv]:
        return build_envs(tape, n_windows=n_windows)

    policies: dict[str, EnvPolicy] = {
        "hold_sol": HoldSolPolicy(),
        "buy_and_hold": BuyAndHoldPolicy(size=1.0),
        "random": RandomPolicy(seed=random_seed),
    }
    evaluations: dict[str, PolicyEvaluation] = {
        name: evaluate_policy(fresh_envs(), policy, name) for name, policy in policies.items()
    }

    edges: dict[str, dict[str, float]] = {}
    for name in ("random",):
        edges[name] = {
            baseline: per_token_edge(evaluations[name], evaluations[baseline]).mean_edge
            for baseline in ("hold_sol", "buy_and_hold")
        }

    return ProofResult(
        source=tape.source,
        mint=tape.mint,
        n_swaps=tape.n_swaps,
        n_windows=len(fresh_envs()),
        causal_certified=causal,
        evaluations=evaluations,
        edges=edges,
    )


def _load_tape(*, live: bool, amm_pool: str | None) -> TokenTape:
    if not live:
        return load_bonding_curve_fixture()
    try:
        from oct_trading_agent.eval.data import load_live_bonding_curve_tape

        kwargs = {"amm_pool": amm_pool} if amm_pool else {}
        tape = load_live_bonding_curve_tape(**kwargs)  # type: ignore[arg-type]
        if tape.n_swaps == 0:
            raise RuntimeError("live pull returned no decodable swaps")
        return tape
    except Exception as exc:
        fixture = load_bonding_curve_fixture()
        return TokenTape(
            mint=fixture.mint,
            swaps=fixture.swaps,
            source=f"{fixture.source} (live fell back: {type(exc).__name__}: {exc})",
        )


def format_proof(result: ProofResult) -> str:
    """Render the proof result as a human-readable report (the text the runner prints)."""
    width = 96
    lines: list[str] = []
    lines.append("=" * width)
    lines.append("OCT trading-agent - Phase-1 substrate end-to-end proof (NOT a learned result)")
    lines.append("=" * width)
    lines.append(f"source           : {result.source}")
    lines.append(f"token (mint/pool): {result.mint}")
    lines.append(f"swaps            : {result.n_swaps}")
    lines.append(f"episodes/windows : {result.n_windows} (time-ordered walk-forward; never random)")
    lines.append(f"raw-chart causal : {'CERTIFIED' if result.causal_certified else 'FAILED'}")
    lines.append("")
    header = (
        f"{'policy':<14}{'n':>3}{'mean_ret':>11}{'total_ret':>11}{'sharpe':>12}"
        f"{'sortino':>10}{'cvar5%':>11}{'maxDD':>8}{'hit%':>7}{'trades':>8}{'fees_SOL':>12}"
    )
    lines.append(header)
    lines.append("-" * len(header))
    for name in ("hold_sol", "buy_and_hold", "random"):
        m = result.evaluations[name].metrics
        lines.append(
            f"{name:<14}{m.n_returns:>3}{m.mean_return:>11.4f}{m.total_return:>11.4f}"
            f"{m.sharpe:>12.2f}{m.sortino:>10.3f}{m.cvar:>11.4f}{m.max_drawdown:>8.3f}"
            f"{m.hit_rate * 100:>6.1f}%{int(m.turnover):>8}{m.total_fees_quote:>12.6f}"
        )
    lines.append("")
    lines.append("per-token edge (random minus baseline), mean over windows:")
    for baseline, edge in result.edges.get("random", {}).items():
        lines.append(f"  random - {baseline:<14}: {edge:+.4f}")
    lines.append("")
    lines.append(
        "NOTE: baselines only. The numbers are a substrate-works proof on real bonding-curve tape, "
        "not an edge claim (paper 8.1). A learned policy is the next phase."
    )
    lines.append("=" * width)
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--live", action="store_true", help="attempt a bounded live Pinax pull (falls back to fixture)"
    )
    parser.add_argument("--windows", type=int, default=8, help="number of walk-forward episodes")
    parser.add_argument("--seed", type=int, default=7, help="random-policy seed")
    parser.add_argument("--amm-pool", type=str, default=None, help="pool address for the live pull")
    args = parser.parse_args()
    result = run_proof(
        live=args.live, n_windows=args.windows, random_seed=args.seed, amm_pool=args.amm_pool
    )
    print(format_proof(result))


if __name__ == "__main__":
    main()


__all__ = ["ProofResult", "build_envs", "format_proof", "run_proof"]
