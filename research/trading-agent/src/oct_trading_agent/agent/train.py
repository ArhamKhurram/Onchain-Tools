"""Phase-1 learner — train the raw-chart PPO agent and report the honest go/no-go gate.

This is the Phase-1 experiment (03-experiment-plan.md §Phase 1): from **nothing but the chart**
(the tier-A masked observation), can a learned policy beat hold-SOL AND buy-and-hold **after
realistic costs** on held-out time — and does the edge, if any, collapse when the tier is replaced by
noise (the leakage guard)? A "no" or "inconclusive" here is a **valid, pre-registered outcome**
(§Phase 1 NO-GO; charter §2), and this script reports it as such — it does not chase a positive
number.

What it does, end-to-end:

1. **Load real bonding-curve tape** — the offline fixture by default (deterministic, network-free) or
   a bounded live Pinax pull (``--live``: the fixture pool, or ``--live-tokens N`` distinct pump.fun
   pools discovered from one network-wide page; ``limit ≤ 500``, ``User-Agent`` + key from
   ``backend/.env`` — exactly as ``eval/proof.py`` does).
2. **Walk-forward split** — never random (the harness enforces time-ordering). Held-out **time**:
   the token's life is cut into contiguous folds; the earliest train, the strictly-later evaluate.
   Held-out **tokens** (with ≥2 tokens): the newest tokens are the test set.
3. **Certify causality** — the tier-A leakage audit on every training tape before trusting a feature.
4. **Train** the hybrid actor + distributional critic with PPO on the training windows (bounded
   compute: small net, few seeds, capped iterations).
5. **Evaluate** the deterministic policy and the three baselines through the SAME env with the SAME
   costs; report the full metric battery **after costs** + per-token edge vs both baselines.
6. **Leakage-guard ablation** — retrain+evaluate on tier-A-replaced-by-noise; the edge must collapse
   to the no-information (hold-SOL) baseline. If it does not, the "edge" was leakage — a finding.
7. **Gate verdict** — GO / NO-GO / INCONCLUSIVE, pre-registered, printed honestly.

Run: ``uv run --extra learn python -m oct_trading_agent.agent.train`` (add ``--live`` /
``--live-tokens N`` for real data). The pure ``phase1_gate`` verdict logic is unit-tested without
torch; the training itself needs the ``learn`` extra.
"""

from __future__ import annotations

import argparse
import random
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

import numpy as np

from oct_trading_agent.agent.envs import (
    EnvConfig,
    TradingEnv,
    bonding_curve_sim_config,
    prepare_bonding_curve_tape,
)
from oct_trading_agent.agent.policies import EnvPolicy
from oct_trading_agent.core import FeatureStore, Mint, SwapEvent, TapeEvent
from oct_trading_agent.eval.ablations import NoiseTierFeatureStore, assert_raw_chart_causal
from oct_trading_agent.eval.baselines import BuyAndHoldPolicy, HoldSolPolicy, RandomPolicy
from oct_trading_agent.eval.data import TokenTape, load_bonding_curve_fixture
from oct_trading_agent.eval.metrics import MetricReport
from oct_trading_agent.eval.runner import PolicyEvaluation, evaluate_policy, per_token_edge
from oct_trading_agent.eval.walkforward import (
    TokenSpan,
    assert_time_ordered,
    token_time_holdout,
)
from oct_trading_agent.featurestore import PointInTimeFeatureStore

# ---------------------------------------------------------------------------
# Walk-forward episode construction (time-ordered; never random)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PreparedToken:
    """A token's sim-ready tape, its point-in-time store, and its time-ordered decision windows."""

    mint: Mint
    sim_tape: list[TapeEvent]
    store: FeatureStore
    windows: list[list[datetime]]


def _contiguous_windows(times: list[datetime], n_windows: int) -> list[list[datetime]]:
    """Split sorted unique instants into ``n_windows`` contiguous, non-overlapping windows (no random).

    Mirrors ``eval/proof.py``'s splitter: each window is one per-token episode; empties are dropped.
    """
    unique = sorted(set(times))
    if not unique:
        return []
    n = min(n_windows, len(unique))
    edges = [round(i * len(unique) / n) for i in range(n + 1)]
    windows = [unique[edges[i] : edges[i + 1]] for i in range(n)]
    return [w for w in windows if w]


def prepare_token(tape: TokenTape, *, n_windows: int) -> PreparedToken:
    """Seed the bonding curve, build the point-in-time store, and cut time-ordered windows."""
    sim_tape = prepare_bonding_curve_tape(list(tape.swaps))
    store = PointInTimeFeatureStore(sim_tape)
    swap_times = [e.block_time for e in tape.swaps if isinstance(e, SwapEvent)]
    windows = _contiguous_windows(swap_times, n_windows)
    return PreparedToken(mint=tape.mint, sim_tape=sim_tape, store=store, windows=windows)


def _make_env(
    prepared: PreparedToken,
    window: list[datetime],
    *,
    store: FeatureStore,
    initial_balance: Decimal,
    risk_budget: Decimal,
    seed: int,
) -> TradingEnv:
    return TradingEnv(
        prepared.sim_tape,
        prepared.mint,
        bonding_curve_sim_config(risk_budget_quote=risk_budget, seed=seed),
        decision_times=window,
        feature_store=store,
        config=EnvConfig(initial_balance_quote=initial_balance),
    )


@dataclass
class WalkForward:
    """A time-ordered train/eval split of envs over one or more tokens, plus a noised-eval builder."""

    axis: str  # "held-out-time" or "held-out-tokens"
    train_envs: list[TradingEnv]
    eval_envs: list[TradingEnv]
    # Builders that reconstruct env sets with tier-A replaced by noise (leakage guard).
    noised_train_builder: Callable[[int], list[TradingEnv]]
    noised_eval_builder: Callable[[], list[TradingEnv]]
    train_times: list[datetime] = field(default_factory=list)
    eval_times: list[datetime] = field(default_factory=list)


def build_walk_forward_time(
    tape: TokenTape,
    *,
    n_windows: int = 8,
    train_fraction: float = 0.6,
    initial_balance: Decimal = Decimal(1),
    risk_budget: Decimal = Decimal("0.05"),
    noise_seed: int = 0,
) -> WalkForward:
    """Held-out **time**: earliest windows train, strictly-later windows evaluate (one token).

    Time-ordering is asserted (``assert_time_ordered``) so a leak-by-shuffle can never slip in.
    """
    prepared = prepare_token(tape, n_windows=n_windows)
    windows = prepared.windows
    if len(windows) < 2:
        raise ValueError("need >=2 time windows for a held-out-time split; token has too few swaps")
    n_train = max(1, min(len(windows) - 1, round(train_fraction * len(windows))))
    train_windows = windows[:n_train]
    eval_windows = windows[n_train:]

    train_times = [t for w in train_windows for t in w]
    eval_times = [t for w in eval_windows for t in w]
    assert_time_ordered(train_times, eval_times)  # eval strictly after train — never random

    def real_train() -> list[TradingEnv]:
        return [
            _make_env(prepared, w, store=prepared.store, initial_balance=initial_balance,
                      risk_budget=risk_budget, seed=0)
            for w in train_windows
        ]

    def real_eval() -> list[TradingEnv]:
        return [
            _make_env(prepared, w, store=prepared.store, initial_balance=initial_balance,
                      risk_budget=risk_budget, seed=0)
            for w in eval_windows
        ]

    def noised_train(seed: int) -> list[TradingEnv]:
        store = NoiseTierFeatureStore(PointInTimeFeatureStore(prepared.sim_tape), seed=seed)
        return [
            _make_env(prepared, w, store=store, initial_balance=initial_balance,
                      risk_budget=risk_budget, seed=0)
            for w in train_windows
        ]

    def noised_eval() -> list[TradingEnv]:
        store = NoiseTierFeatureStore(
            PointInTimeFeatureStore(prepared.sim_tape), seed=noise_seed
        )
        return [
            _make_env(prepared, w, store=store, initial_balance=initial_balance,
                      risk_budget=risk_budget, seed=0)
            for w in eval_windows
        ]

    return WalkForward(
        axis="held-out-time",
        train_envs=real_train(),
        eval_envs=real_eval(),
        noised_train_builder=noised_train,
        noised_eval_builder=noised_eval,
        train_times=train_times,
        eval_times=eval_times,
    )


def build_walk_forward_tokens(
    tapes: list[TokenTape],
    *,
    n_windows: int = 4,
    test_fraction: float = 0.4,
    initial_balance: Decimal = Decimal(1),
    risk_budget: Decimal = Decimal("0.05"),
    noise_seed: int = 0,
) -> WalkForward:
    """Held-out **tokens**: the newest tokens (by first-swap time) are the test set; earlier train.

    A token never appears in both sets and the test tokens all launched no earlier than every train
    token (``token_time_holdout``) — a forward test on tokens training never saw.
    """
    prepared = {t.mint: prepare_token(t, n_windows=n_windows) for t in tapes}
    spans = [
        TokenSpan(mint=t.mint, start_time=min(e.block_time for e in t.swaps))
        for t in tapes
        if t.swaps
    ]
    holdout = token_time_holdout(spans, test_fraction)

    def envs_for(mints: list[Mint], store_factory: Callable[[PreparedToken], FeatureStore]) -> list[TradingEnv]:
        out: list[TradingEnv] = []
        for mint in mints:
            p = prepared[mint]
            store = store_factory(p)
            out.extend(
                _make_env(p, w, store=store, initial_balance=initial_balance,
                          risk_budget=risk_budget, seed=0)
                for w in p.windows
            )
        return out

    def real_store(p: PreparedToken) -> FeatureStore:
        return p.store

    def noise_store_factory(seed: int) -> Callable[[PreparedToken], FeatureStore]:
        def factory(p: PreparedToken) -> FeatureStore:
            return NoiseTierFeatureStore(PointInTimeFeatureStore(p.sim_tape), seed=seed)
        return factory

    return WalkForward(
        axis="held-out-tokens",
        train_envs=envs_for(holdout.train, real_store),
        eval_envs=envs_for(holdout.test, real_store),
        noised_train_builder=lambda seed: envs_for(holdout.train, noise_store_factory(seed)),
        noised_eval_builder=lambda: envs_for(holdout.test, noise_store_factory(noise_seed)),
    )


# ---------------------------------------------------------------------------
# Training (torch-gated: imported lazily inside)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TrainConfig:
    """Bounded-compute training budget (a first honest signal, not a hyperparameter search)."""

    n_iterations: int = 40
    episodes_per_iter: int = 4  # times the env set is replayed per PPO iteration
    hidden_dim: int = 64
    n_quantiles: int = 8
    cvar_alpha: float = 0.05
    risk_beta: float = 0.0
    learning_rate: float = 3e-4
    entropy_coef: float = 0.01
    gamma: float = 0.99
    gae_lambda: float = 0.95


def train_policy(
    train_envs: list[TradingEnv],
    config: TrainConfig,
    *,
    seed: int,
    log: Callable[[str], None] = lambda _m: None,
) -> EnvPolicy:
    """Train the hybrid actor + distributional critic with PPO on ``train_envs``; return an EnvPolicy.

    Requires the ``learn`` extra. Deterministic given ``seed`` (torch + numpy + random are all seeded).
    The returned policy is the DETERMINISTIC actor (argmax intent, Beta-mode size) plus the frozen
    observation normalizer — the exact object the eval battery scores against the baselines.
    """
    import torch

    from oct_trading_agent.agent.online import (
        PPOConfig,
        PPOTrainer,
        RolloutBuffer,
        collect_rollouts,
    )
    from oct_trading_agent.agent.online.normalize import RunningNormalizer
    from oct_trading_agent.agent.policies import TorchPolicy
    from oct_trading_agent.agent.policies.torch_actor import ActorConfig, build_actor_critic

    torch.manual_seed(seed)
    np.random.seed(seed)
    random.seed(seed)

    actor_cfg = ActorConfig(
        hidden_dim=config.hidden_dim, n_quantiles=config.n_quantiles, cvar_alpha=config.cvar_alpha
    )
    model = build_actor_critic(actor_cfg)
    ppo_cfg = PPOConfig(
        learning_rate=config.learning_rate,
        entropy_coef=config.entropy_coef,
        gamma=config.gamma,
        gae_lambda=config.gae_lambda,
        risk_beta=config.risk_beta,
        cvar_alpha=config.cvar_alpha,
    )
    trainer = PPOTrainer(model, ppo_cfg)
    normalizer = RunningNormalizer()

    for it in range(config.n_iterations):
        buffer = RolloutBuffer(gamma=config.gamma, lam=config.gae_lambda)
        for _ in range(config.episodes_per_iter):
            collect_rollouts(
                model, train_envs, normalizer, buffer,
                update_normalizer=True, risk_beta=config.risk_beta, cvar_alpha=config.cvar_alpha,
            )
        batch = buffer.compute()
        stats = trainer.update(batch)
        if (it + 1) % max(1, config.n_iterations // 8) == 0:
            log(
                f"  iter {it + 1:>3}/{config.n_iterations}  "
                f"steps={len(batch):>5}  pol={stats.policy_loss:+.4f}  "
                f"val={stats.value_loss:.4f}  ent={stats.entropy:+.3f}  kl={stats.approx_kl:+.4f}"
            )

    return TorchPolicy(model, normalizer=normalizer, deterministic=True)


# ---------------------------------------------------------------------------
# The Phase-1 gate verdict (pure — unit-tested without torch)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BaselineComparison:
    """The learned policy vs one baseline, after costs: does it beat it out-of-sample?"""

    baseline: str
    agent_mean_return: float
    baseline_mean_return: float
    agent_sharpe: float
    baseline_sharpe: float
    fraction_tokens_beaten: float
    mean_edge: float
    beats: bool


@dataclass(frozen=True)
class GateVerdict:
    """The pre-registered Phase-1 go/no-go outcome (03 §Phase 1). All three values are legitimate."""

    verdict: str  # "GO" | "NO-GO" | "INCONCLUSIVE"
    beats_hold_sol: bool
    beats_buy_and_hold: bool
    leakage_guard_passed: bool
    comparisons: list[BaselineComparison]
    rationale: str


def _beats(agent: MetricReport, baseline: MetricReport, fraction_beaten: float) -> bool:
    """Beat = higher mean return AND higher Sharpe AND a majority of tokens beaten, all after costs.

    The triple test is deliberately strict: a single lucky window cannot manufacture a "beat", and a
    higher mean with a worse risk profile (the lottery tell) does not pass (paper §8.3).
    """
    return (
        agent.mean_return > baseline.mean_return
        and agent.sharpe > baseline.sharpe
        and fraction_beaten > 0.5
    )


def phase1_gate(
    agent: PolicyEvaluation,
    hold_sol: PolicyEvaluation,
    buy_and_hold: PolicyEvaluation,
    *,
    edge_vs_hold_sol: tuple[float, float],  # (fraction_beaten, mean_edge)
    edge_vs_buy_and_hold: tuple[float, float],
    noised_agent_shows_edge: bool | None,
) -> GateVerdict:
    """Compute the pre-registered gate. GO only if the agent beats BOTH baselines after costs
    out-of-sample AND the leakage guard passes (a noised-tier agent shows NO edge over the
    no-information hold-SOL floor — the tier's signal was necessary, not leaked).

    ``noised_agent_shows_edge`` is ``None`` when the guard was not run (then the guard is reported as
    not-exercised and cannot turn a real edge into a GO on its own).
    """
    hs_beat = _beats(agent.metrics, hold_sol.metrics, edge_vs_hold_sol[0])
    bh_beat = _beats(agent.metrics, buy_and_hold.metrics, edge_vs_buy_and_hold[0])
    comparisons = [
        BaselineComparison(
            baseline="hold_sol",
            agent_mean_return=agent.metrics.mean_return,
            baseline_mean_return=hold_sol.metrics.mean_return,
            agent_sharpe=agent.metrics.sharpe,
            baseline_sharpe=hold_sol.metrics.sharpe,
            fraction_tokens_beaten=edge_vs_hold_sol[0],
            mean_edge=edge_vs_hold_sol[1],
            beats=hs_beat,
        ),
        BaselineComparison(
            baseline="buy_and_hold",
            agent_mean_return=agent.metrics.mean_return,
            baseline_mean_return=buy_and_hold.metrics.mean_return,
            agent_sharpe=agent.metrics.sharpe,
            baseline_sharpe=buy_and_hold.metrics.sharpe,
            fraction_tokens_beaten=edge_vs_buy_and_hold[0],
            mean_edge=edge_vs_buy_and_hold[1],
            beats=bh_beat,
        ),
    ]

    beats_both = hs_beat and bh_beat
    # Guard passes when it was run AND the noised agent shows NO edge over the no-information floor
    # (its apparent edge needed the real tier — it was not leakage).
    leakage_guard_passed = noised_agent_shows_edge is False

    if beats_both and leakage_guard_passed:
        verdict = "GO"
        rationale = (
            "The raw-chart agent beat hold-SOL and buy-and-hold after realistic costs out-of-sample, "
            "and the edge collapsed when the tier was replaced by noise (not leakage)."
        )
    elif not beats_both:
        verdict = "NO-GO"
        rationale = (
            "No edge survived costs out-of-sample against both baselines — a legitimate, "
            "pre-registered Phase-1 outcome (03 §Phase 1 NO-GO; charter §2). Not a failure to report."
        )
    else:  # beats both but guard did not pass (or was not run)
        verdict = "INCONCLUSIVE"
        rationale = (
            "The agent beat both baselines, but the leakage guard did not confirm the edge needed the "
            "tier (noised-tier performance did not collapse, or the guard was not run) — treat the "
            "apparent edge as unproven until the noise ablation collapses it."
        )
    return GateVerdict(
        verdict=verdict,
        beats_hold_sol=hs_beat,
        beats_buy_and_hold=bh_beat,
        leakage_guard_passed=leakage_guard_passed,
        comparisons=comparisons,
        rationale=rationale,
    )


# ---------------------------------------------------------------------------
# The full experiment
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Phase1Result:
    """Everything the run produced: the split, the per-policy evaluations, the guard, the verdict."""

    axis: str
    n_train_envs: int
    n_eval_envs: int
    causal_certified: bool
    evaluations: dict[str, PolicyEvaluation]
    edges: dict[str, tuple[float, float]]  # baseline -> (fraction_beaten, mean_edge)
    noised_agent_shows_edge: bool | None
    verdict: GateVerdict


def _evaluate_all(
    agent: EnvPolicy,
    wf: WalkForward,
    *,
    random_seed: int,
) -> tuple[dict[str, PolicyEvaluation], dict[str, tuple[float, float]]]:
    """Score the agent + the three baselines on the eval envs; compute per-token edge vs baselines.

    Fresh eval-env sets per policy (each policy resets its envs), so the comparison is apples-to-apples.
    """
    agent_eval = evaluate_policy(wf.eval_envs, agent, "learned_agent")
    hold_eval = evaluate_policy(wf.eval_envs, HoldSolPolicy(), "hold_sol")
    buy_eval = evaluate_policy(wf.eval_envs, BuyAndHoldPolicy(size=1.0), "buy_and_hold")
    rand_eval = evaluate_policy(wf.eval_envs, RandomPolicy(seed=random_seed), "random")
    evals = {
        "learned_agent": agent_eval,
        "hold_sol": hold_eval,
        "buy_and_hold": buy_eval,
        "random": rand_eval,
    }
    edge_hs = per_token_edge(agent_eval, hold_eval)
    edge_bh = per_token_edge(agent_eval, buy_eval)
    edges = {
        "hold_sol": (edge_hs.fraction_beaten, edge_hs.mean_edge),
        "buy_and_hold": (edge_bh.fraction_beaten, edge_bh.mean_edge),
    }
    return evals, edges


def run_phase1(
    tapes: list[TokenTape],
    *,
    axis: str = "held-out-time",
    train_config: TrainConfig | None = None,
    seed: int = 0,
    n_windows: int | None = None,
    run_leakage_guard: bool = True,
    log: Callable[[str], None] = print,
) -> Phase1Result:
    """Run the full Phase-1 experiment on ``tapes`` and return the honest gate result.

    ``axis='held-out-time'`` uses the first tape and splits its life in time; ``axis='held-out-tokens'``
    needs ≥2 tapes and holds out the newest. Requires the ``learn`` extra (it trains).
    """
    cfg = train_config or TrainConfig()
    if axis == "held-out-tokens":
        if len(tapes) < 2:
            raise ValueError("held-out-tokens needs >=2 tokens; pass more tapes or use held-out-time")
        wf = build_walk_forward_tokens(tapes, n_windows=n_windows or 4)
    else:
        wf = build_walk_forward_time(tapes[0], n_windows=n_windows or 8)

    # Certify the tier-A feature set is causal on the training tape before trusting any feature.
    causal = _certify_causal(wf.train_envs)

    log(f"[{wf.axis}] train_envs={len(wf.train_envs)}  eval_envs={len(wf.eval_envs)}  "
        f"raw-chart causal={'CERTIFIED' if causal else 'FAILED'}")
    log("training the learned policy (real tier-A features)...")
    agent = train_policy(wf.train_envs, cfg, seed=seed, log=log)
    evals, edges = _evaluate_all(agent, wf, random_seed=seed + 100)

    noised_shows_edge: bool | None = None
    if run_leakage_guard:
        log("leakage guard: retraining + evaluating with tier-A replaced by noise...")
        noised_train = wf.noised_train_builder(seed)
        noised_agent = train_policy(noised_train, cfg, seed=seed, log=lambda _m: None)
        noised_eval_envs = wf.noised_eval_builder()
        noised_agent_eval = evaluate_policy(noised_eval_envs, noised_agent, "noised_agent")
        # The collapse test is against the NO-INFORMATION floor (hold-SOL), not buy-and-hold: a
        # down-drifting token lets "do nothing" beat buy-and-hold, which is token drift, not signal.
        n_edge_hs = per_token_edge(noised_agent_eval, evals["hold_sol"])
        noised_shows_edge = _beats(
            noised_agent_eval.metrics, evals["hold_sol"].metrics, n_edge_hs.fraction_beaten
        )
        evals["noised_agent"] = noised_agent_eval

    verdict = phase1_gate(
        evals["learned_agent"],
        evals["hold_sol"],
        evals["buy_and_hold"],
        edge_vs_hold_sol=edges["hold_sol"],
        edge_vs_buy_and_hold=edges["buy_and_hold"],
        noised_agent_shows_edge=noised_shows_edge,
    )
    return Phase1Result(
        axis=wf.axis,
        n_train_envs=len(wf.train_envs),
        n_eval_envs=len(wf.eval_envs),
        causal_certified=causal,
        evaluations=evals,
        edges=edges,
        noised_agent_shows_edge=noised_shows_edge,
        verdict=verdict,
    )


def _certify_causal(envs: list[TradingEnv]) -> bool:
    """Run the tier-A causal audit on each env's tape (via a strictly-earlier as_of). Best-effort."""
    ok = True
    for env in envs:
        tape = list(env._tape)
        distinct = sorted({e.block_time for e in tape if isinstance(e, SwapEvent)})
        if len(distinct) < 2:
            continue
        try:
            assert_raw_chart_causal(tape, distinct[-2])
        except AssertionError:
            ok = False
        except ValueError:
            continue
    return ok


# ---------------------------------------------------------------------------
# Reporting + live data + CLI
# ---------------------------------------------------------------------------


def format_result(result: Phase1Result) -> str:
    """Render the Phase-1 result: per-policy battery after costs, edges, guard, and the gate verdict."""
    width = 100
    lines: list[str] = []
    lines.append("=" * width)
    lines.append("OCT trading-agent — Phase-1 LEARNER result (learned policy vs baselines, after costs)")
    lines.append("=" * width)
    lines.append(f"walk-forward axis : {result.axis} (time-ordered; never random)")
    lines.append(f"train / eval envs : {result.n_train_envs} / {result.n_eval_envs}")
    lines.append(f"raw-chart causal  : {'CERTIFIED' if result.causal_certified else 'FAILED'}")
    lines.append("")
    header = (
        f"{'policy':<16}{'n':>3}{'mean_ret':>11}{'total_ret':>11}{'sharpe':>10}"
        f"{'sortino':>10}{'cvar5%':>11}{'maxDD':>8}{'hit%':>7}{'trades':>8}{'fees_SOL':>12}"
    )
    lines.append(header)
    lines.append("-" * len(header))
    order = ["learned_agent", "hold_sol", "buy_and_hold", "random"]
    if "noised_agent" in result.evaluations:
        order.append("noised_agent")
    for name in order:
        ev = result.evaluations.get(name)
        if ev is None:
            continue
        m = ev.metrics
        lines.append(
            f"{name:<16}{m.n_returns:>3}{m.mean_return:>11.4f}{m.total_return:>11.4f}"
            f"{m.sharpe:>10.2f}{m.sortino:>10.3f}{m.cvar:>11.4f}{m.max_drawdown:>8.3f}"
            f"{m.hit_rate * 100:>6.1f}%{int(m.turnover):>8}{m.total_fees_quote:>12.6f}"
        )
    lines.append("")
    lines.append("per-token edge (learned_agent minus baseline), out-of-sample:")
    for baseline, (frac, mean_edge) in result.edges.items():
        lines.append(
            f"  vs {baseline:<14}: mean_edge={mean_edge:+.4f}  fraction_beaten={frac * 100:>5.1f}%"
        )
    lines.append("")
    if result.noised_agent_shows_edge is None:
        lines.append("leakage guard     : NOT RUN")
    else:
        collapsed = not result.noised_agent_shows_edge
        lines.append(
            f"leakage guard     : noised-tier agent shows edge over hold-SOL = "
            f"{result.noised_agent_shows_edge} "
            f"({'edge collapsed under noise — good' if collapsed else 'did NOT collapse — suspect leakage'})"
        )
    lines.append("")
    v = result.verdict
    lines.append("-" * width)
    lines.append(f"PHASE-1 GATE VERDICT : {v.verdict}")
    lines.append(f"  beats hold-SOL      : {v.beats_hold_sol}")
    lines.append(f"  beats buy-and-hold  : {v.beats_buy_and_hold}")
    lines.append(f"  leakage guard passed: {v.leakage_guard_passed}")
    lines.append(f"  {v.rationale}")
    lines.append("=" * width)
    lines.append(
        "NOTE: a NO-GO / INCONCLUSIVE is a valid, pre-registered Phase-1 result (charter §2). "
        "Deferred: offline-RL / imitation warm-start (needs the labeled-wallet DB, not yet wired)."
    )
    lines.append("=" * width)
    return "\n".join(lines)


def _load_tapes(*, live: bool, live_tokens: int, amm_pool: str | None) -> list[TokenTape]:
    """Load the tape(s): offline fixture, one live pool, or several live pump.fun pools."""
    if not live:
        return [load_bonding_curve_fixture()]
    try:
        if live_tokens > 1:
            from oct_trading_agent.agent.train_data import load_live_bonding_curve_tapes

            tapes = load_live_bonding_curve_tapes(max_tokens=live_tokens)
            if len(tapes) >= 2:
                return tapes
            raise RuntimeError(f"discovered only {len(tapes)} usable live token(s); need >=2")
        from oct_trading_agent.eval.data import load_live_bonding_curve_tape

        kwargs = {"amm_pool": amm_pool} if amm_pool else {}
        tape = load_live_bonding_curve_tape(**kwargs)  # type: ignore[arg-type]
        if tape.n_swaps == 0:
            raise RuntimeError("live pull returned no decodable swaps")
        return [tape]
    except Exception as exc:
        fixture = load_bonding_curve_fixture()
        return [
            TokenTape(
                mint=fixture.mint,
                swaps=fixture.swaps,
                source=f"{fixture.source} (live fell back: {type(exc).__name__}: {exc})",
            )
        ]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="bounded live Pinax pull (falls back to fixture)")
    parser.add_argument("--live-tokens", type=int, default=1, help="distinct live pump.fun pools (>1 enables held-out-tokens)")
    parser.add_argument("--amm-pool", type=str, default=None, help="pool address for a single live pull")
    parser.add_argument("--axis", choices=["held-out-time", "held-out-tokens"], default="held-out-time")
    parser.add_argument("--iterations", type=int, default=40, help="PPO iterations (bounded compute)")
    parser.add_argument("--windows", type=int, default=None, help="number of walk-forward windows")
    parser.add_argument("--seed", type=int, default=0, help="training seed")
    parser.add_argument("--seeds", type=int, default=1, help="number of seeds to run (reports each)")
    parser.add_argument("--risk-beta", type=float, default=0.0, help="CVaR blend for the value baseline (§6.3)")
    parser.add_argument("--no-leakage-guard", action="store_true", help="skip the noise-ablation retrain")
    args = parser.parse_args()

    tapes = _load_tapes(live=args.live, live_tokens=args.live_tokens, amm_pool=args.amm_pool)
    print(f"loaded {len(tapes)} token tape(s): " + "; ".join(t.source for t in tapes))
    axis = args.axis if not (args.live_tokens > 1 and len(tapes) >= 2) else "held-out-tokens"

    for s in range(args.seeds):
        seed = args.seed + s
        cfg = TrainConfig(n_iterations=args.iterations, risk_beta=args.risk_beta)
        print(f"\n########## SEED {seed} ##########")
        result = run_phase1(
            tapes, axis=axis, train_config=cfg, seed=seed, n_windows=args.windows,
            run_leakage_guard=not args.no_leakage_guard,
        )
        print(format_result(result))


if __name__ == "__main__":
    main()


__all__ = [
    "BaselineComparison",
    "GateVerdict",
    "Phase1Result",
    "PreparedToken",
    "TrainConfig",
    "WalkForward",
    "build_walk_forward_time",
    "build_walk_forward_tokens",
    "format_result",
    "phase1_gate",
    "prepare_token",
    "run_phase1",
    "train_policy",
]
