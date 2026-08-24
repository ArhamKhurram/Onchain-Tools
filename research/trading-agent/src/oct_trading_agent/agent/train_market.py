"""Full-chart, multi-venue LEARNER on a progressive token-count ladder (10 → 100 → 1k → 10k → 100k).

This is the serious training the task asks for, on the generic env (:mod:`.envs.generic_env`) instead
of the bonding-only one. Two things make it "serious", both honest:

1. **Full charts, real venues.** Each episode is a token's WHOLE life on the venue it actually traded
   (``pumpfun_amm`` / ``raydium_*`` / a CLMM), filled by
   :class:`~oct_trading_agent.sim.replay.generic_simulator.MarketReplaySimulator` — not the
   bonding-curve seed that produced impossible fills on migrated tokens. Router (``jupiter_v6``) and
   unsupported-venue tokens are SKIPPED and counted, never faked.

2. **A ladder, not one dataset size.** We train at increasing token counts and report at each rung
   whether the agent actually TRADES (trade count + tokens touched), its risk-adjusted metrics vs
   hold-SOL / buy-and-hold, and the held-out-**tokens** edge (newest tokens are the test set). The
   point is to watch behaviour/edge evolve as data scales. Rung N+1 **warm-starts** from rung N's
   policy (the model is checkpointed between rungs), so the ladder is one continuing run.

The compute-heavy training (larger net than Phase 1, an entropy-decay schedule, 1000+ PPO iters) is
behind the ``learn`` extra; the pure ladder/holdout/report logic is import-safe without torch. The
walk-forward is time-ordered by token launch — never random — reusing ``eval/walkforward``.

Run:
    uv run --extra learn python -m oct_trading_agent.agent.train_market \
        --dataset data/market_dataset --rungs 10,100,1000 --iterations 1500

Data source precedence: ``--dataset DIR`` (the persisted, resumable
:class:`~oct_trading_agent.data.dataset.MarketSwapDataset` — the only path to the high rungs), else a
bounded ``--live`` single-page pull (low hundreds of tokens max), else the offline fixture (one token
— enough to smoke-test the pipeline, not the ladder).
"""

from __future__ import annotations

import argparse
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from oct_trading_agent.agent.envs import (
    EnvConfig,
    MarketReplayEnv,
    TradingEnv,
    build_market_regime,
    market_sim_config,
    vector_length,
)
from oct_trading_agent.agent.envs.generic_env import MarketRegime
from oct_trading_agent.agent.imitation.demos import build_cohort_action_tape
from oct_trading_agent.agent.policies import EnvPolicy
from oct_trading_agent.agent.train import GateVerdict, phase1_gate
from oct_trading_agent.data.labeling.schema import LabeledWallet
from oct_trading_agent.eval.baselines import (
    BuyAndHoldPolicy,
    CohortReplayPolicy,
    HoldSolPolicy,
    RandomPolicy,
)
from oct_trading_agent.eval.data import TokenTape, load_bonding_curve_fixture
from oct_trading_agent.eval.runner import PolicyEvaluation, evaluate_policy, per_token_edge
from oct_trading_agent.eval.walkforward import TokenSpan, token_time_holdout

DEFAULT_RUNGS = (10, 100, 1000, 10000, 100000)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MarketTrainConfig:
    """Heavy training budget for the ladder. Larger net + entropy decay + many iters vs Phase 1.

    ``entropy_coef`` → ``entropy_final`` is a LINEAR schedule across iterations: explore early, exploit
    late. A NO-GO is still a legitimate, honestly-reported outcome — a bigger budget buys a fairer
    look, not a guaranteed edge.
    """

    n_iterations: int = 1500
    episodes_per_iter: int = 4
    hidden_dim: int = 128
    n_quantiles: int = 16
    cvar_alpha: float = 0.05
    risk_beta: float = 0.0
    learning_rate: float = 3e-4
    entropy_coef: float = 0.02
    entropy_final: float = 0.002
    gamma: float = 0.99
    gae_lambda: float = 0.95
    risk_budget_quote: Decimal = Decimal("0.05")
    initial_balance_quote: Decimal = Decimal(1)
    # Tier-A+ ablation flag (paper §4.4): adds the three Hawkes attention slots (λ_buy/μ, n,
    # suspicion) to every env observation AND widens the net input to match. OFF by default —
    # flag-off runs are byte-identical to before.
    attention_features: bool = False


# ---------------------------------------------------------------------------
# Env construction (full-chart episodes; held-out-tokens split)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PreparedMarket:
    """A tradeable token's resolved regime — ready to spin fresh envs on demand."""

    mint: str
    regime: MarketRegime
    start_time: datetime  # first swap time — orders the token-launch holdout


@dataclass
class MarketWalkForward:
    """A time-ordered held-out-**tokens** split over full-chart market envs, plus what was skipped."""

    train: list[PreparedMarket]
    test: list[PreparedMarket]
    skipped: dict[str, str] = field(default_factory=dict)  # mint -> reason (router/unsupported/…)

    def env(self, prepared: PreparedMarket, cfg: MarketTrainConfig, *, seed: int) -> MarketReplayEnv:
        return MarketReplayEnv.from_regime(
            prepared.regime,
            market_sim_config(risk_budget_quote=cfg.risk_budget_quote, seed=seed),
            config=EnvConfig(
                initial_balance_quote=cfg.initial_balance_quote,
                attention_features=cfg.attention_features,
            ),
        )

    def train_envs(self, cfg: MarketTrainConfig, *, seed: int = 0) -> list[TradingEnv]:
        return [self.env(p, cfg, seed=seed) for p in self.train]

    def test_envs(self, cfg: MarketTrainConfig, *, seed: int = 0) -> list[TradingEnv]:
        return [self.env(p, cfg, seed=seed) for p in self.test]


def prepare_market_tokens(tapes: list[TokenTape]) -> tuple[list[PreparedMarket], dict[str, str]]:
    """Resolve each token to a tradeable :class:`MarketRegime`; collect skip reasons for the rest."""
    prepared: list[PreparedMarket] = []
    skipped: dict[str, str] = {}
    for tape in tapes:
        regime = build_market_regime(list(tape.swaps))
        if not regime.tradeable:
            skipped[tape.mint] = regime.reason or "not tradeable"
            continue
        start = min(e.block_time for e in tape.swaps)
        prepared.append(PreparedMarket(mint=tape.mint, regime=regime, start_time=start))
    return prepared, skipped


def build_market_walk_forward(
    tapes: list[TokenTape], *, test_fraction: float = 0.3
) -> MarketWalkForward:
    """Held-out-**tokens** split: the newest tokens (by launch) are the test set; earlier ones train.

    Non-tradeable tokens (router / unsupported venue / too-few-swaps) are dropped and their reasons
    recorded — the honest denominator behind every rung.
    """
    prepared, skipped = prepare_market_tokens(tapes)
    if len(prepared) < 2:
        # Degenerate rung: everything trains, nothing tests (reported as such, not hidden).
        return MarketWalkForward(train=prepared, test=[], skipped=skipped)
    spans = [TokenSpan(mint=p.mint, start_time=p.start_time) for p in prepared]
    holdout = token_time_holdout(spans, test_fraction)
    by_mint = {p.mint: p for p in prepared}
    return MarketWalkForward(
        train=[by_mint[m] for m in holdout.train],
        test=[by_mint[m] for m in holdout.test],
        skipped=skipped,
    )


# ---------------------------------------------------------------------------
# Training (torch-gated) — heavy net, entropy schedule, warm-start across rungs
# ---------------------------------------------------------------------------


@dataclass
class TrainedPolicy:
    """A trained policy plus the torch state needed to WARM-START the next rung from it."""

    policy: EnvPolicy
    model: Any  # HybridActorCritic (kept opaque so this module imports without torch)
    normalizer: Any


@dataclass
class RungTrainState:
    """Mid-rung resumable state — enough to continue one rung's PPO loop from where a kill interrupted it.

    A single rung can be 1000+ PPO iterations (hours), so the ladder checkpoints INSIDE a rung: the
    weights, the observation normalizer, the Adam optimizer state, the exact iteration reached, and the
    RNG streams. The linear entropy schedule is a pure function of ``iter_done`` and the iteration budget,
    so restoring the iteration restores the schedule position too — nothing about it needs persisting.
    """

    iter_done: int
    model_state: Any
    normalizer: Any
    optimizer_state: Any
    torch_rng: Any
    np_rng: Any
    py_rng: Any


def train_market_policy(
    train_envs: list[TradingEnv],
    cfg: MarketTrainConfig,
    *,
    seed: int,
    warm_start: TrainedPolicy | None = None,
    device: Any = None,
    resume_state: RungTrainState | None = None,
    on_checkpoint: Callable[[RungTrainState], None] | None = None,
    checkpoint_every: int = 0,
    log: Callable[[str], None] = lambda _m: None,
) -> TrainedPolicy:
    """Train the hybrid actor + distributional critic with PPO and a LINEAR entropy-decay schedule.

    ``warm_start`` continues from a previous rung's model + observation normalizer (the ladder's
    continuity); ``None`` builds a fresh larger-than-Phase-1 net on ``device`` (a ``torch.device`` from
    :func:`~oct_trading_agent.agent.device.resolve_device`, or ``None`` for the default CPU). A
    warm-started model already sits on its device, so the ladder stays on one device across rungs.
    Requires the ``learn`` extra.

    ``resume_state`` restores a mid-rung :class:`RungTrainState` (weights + optimizer + RNG + iteration)
    and continues the loop from ``iter_done``, taking precedence over ``warm_start``. With
    ``checkpoint_every > 0`` and an ``on_checkpoint`` sink, a fresh :class:`RungTrainState` snapshot is
    handed to the sink every ``checkpoint_every`` iterations so the ladder can persist it atomically.
    """
    import copy
    import random
    from dataclasses import replace

    import numpy as np
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

    # A resume restores the RNG streams below; only a fresh/warm-started run seeds them.
    if resume_state is None:
        torch.manual_seed(seed)
        np.random.seed(seed)
        random.seed(seed)

    if resume_state is not None:
        model = build_actor_critic(
            ActorConfig(
                hidden_dim=cfg.hidden_dim, n_quantiles=cfg.n_quantiles, cvar_alpha=cfg.cvar_alpha,
                d_in=vector_length(attention=cfg.attention_features),
            ),
            device=device,
        )
        model.load_state_dict(resume_state.model_state)
        normalizer = resume_state.normalizer
    elif warm_start is not None:
        model = warm_start.model
        normalizer = warm_start.normalizer
    else:
        model = build_actor_critic(
            ActorConfig(
                hidden_dim=cfg.hidden_dim, n_quantiles=cfg.n_quantiles, cvar_alpha=cfg.cvar_alpha,
                d_in=vector_length(attention=cfg.attention_features),
            ),
            device=device,
        )
        normalizer = RunningNormalizer()

    base_ppo = PPOConfig(
        learning_rate=cfg.learning_rate,
        entropy_coef=cfg.entropy_coef,
        gamma=cfg.gamma,
        gae_lambda=cfg.gae_lambda,
        risk_beta=cfg.risk_beta,
        cvar_alpha=cfg.cvar_alpha,
    )
    trainer = PPOTrainer(model, base_ppo)

    start = 0
    if resume_state is not None:
        trainer.optimizer.load_state_dict(resume_state.optimizer_state)
        torch.set_rng_state(resume_state.torch_rng.cpu())
        np.random.set_state(resume_state.np_rng)
        random.setstate(resume_state.py_rng)
        start = resume_state.iter_done

    n = max(1, cfg.n_iterations)

    def _snapshot(iter_done: int) -> RungTrainState:
        return RungTrainState(
            iter_done=iter_done,
            model_state=copy.deepcopy(model.state_dict()),
            normalizer=copy.deepcopy(normalizer),
            optimizer_state=copy.deepcopy(trainer.optimizer.state_dict()),
            torch_rng=torch.get_rng_state(),
            np_rng=np.random.get_state(),
            py_rng=random.getstate(),
        )

    for it in range(start, n):
        # Linear entropy decay: explore early, exploit late (reassign the frozen config per iter).
        frac = it / max(1, n - 1)
        entropy = cfg.entropy_coef + frac * (cfg.entropy_final - cfg.entropy_coef)
        trainer.config = replace(base_ppo, entropy_coef=entropy)

        buffer = RolloutBuffer(gamma=cfg.gamma, lam=cfg.gae_lambda)
        for _ in range(cfg.episodes_per_iter):
            collect_rollouts(
                model, train_envs, normalizer, buffer,
                update_normalizer=True, risk_beta=cfg.risk_beta, cvar_alpha=cfg.cvar_alpha,
            )
        batch = buffer.compute()
        stats = trainer.update(batch)
        if (it + 1) % max(1, n // 10) == 0:
            log(
                f"    iter {it + 1:>4}/{n}  steps={len(batch):>6}  ent_coef={entropy:.4f}  "
                f"pol={stats.policy_loss:+.4f}  val={stats.value_loss:.4f}  "
                f"ent={stats.entropy:+.3f}  kl={stats.approx_kl:+.4f}"
            )
        if checkpoint_every > 0 and on_checkpoint is not None and (it + 1) % checkpoint_every == 0:
            on_checkpoint(_snapshot(it + 1))

    policy = TorchPolicy(model, normalizer=normalizer, deterministic=True)
    return TrainedPolicy(policy=policy, model=model, normalizer=normalizer)


# ---------------------------------------------------------------------------
# Per-rung evaluation + report
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RungResult:
    """Everything one ladder rung produced — trade behaviour, metrics, held-out edge, gate verdict."""

    n_tokens_requested: int
    n_tradeable: int
    n_train: int
    n_test: int
    n_skipped: int
    skip_reasons: dict[str, int]
    agent_total_trades: int
    agent_tokens_traded: int
    evaluations: dict[str, PolicyEvaluation]
    edges: dict[str, tuple[float, float]]
    verdict: GateVerdict | None


def _skip_histogram(skipped: dict[str, str]) -> dict[str, int]:
    hist: dict[str, int] = {}
    for reason in skipped.values():
        key = reason.split(":")[0].strip()
        hist[key] = hist.get(key, 0) + 1
    return hist


def evaluate_rung(
    agent: EnvPolicy,
    wf: MarketWalkForward,
    cfg: MarketTrainConfig,
    *,
    n_tokens_requested: int,
    seed: int,
    cohort: Sequence[LabeledWallet] | None = None,
) -> RungResult:
    """Score the agent + the baselines on the held-out tokens; assemble the rung report.

    Beyond the three mechanical baselines (hold-SOL / buy-and-hold / random), when ``cohort`` is given
    a FOURTH ``tracked_traders`` baseline is scored: the tracked traders' OWN realized actions on the
    held-out mints, replayed through the same env at the same costs (the operator's north-star bar —
    "out-trade the tracked traders themselves"). Its action tape is built from ONLY the held-out
    tokens' cohort trades, so the comparison is same-tokens and leakage-free.
    """
    n_tradeable = len(wf.train) + len(wf.test)
    if not wf.test:
        # No held-out tokens (too few tradeable) — report trade behaviour on train, no gate.
        eval_set = wf.train_envs(cfg, seed=seed)
        agent_eval = evaluate_policy(eval_set, agent, "learned_agent")
        return RungResult(
            n_tokens_requested=n_tokens_requested, n_tradeable=n_tradeable,
            n_train=len(wf.train), n_test=0, n_skipped=len(wf.skipped),
            skip_reasons=_skip_histogram(wf.skipped),
            agent_total_trades=sum(o.n_trades for o in agent_eval.outcomes),
            agent_tokens_traded=sum(1 for o in agent_eval.outcomes if o.n_trades > 0),
            evaluations={"learned_agent": agent_eval}, edges={}, verdict=None,
        )

    agent_eval = evaluate_policy(wf.test_envs(cfg, seed=seed), agent, "learned_agent")
    hold_eval = evaluate_policy(wf.test_envs(cfg, seed=seed), HoldSolPolicy(), "hold_sol")
    buy_eval = evaluate_policy(wf.test_envs(cfg, seed=seed), BuyAndHoldPolicy(size=1.0), "buy_and_hold")
    rand_eval = evaluate_policy(wf.test_envs(cfg, seed=seed), RandomPolicy(seed=seed + 100), "random")

    edge_hs = per_token_edge(agent_eval, hold_eval)
    edge_bh = per_token_edge(agent_eval, buy_eval)
    edges = {
        "hold_sol": (edge_hs.fraction_beaten, edge_hs.mean_edge),
        "buy_and_hold": (edge_bh.fraction_beaten, edge_bh.mean_edge),
    }
    evaluations: dict[str, PolicyEvaluation] = {
        "learned_agent": agent_eval, "hold_sol": hold_eval,
        "buy_and_hold": buy_eval, "random": rand_eval,
    }

    # The north-star baseline: the tracked traders' own realized actions on the SAME held-out mints,
    # scored through the SAME env at the SAME costs. Built ONLY from the test mints' cohort trades.
    if cohort:
        test_mints = {p.mint for p in wf.test}
        action_tape = build_cohort_action_tape(cohort, mints=test_mints)
        cohort_eval = evaluate_policy(
            wf.test_envs(cfg, seed=seed), CohortReplayPolicy(action_tape), "tracked_traders"
        )
        edge_tt = per_token_edge(agent_eval, cohort_eval)
        edges["tracked_traders"] = (edge_tt.fraction_beaten, edge_tt.mean_edge)
        evaluations["tracked_traders"] = cohort_eval

    verdict = phase1_gate(
        agent_eval, hold_eval, buy_eval,
        edge_vs_hold_sol=edges["hold_sol"], edge_vs_buy_and_hold=edges["buy_and_hold"],
        noised_agent_shows_edge=None,  # the leakage guard is a Phase-1 concern; not re-run per rung
    )
    return RungResult(
        n_tokens_requested=n_tokens_requested, n_tradeable=n_tradeable,
        n_train=len(wf.train), n_test=len(wf.test), n_skipped=len(wf.skipped),
        skip_reasons=_skip_histogram(wf.skipped),
        agent_total_trades=sum(o.n_trades for o in agent_eval.outcomes),
        agent_tokens_traded=sum(1 for o in agent_eval.outcomes if o.n_trades > 0),
        evaluations=evaluations,
        edges=edges, verdict=verdict,
    )


def format_rung(result: RungResult) -> str:
    """Render one rung: skip accounting, does-it-trade, the metric battery, edge, and the verdict."""
    lines: list[str] = []
    lines.append("-" * 96)
    lines.append(
        f"RUNG {result.n_tokens_requested} tokens : tradeable={result.n_tradeable} "
        f"(train={result.n_train} test={result.n_test})  skipped={result.n_skipped} {result.skip_reasons}"
    )
    lines.append(
        f"  DOES IT TRADE? total_trades={result.agent_total_trades}  "
        f"tokens_traded={result.agent_tokens_traded}/{result.n_test or result.n_train}"
    )
    if result.evaluations:
        header = (
            f"  {'policy':<15}{'n':>3}{'mean_ret':>11}{'sharpe':>9}{'sortino':>9}"
            f"{'cvar5%':>10}{'maxDD':>8}{'hit%':>7}{'trades':>8}{'fees':>11}"
        )
        lines.append(header)
        for name in ("learned_agent", "tracked_traders", "hold_sol", "buy_and_hold", "random"):
            ev = result.evaluations.get(name)
            if ev is None:
                continue
            m = ev.metrics
            lines.append(
                f"  {name:<15}{m.n_returns:>3}{m.mean_return:>11.4f}{m.sharpe:>9.2f}"
                f"{m.sortino:>9.3f}{m.cvar:>10.4f}{m.max_drawdown:>8.3f}"
                f"{m.hit_rate * 100:>6.1f}%{int(m.turnover):>8}{m.total_fees_quote:>11.5f}"
            )
    for baseline, (frac, edge) in result.edges.items():
        lines.append(f"  edge vs {baseline:<13}: mean={edge:+.4f}  beaten={frac * 100:>5.1f}%")
    if result.verdict is not None:
        v = result.verdict
        lines.append(f"  VERDICT: {v.verdict}  (hold-SOL={v.beats_hold_sol} buy&hold={v.beats_buy_and_hold})")
    else:
        lines.append("  VERDICT: N/A (no held-out tokens at this rung)")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# The ladder
# ---------------------------------------------------------------------------


@dataclass
class LadderCheckpoint:
    """Resumable ladder state: which rungs are done, the warm-start weights, and any in-progress rung.

    ``completed_rungs`` are skipped on resume; ``warm_model_state`` / ``warm_normalizer`` rebuild the
    warm-start the next rung would continue from; ``in_progress`` (with ``in_progress_rung``) is a
    mid-rung :class:`RungTrainState` so a kill DURING a rung resumes at its iteration, not from the rung's
    start. Written atomically after every rung and (with ``checkpoint_every``) inside a rung.
    """

    seed: int
    rungs: list[int]
    completed_rungs: list[int]
    warm_model_state: Any
    warm_normalizer: Any
    in_progress_rung: int | None
    in_progress: RungTrainState | None


def save_ladder_checkpoint(path: Path, ckpt: LadderCheckpoint) -> None:  # pragma: no cover - torch
    """Atomically persist the ladder's resumable state (temp file + rename)."""
    from oct_trading_agent.agent.population.checkpoint import save_torch

    save_torch(path, ckpt)


def load_ladder_checkpoint(
    path: Path, *, device: Any = None
) -> LadderCheckpoint:  # pragma: no cover - torch
    """Load a ladder checkpoint, mapping its weight tensors onto ``device``."""
    from oct_trading_agent.agent.population.checkpoint import load_torch

    ckpt = load_torch(path, map_location=device)
    assert isinstance(ckpt, LadderCheckpoint)
    return ckpt


def _rebuild_warm(
    model_state: Any, normalizer: Any, cfg: MarketTrainConfig, *, device: Any = None
) -> TrainedPolicy:  # pragma: no cover - torch
    """Rebuild the warm-start :class:`TrainedPolicy` from a ladder checkpoint's stored weights."""
    from oct_trading_agent.agent.policies import TorchPolicy
    from oct_trading_agent.agent.policies.torch_actor import ActorConfig, build_actor_critic

    model = build_actor_critic(
        ActorConfig(
            hidden_dim=cfg.hidden_dim, n_quantiles=cfg.n_quantiles, cvar_alpha=cfg.cvar_alpha,
            d_in=vector_length(attention=cfg.attention_features),
        ),
        device=device,
    )
    model.load_state_dict(model_state)
    policy = TorchPolicy(model, normalizer=normalizer, deterministic=True)
    return TrainedPolicy(policy=policy, model=model, normalizer=normalizer)


def run_ladder(
    tapes: list[TokenTape],
    *,
    rungs: tuple[int, ...] = DEFAULT_RUNGS,
    cfg: MarketTrainConfig | None = None,
    seed: int = 0,
    checkpoint_dir: Path | None = None,
    warm_start_across_rungs: bool = True,
    cohort: Sequence[LabeledWallet] | None = None,
    device: Any = None,
    checkpoint_path: Path | None = None,
    checkpoint_every: int = 0,
    resume: Path | None = None,
    log: Callable[[str], None] = print,
) -> list[RungResult]:
    """Train and report across the token-count ladder, warm-starting each rung from the previous one.

    Only rungs whose size is achievable from ``tapes`` are RUN (a rung asking for more tokens than the
    dataset holds is reported as capped and stops the ladder — the honest scale limit). Requires the
    ``learn`` extra (it trains). When ``cohort`` (tracked-trader histories) is given, each rung also
    reports the agent head-to-head against the ``tracked_traders`` baseline on that rung's held-out
    mints.

    Overnight-survival: a ladder checkpoint (completed rungs + warm-start weights + any in-progress rung
    state) is written atomically after every rung to ``checkpoint_path`` (default
    ``<checkpoint_dir>/ladder.ckpt.pt``); with ``checkpoint_every > 0`` it is ALSO written inside a rung
    every N PPO iterations, so a kill mid-rung loses at most N iterations. ``resume`` restores such a
    checkpoint: completed rungs are skipped, an interrupted rung continues from its iteration, and the
    ladder reports only the rungs it (re)runs this pass.
    """
    config = cfg or MarketTrainConfig()
    results: list[RungResult] = []
    warm: TrainedPolicy | None = None
    completed_rungs: list[int] = []
    in_progress_rung: int | None = None
    in_progress_state: RungTrainState | None = None

    ckpt_path = checkpoint_path or (checkpoint_dir / "ladder.ckpt.pt" if checkpoint_dir else None)
    every = max(0, checkpoint_every)

    if resume is not None:
        state = load_ladder_checkpoint(resume, device=device)
        seed = state.seed
        completed_rungs = list(state.completed_rungs)
        in_progress_rung = state.in_progress_rung
        in_progress_state = state.in_progress
        if state.warm_model_state is not None:
            warm = _rebuild_warm(state.warm_model_state, state.warm_normalizer, config, device=device)
        log(
            f"[ladder] RESUMED from {resume}: completed={completed_rungs} "
            f"in_progress_rung={in_progress_rung} "
            f"in_progress_iter={in_progress_state.iter_done if in_progress_state else None}"
        )

    def _write_ckpt(*, ip_rung: int | None, ip_state: RungTrainState | None) -> None:
        if ckpt_path is None:
            return
        import copy

        wm = copy.deepcopy(warm.model.state_dict()) if warm is not None else None
        wn = copy.deepcopy(warm.normalizer) if warm is not None else None
        save_ladder_checkpoint(
            ckpt_path,
            LadderCheckpoint(
                seed=seed, rungs=list(rungs), completed_rungs=list(completed_rungs),
                warm_model_state=wm, warm_normalizer=wn,
                in_progress_rung=ip_rung, in_progress=ip_state,
            ),
        )

    cur_rung = {"n": -1}  # holder so the checkpoint sink (defined once) knows the live rung

    def _on_ckpt(st: RungTrainState) -> None:
        _write_ckpt(ip_rung=cur_rung["n"], ip_state=st)
        log(f"[ladder] rung {cur_rung['n']}: checkpoint @ iter {st.iter_done} -> {ckpt_path}")

    for rung in rungs:
        if rung in completed_rungs:
            log(f"[ladder] rung {rung}: already completed (resumed) — skipping.")
            continue
        rung_tapes = tapes[:rung]
        if len(rung_tapes) < min(rung, 2):
            log(f"[ladder] rung {rung}: only {len(tapes)} tokens available — STOP (dataset-capped).")
            break
        capped = len(rung_tapes) < rung
        wf = build_market_walk_forward(rung_tapes)
        log(
            f"[ladder] rung {rung}{' (capped to ' + str(len(rung_tapes)) + ')' if capped else ''}: "
            f"tradeable={len(wf.train) + len(wf.test)} skipped={len(wf.skipped)} — training..."
        )
        train_envs = wf.train_envs(config, seed=seed)
        if not train_envs:
            log(f"[ladder] rung {rung}: no tradeable train tokens — skipping rung.")
            continue

        # Resume the interrupted rung from its checkpoint; otherwise warm-start from the prior rung.
        rung_resume = in_progress_state if rung == in_progress_rung else None
        cur_rung["n"] = rung
        sink = _on_ckpt if (every > 0 and ckpt_path is not None) else None
        trained = train_market_policy(
            train_envs, config, seed=seed,
            warm_start=warm if warm_start_across_rungs else None, device=device,
            resume_state=rung_resume, on_checkpoint=sink, checkpoint_every=every, log=log,
        )
        # The rung is done — clear any in-progress marker so a later checkpoint doesn't re-resume it.
        in_progress_rung = None
        in_progress_state = None
        result = evaluate_rung(
            trained.policy, wf, config, n_tokens_requested=rung, seed=seed, cohort=cohort
        )
        results.append(result)
        log(format_rung(result))

        if checkpoint_dir is not None:
            _checkpoint(trained, checkpoint_dir, rung)
        warm = trained
        completed_rungs.append(rung)
        _write_ckpt(ip_rung=None, ip_state=None)
        if capped:
            log(f"[ladder] rung {rung} was the last achievable rung ({len(rung_tapes)} tokens).")
            break
    return results


def _checkpoint(trained: TrainedPolicy, checkpoint_dir: Path, rung: int) -> None:  # pragma: no cover
    from oct_trading_agent.agent.population.checkpoint import save_torch

    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    save_torch(checkpoint_dir / f"rung_{rung}.pt", trained.model.state_dict())


# ---------------------------------------------------------------------------
# Data loading + CLI
# ---------------------------------------------------------------------------


def _load_tapes(args: argparse.Namespace) -> list[TokenTape]:  # pragma: no cover - IO/live
    protocols = tuple(p.strip() for p in args.protocols.split(",") if p.strip())
    if args.dataset:
        from oct_trading_agent.data.dataset import MarketSwapDataset

        dataset = MarketSwapDataset(Path(args.dataset))
        tapes = dataset.load_token_tapes(
            max_tokens=max(args.rungs_list), min_swaps=args.min_swaps, protocols=protocols
        )
        if tapes:
            return tapes
        print(f"[data] dataset at {args.dataset} yielded no tapes; falling back")
    if args.live:
        try:
            from oct_trading_agent.agent.train_data import load_live_market_tapes

            tapes = load_live_market_tapes(
                protocols=protocols, max_tokens=max(args.rungs_list), min_swaps=args.min_swaps
            )
            if len(tapes) >= 2:
                return tapes
            print(f"[data] live page yielded {len(tapes)} token(s); falling back to fixture")
        except Exception as exc:
            print(f"[data] live pull failed ({type(exc).__name__}: {exc}); falling back to fixture")
    fixture = load_bonding_curve_fixture()
    return [fixture]


def _load_cohort(args: argparse.Namespace) -> list[LabeledWallet]:  # pragma: no cover - IO/live
    """Load tracked-trader histories for the ``tracked_traders`` baseline (opt-in via --wallets-file).

    Reuses the Phase-2 cohort loader: parse the operator's export, take the bounded top-balance cohort,
    and pull each wallet's swap history from Pinax. Returns ``[]`` (baseline OFF) when no file is given
    or when a **genuine data/network failure** degrades the pull — the ladder still runs its three
    mechanical baselines, and every degrade prints a loud ``[cohort] baseline OFF:`` line.

    Every print here goes through :func:`safe_print` (wallet names carry emoji the cp1252 Windows
    console cannot encode), and a ``UnicodeError`` is deliberately re-raised rather than degraded:
    a LOGGING failure must crash loudly, never silently disable the baseline.
    """
    if not args.wallets_file:
        return []
    from oct_trading_agent.agent.imitation.cohort import load_cohort_from_pinax
    from oct_trading_agent.console import safe_print
    from oct_trading_agent.data.labeling.wallets_file import parse_tracked_wallets, select_cohort

    # Reading + parsing the export: only genuine file/shape errors degrade (OSError covers a
    # missing/unreadable path; ValueError covers bad JSON — JSONDecodeError subclasses it — and a
    # malformed top-level shape).
    try:
        tracked = parse_tracked_wallets(args.wallets_file)
        cohort = select_cohort(tracked, max_wallets=args.max_wallets)
    except (OSError, ValueError) as exc:
        safe_print(
            f"[cohort] baseline OFF: could not read wallets file ({type(exc).__name__}: {exc})"
        )
        return []
    safe_print(f"[cohort] selected {len(cohort)} / {len(tracked)} tracked wallets (top by balance)")

    # The live pull: per-wallet failures are already isolated inside load_cohort_from_pinax; what
    # escapes is setup-level (missing PINAX_API_KEY, client construction, ...). Degrade on those —
    # but never on a UnicodeError, which would be a logging bug, not a data failure (and the
    # safe_print log sink means encoding can no longer raise from inside the pull anyway).
    try:
        pull = load_cohort_from_pinax(cohort, max_pages=args.cohort_pages, log=safe_print)
    except UnicodeError:
        raise  # a logging/encoding bug must be loud, never turn the baseline off
    except Exception as exc:
        safe_print(f"[cohort] baseline OFF: cohort pull failed ({type(exc).__name__}: {exc})")
        return []
    if pull.n_skipped:
        safe_print(f"[cohort] {pull.n_skipped} wallet(s) skipped after retries")
    return pull.wallets


def main() -> None:  # pragma: no cover - CLI
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=str, default=None, help="MarketSwapDataset root (high rungs)")
    parser.add_argument("--live", action="store_true", help="bounded live single-page pull")
    parser.add_argument("--protocols", type=str, default="pumpfun_amm", help="comma-separated venues")
    parser.add_argument("--rungs", type=str, default="10,100,1000", help="comma-separated token counts")
    parser.add_argument("--iterations", type=int, default=1500, help="PPO iterations per rung")
    parser.add_argument("--hidden-dim", type=int, default=128)
    parser.add_argument("--min-swaps", type=int, default=24)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument(
        "--device", type=str, default="auto", choices=("auto", "cuda", "cpu"),
        help="compute device for the net (auto = cuda if available, else cpu)",
    )
    parser.add_argument("--checkpoint-dir", type=str, default=None)
    parser.add_argument(
        "--checkpoint-every", type=int, default=0,
        help="atomically checkpoint the in-progress rung every N PPO iterations (0 = per-rung only)",
    )
    parser.add_argument(
        "--checkpoint-path", type=str, default=None,
        help="ladder resume checkpoint file (default <checkpoint-dir>/ladder.ckpt.pt)",
    )
    parser.add_argument(
        "--resume", type=str, default=None,
        help="resume the ladder from a checkpoint: skip completed rungs, continue an interrupted one",
    )
    parser.add_argument("--no-warm-start", action="store_true", help="train each rung from scratch")
    parser.add_argument(
        "--attention-features", action="store_true",
        help="tier-A+ ablation (paper §4.4): add the Hawkes attention slots (λ_buy/μ, branching n, "
        "manipulation suspicion) to the observation; widens the net input — a resume/warm-start "
        "must use the same flag as the checkpointed run",
    )
    parser.add_argument("--build", action="store_true", help="build/extend the dataset first, then train")
    parser.add_argument("--target-tokens", type=int, default=1000, help="--build: pools to accumulate")
    parser.add_argument("--max-pages", type=int, default=200, help="--build: REST page budget")
    parser.add_argument(
        "--wallets-file", type=str, default=None,
        help="tracked-wallets export (NOT committed): adds the tracked_traders baseline per rung",
    )
    parser.add_argument("--max-wallets", type=int, default=40, help="cohort size (top by SOL balance)")
    parser.add_argument("--cohort-pages", type=int, default=8, help="Pinax pages per cohort wallet")
    args = parser.parse_args()
    args.rungs_list = [int(r) for r in args.rungs.split(",") if r.strip()]

    if args.build and args.dataset:
        from oct_trading_agent.data.dataset import build_dataset

        protocols = tuple(p.strip() for p in args.protocols.split(",") if p.strip())
        print(f"[build] backfilling {args.dataset} for {protocols} (target={args.target_tokens})...")
        manifest = build_dataset(
            args.dataset, protocols=protocols, target_tokens=args.target_tokens,
            max_pages=args.max_pages, min_swaps=args.min_swaps,
        )
        print(f"[build] dataset now has {manifest.n_pools} pools, {manifest.total_rows} rows, "
              f"{manifest.pages_pulled} pages pulled.")

    tapes = _load_tapes(args)
    print(f"[data] loaded {len(tapes)} token tape(s). rungs={args.rungs_list}")
    cohort = _load_cohort(args)
    if cohort:
        print(f"[cohort] loaded {len(cohort)} tracked wallet(s) — tracked_traders baseline is ON.")
    from oct_trading_agent.agent.device import resolve_device

    device = resolve_device(args.device)
    print(f"[device] requested={args.device!r} resolved={device}")
    cfg = MarketTrainConfig(
        n_iterations=args.iterations, hidden_dim=args.hidden_dim,
        attention_features=args.attention_features,
    )
    checkpoint_dir = Path(args.checkpoint_dir) if args.checkpoint_dir else None
    results = run_ladder(
        tapes, rungs=tuple(args.rungs_list), cfg=cfg, seed=args.seed,
        checkpoint_dir=checkpoint_dir, warm_start_across_rungs=not args.no_warm_start,
        cohort=cohort, device=device,
        checkpoint_path=Path(args.checkpoint_path) if args.checkpoint_path else None,
        checkpoint_every=args.checkpoint_every,
        resume=Path(args.resume) if args.resume else None,
    )
    print("\n" + "=" * 96)
    print(f"LADDER COMPLETE — {len(results)} rung(s) run. Highest achievable rung: "
          f"{results[-1].n_tradeable if results else 0} tradeable tokens.")
    print("=" * 96)


if __name__ == "__main__":  # pragma: no cover
    main()


__all__ = [
    "MarketTrainConfig",
    "PreparedMarket",
    "MarketWalkForward",
    "TrainedPolicy",
    "RungTrainState",
    "LadderCheckpoint",
    "RungResult",
    "DEFAULT_RUNGS",
    "prepare_market_tokens",
    "build_market_walk_forward",
    "train_market_policy",
    "evaluate_rung",
    "format_rung",
    "run_ladder",
    "save_ladder_checkpoint",
    "load_ladder_checkpoint",
]
