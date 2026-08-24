"""Population-Based Training (PBT) — the FIRST real population trainer (paper §6.4; 02 §2 (4)).

The research program's thesis is quality-diversity: breed a DIVERSE ENSEMBLE of profitable
archetypes, not one optimum. This module is the engine's first pass. It clones the Phase-1 hybrid
actor-critic into a population of N policies with **perturbed hyperparameters** (learning rate,
entropy coefficient, and the risk-weighting β — an explicit PBT dimension, paper §3.5.3-B), trains
each for a short interval on the market envs, and every generation runs the PBT
**exploit + explore** step: the bottom performers copy a top performer's weights AND hyperparameters
(exploit), then perturb those hyperparameters (explore). Fitness is the honest held-out-token pnl in
basis points, net of the sim's modeled costs — the same eval discipline as the ladder trainer.

Alongside training it emits the **desk telemetry** (:mod:`.telemetry`): each generation the population
is profiled into behavioral descriptors, binned into memecoin archetype niches (:mod:`.descriptor`),
and aggregated to the per-niche viz contract. Only aggregates leave — the file stays
``O(roles × generations)`` regardless of population size.

The population data structures, the exploit/explore SELECTION rule, and the hyperparameter
perturbation are pure and torch-free (unit-tested without the extra); training and evaluation are
torch-gated exactly as the Phase-1 learner is (``uv sync --extra learn``). Reuses the env, sim, eval,
PPO update, and policy verbatim — nothing here reinvents the substrate.

Run:
    uv run --extra learn python -m oct_trading_agent.agent.population.pbt \\
        --dataset data/market_dataset --population 24 --generations 6 \\
        --train-steps-per-gen 3 --seed 0
"""

from __future__ import annotations

import argparse
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from oct_trading_agent.agent.train_market import (
    MarketTrainConfig,
    MarketWalkForward,
    PreparedMarket,
    build_market_walk_forward,
)
from oct_trading_agent.eval.data import TokenTape

from .archive import AgentReport, NicheArchive
from .checkpoint import load_torch, save_torch
from .descriptor import profile_policy
from .telemetry import DeskTelemetryWriter

# ---------------------------------------------------------------------------
# Hyperparameters — the PBT search dimensions and their perturbation (pure, torch-free)
# ---------------------------------------------------------------------------

LR_BOUNDS = (5e-5, 3e-3)
ENTROPY_BOUNDS = (1e-3, 8e-2)
RISK_BETA_BOUNDS = (0.0, 0.5)
_PERTURB_FACTORS = (0.8, 1.2)  # classic PBT multiplicative explore


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


@dataclass(frozen=True)
class Hyperparams:
    """One member's PBT-searched knobs: LR, entropy bonus, and the risk-weighting β (paper §3.5.3-B)."""

    learning_rate: float
    entropy_coef: float
    risk_beta: float

    @classmethod
    def sample(cls, rng: Any) -> Hyperparams:
        """Draw an initial member: LR log-uniform, entropy uniform, β uniform over their bounds."""
        import math

        lo, hi = LR_BOUNDS
        lr = math.exp(rng.uniform(math.log(1e-4), math.log(1e-3)))
        return cls(
            learning_rate=_clamp(lr, lo, hi),
            entropy_coef=rng.uniform(5e-3, 4e-2),
            risk_beta=rng.uniform(0.0, 0.3),
        )

    def perturb(self, rng: Any) -> Hyperparams:
        """EXPLORE: jitter each knob (×0.8/×1.2 for LR & entropy, additive for β), clamped to bounds."""
        return Hyperparams(
            learning_rate=_clamp(
                self.learning_rate * rng.choice(_PERTURB_FACTORS), *LR_BOUNDS
            ),
            entropy_coef=_clamp(
                self.entropy_coef * rng.choice(_PERTURB_FACTORS), *ENTROPY_BOUNDS
            ),
            risk_beta=_clamp(self.risk_beta + rng.uniform(-0.05, 0.05), *RISK_BETA_BOUNDS),
        )


def select_exploit_explore(
    fitnesses: list[float], rng: Any, *, exploit_frac: float = 0.25
) -> list[tuple[int, int]]:
    """The PBT selection rule (pure): which members copy which (loser_idx → winner_idx).

    The bottom ``exploit_frac`` of the population by fitness each copy a RANDOM member from the top
    ``exploit_frac`` (weights + hyperparameters), so a losing slot is reseeded from a proven one. A
    member never copies itself; with a tiny population the bands can overlap, in which case a loser
    that also ranks top is left untouched. Returns the (loser, winner) pairs for :func:`apply_exploit`.
    """
    n = len(fitnesses)
    if n < 2:
        return []
    k = max(1, int(n * exploit_frac))
    order = sorted(range(n), key=lambda i: fitnesses[i])  # ascending: worst first
    losers = order[:k]
    winners = order[-k:]
    winner_set = set(winners)
    pairs: list[tuple[int, int]] = []
    for loser in losers:
        if loser in winner_set:
            continue  # tiny-population overlap: this slot is already top — don't overwrite it
        winner = int(rng.choice(winners))
        pairs.append((loser, winner))
    return pairs


# ---------------------------------------------------------------------------
# Population member + PBT config (member holds torch objects as Any → import stays torch-free)
# ---------------------------------------------------------------------------


@dataclass
class PBTMember:
    """One population slot: its stable id, current hyperparameters, and torch state (opaque)."""

    agent_id: str
    hyperparams: Hyperparams
    model: Any  # HybridActorCritic
    normalizer: Any  # RunningNormalizer
    trainer: Any  # PPOTrainer


@dataclass(frozen=True)
class PBTConfig:
    """PBT run budget — deliberately small (a first population signal, not a sweep)."""

    population_size: int = 24
    generations: int = 6
    train_steps_per_gen: int = 3
    episodes_per_iter: int = 1
    exploit_frac: float = 0.25
    eval_batch_size: int = 8  # train+eval members in mini-batches; bin each into the archive, then drop
    max_train_envs: int = 6
    max_test_envs: int = 16
    hidden_dim: int = 32
    n_quantiles: int = 8
    cvar_alpha: float = 0.05
    torch_threads: int = 2  # be polite: a CPU-heavy ladder run may share this machine


# ---------------------------------------------------------------------------
# Checkpointing — atomic, resumable population + RNG + telemetry timeline
# ---------------------------------------------------------------------------


@dataclass
class PBTMemberState:
    """One population slot's serializable state: its id, hyperparameters, weights, and normalizer.

    The trainer (Adam optimizer) is NOT persisted — a resumed member gets a fresh optimizer, matching how
    exploit already rebuilds the trainer at a generation boundary; the weights and observation normalizer
    are what carry the learned state forward.
    """

    agent_id: str
    hyperparams: Hyperparams
    state_dict: Any
    normalizer: Any


@dataclass
class PBTCheckpoint:
    """The full resumable state of a PBT run: the population, the next generation, and the RNG.

    Saved atomically every ``checkpoint_every`` generations. ``members`` holds each slot's weights +
    hyperparameters AFTER that generation's exploit/explore, ``gen`` is the NEXT generation to run, and
    ``generations`` is the desk-telemetry timeline so a resume continues the growing viz JSON. The three
    RNG snapshots let the continued search reproduce the run that would have happened uninterrupted.
    """

    run_id: str
    seed: int
    gen: int
    population_size: int
    members: list[PBTMemberState]
    generations: list[dict[str, Any]]
    rng_state: dict[str, Any]
    np_state: Any
    torch_state: Any


def save_pbt_checkpoint(
    path: Path,
    *,
    run_id: str,
    seed: int,
    gen: int,
    members: list[PBTMember],
    rng: Any,
    generations: list[dict[str, Any]],
) -> None:  # pragma: no cover - torch
    """Atomically persist the run's resumable state (population weights + RNG + telemetry timeline)."""
    import copy

    import numpy as np
    import torch

    states = [
        PBTMemberState(
            agent_id=m.agent_id,
            hyperparams=m.hyperparams,
            state_dict=copy.deepcopy(m.model.state_dict()),
            normalizer=copy.deepcopy(m.normalizer),
        )
        for m in members
    ]
    ckpt = PBTCheckpoint(
        run_id=run_id, seed=seed, gen=gen, population_size=len(members),
        members=states, generations=list(generations),
        rng_state=rng.bit_generator.state,
        np_state=np.random.get_state(), torch_state=torch.get_rng_state(),
    )
    save_torch(path, ckpt)


def load_pbt_checkpoint(path: Path, *, device: Any = None) -> PBTCheckpoint:  # pragma: no cover - torch
    """Load a PBT checkpoint, mapping its weight tensors onto ``device``."""
    ckpt = load_torch(path, map_location=device)
    assert isinstance(ckpt, PBTCheckpoint)
    return ckpt


def _rebuild_member(
    state: PBTMemberState, cfg: PBTConfig, base: MarketTrainConfig, *, device: Any = None
) -> PBTMember:  # pragma: no cover - torch
    """Rebuild a live :class:`PBTMember` (fresh net + trainer) from a checkpoint's member state."""
    member = _init_member(state.agent_id, state.hyperparams, cfg, base, device=device)
    member.model.load_state_dict(state.state_dict)
    member.normalizer = state.normalizer
    return member


# ---------------------------------------------------------------------------
# Training + evaluation (torch-gated)
# ---------------------------------------------------------------------------


def _init_member(
    agent_id: str, hyperparams: Hyperparams, cfg: PBTConfig, base: MarketTrainConfig,
    *, device: Any = None,
) -> PBTMember:  # pragma: no cover - torch
    from oct_trading_agent.agent.online import PPOTrainer
    from oct_trading_agent.agent.online.normalize import RunningNormalizer
    from oct_trading_agent.agent.policies.torch_actor import ActorConfig, build_actor_critic

    model = build_actor_critic(
        ActorConfig(hidden_dim=cfg.hidden_dim, n_quantiles=cfg.n_quantiles, cvar_alpha=cfg.cvar_alpha),
        device=device,
    )
    trainer = PPOTrainer(model, _ppo_config(hyperparams, base, cfg))
    return PBTMember(
        agent_id=agent_id,
        hyperparams=hyperparams,
        model=model,
        normalizer=RunningNormalizer(),
        trainer=trainer,
    )


def _ppo_config(hyperparams: Hyperparams, base: MarketTrainConfig, cfg: PBTConfig) -> Any:
    from oct_trading_agent.agent.online import PPOConfig

    return PPOConfig(
        learning_rate=hyperparams.learning_rate,
        entropy_coef=hyperparams.entropy_coef,
        gamma=base.gamma,
        gae_lambda=base.gae_lambda,
        risk_beta=hyperparams.risk_beta,
        cvar_alpha=cfg.cvar_alpha,
    )


def _train_member(
    member: PBTMember, train_envs: list[Any], cfg: PBTConfig
) -> None:  # pragma: no cover - torch
    """Train one member for a short interval: ``train_steps_per_gen`` PPO iters on the market envs."""
    from oct_trading_agent.agent.online import RolloutBuffer, collect_rollouts

    base_ppo = member.trainer.config
    for _ in range(max(1, cfg.train_steps_per_gen)):
        buffer = RolloutBuffer(gamma=base_ppo.gamma, lam=base_ppo.gae_lambda)
        for _ in range(max(1, cfg.episodes_per_iter)):
            collect_rollouts(
                member.model, train_envs, member.normalizer, buffer,
                update_normalizer=True,
                risk_beta=member.hyperparams.risk_beta, cvar_alpha=cfg.cvar_alpha,
            )
        member.trainer.update(buffer.compute())


def _evaluate_member(
    member: PBTMember, test_envs: list[Any]
) -> Any:  # pragma: no cover - torch
    """Profile a member on the held-out envs: fitness (pnl_bps) + behavioral descriptor."""
    from oct_trading_agent.agent.policies import TorchPolicy

    policy = TorchPolicy(member.model, normalizer=member.normalizer, deterministic=True)
    return profile_policy(test_envs, policy)


def apply_exploit(
    members: list[PBTMember], pairs: list[tuple[int, int]], rng: Any,
    base: MarketTrainConfig, cfg: PBTConfig,
) -> None:  # pragma: no cover - torch
    """EXPLOIT + EXPLORE: each loser copies its winner's weights & hyperparams, then perturbs them.

    The winner's model weights and observation-normalizer state are DEEP-COPIED into the loser (so the
    two slots evolve independently afterwards), the loser inherits the winner's hyperparameters, and
    those are perturbed (explore). The optimizer is rebuilt so the new learning rate takes effect.
    """
    import copy

    from oct_trading_agent.agent.online import PPOTrainer

    for loser, winner in pairs:
        src, dst = members[winner], members[loser]
        dst.model.load_state_dict(copy.deepcopy(src.model.state_dict()))
        dst.normalizer = copy.deepcopy(src.normalizer)
        dst.hyperparams = src.hyperparams.perturb(rng)
        dst.trainer = PPOTrainer(dst.model, _ppo_config(dst.hyperparams, base, cfg))


# ---------------------------------------------------------------------------
# The PBT loop
# ---------------------------------------------------------------------------


def _bounded(prepared: list[PreparedMarket], limit: int) -> list[PreparedMarket]:
    return prepared[: max(1, limit)] if prepared else prepared


def run_pbt(
    wf: MarketWalkForward,
    out_path: Path,
    *,
    cfg: PBTConfig | None = None,
    base: MarketTrainConfig | None = None,
    seed: int = 0,
    run_id: str | None = None,
    device: Any = None,
    checkpoint_path: Path | None = None,
    checkpoint_every: int = 0,
    resume: Path | None = None,
    log: Callable[[str], None] = print,
) -> dict[str, Any]:  # pragma: no cover - torch/integration
    """Run PBT over the held-out-tokens split; emit the growing desk telemetry; return the document.

    Builds the train/eval envs ONCE (bounded to a small subset for the first pass), initializes the
    population with perturbed hyperparameters, and for each generation trains → evaluates → writes
    telemetry → exploit/explore. Requires the ``learn`` extra (it trains).

    Overnight-survival: with ``checkpoint_every > 0`` the full resumable state (post-exploit population +
    RNG + telemetry timeline) is written atomically every ``checkpoint_every`` generations to
    ``checkpoint_path`` (default ``<out>.ckpt.pt``). ``resume`` restores such a checkpoint and continues
    from the next generation, so a killed run loses at most ``checkpoint_every`` generations.
    """
    import numpy as np
    import torch

    config = cfg or PBTConfig()
    base_cfg = base or MarketTrainConfig(hidden_dim=config.hidden_dim)
    torch.set_num_threads(max(1, config.torch_threads))

    state = load_pbt_checkpoint(resume, device=device) if resume is not None else None
    if state is not None:
        run_id = state.run_id
        seed = state.seed
        rng = np.random.default_rng(seed)
        rng.bit_generator.state = state.rng_state
        np.random.set_state(state.np_state)
        torch.set_rng_state(state.torch_state.cpu())
        writer = DeskTelemetryWriter(out_path, run_id=run_id, generations=state.generations)
        members = [_rebuild_member(s, config, base_cfg, device=device) for s in state.members]
        gen_start = state.gen
    else:
        torch.manual_seed(seed)
        np.random.seed(seed)
        rng = np.random.default_rng(seed)
        run_id = run_id or f"pbt-{datetime.now(UTC):%Y-%m-%d}-seed{seed}"
        writer = DeskTelemetryWriter(out_path, run_id=run_id)
        members = [
            _init_member(f"a{i:03d}", Hyperparams.sample(rng), config, base_cfg, device=device)
            for i in range(config.population_size)
        ]
        gen_start = 0

    ckpt_path = checkpoint_path or out_path.with_name(out_path.stem + ".ckpt.pt")
    every = max(0, checkpoint_every)

    train_prepared = _bounded(wf.train, config.max_train_envs)
    test_prepared = _bounded(wf.test or wf.train, config.max_test_envs)
    train_envs = [wf.env(p, base_cfg, seed=seed) for p in train_prepared]
    test_envs = [wf.env(p, base_cfg, seed=seed + 1) for p in test_prepared]
    if not train_envs or not test_envs:
        raise ValueError("PBT needs at least one train and one eval env (dataset too small)")
    resumed = " RESUMED" if state is not None else ""
    log(
        f"[pbt]{resumed} population={config.population_size} generations={config.generations} "
        f"train_envs={len(train_envs)} test_envs={len(test_envs)} run_id={run_id} "
        f"gen_start={gen_start} checkpoint_every={every or 'off'}"
    )

    def _checkpoint(next_gen: int) -> None:
        save_pbt_checkpoint(
            ckpt_path, run_id=run_id, seed=seed, gen=next_gen, members=members, rng=rng,
            generations=writer.generations,
        )
        log(f"[pbt] checkpoint @ gen {next_gen} -> {ckpt_path}")

    batch = max(1, config.eval_batch_size)
    for gen in range(gen_start, config.generations):
        # Train + evaluate members in MINI-BATCHES, binning each batch into the niche archive and then
        # dropping it — only the archive (per-niche champion/occupancy) and the light fitness floats
        # persist, so the resident set is one mini-batch, not the whole population (archive scales).
        archive = NicheArchive()
        fitnesses: list[float] = []
        for start in range(0, len(members), batch):
            chunk = members[start : start + batch]
            for member in chunk:
                _train_member(member, train_envs, config)
            profiles = [_evaluate_member(member, test_envs) for member in chunk]
            archive.add_batch(
                AgentReport(agent_id=f"g{gen:02d}{m.agent_id}", profile=p)
                for m, p in zip(chunk, profiles, strict=True)
            )
            fitnesses.extend(p.pnl_bps for p in profiles)
        summary = writer.add_generation(archive, gen=gen, population_size=len(members))
        log(
            f"[pbt] gen {gen}: best={summary['best_pnl_bps']:+.1f}bps "
            f"mean={summary['mean_pnl_bps']:+.1f}bps coverage={summary['coverage']:.2f} "
            f"filled={[d['role'] for d in summary['desks'] if d['occupancy'] > 0]}"
        )
        if gen < config.generations - 1:
            pairs = select_exploit_explore(fitnesses, rng, exploit_frac=config.exploit_frac)
            apply_exploit(members, pairs, rng, base_cfg, config)
            log(f"[pbt] gen {gen}: exploit/explore reseeded {len(pairs)} member(s)")
        # Checkpoint AFTER exploit: the saved population is the one the next generation would start from.
        if every > 0 and (gen + 1) % every == 0:
            _checkpoint(gen + 1)

    if every > 0:  # a final checkpoint marks the completed run so a resume is a clean no-op
        _checkpoint(config.generations)
    log(f"[pbt] wrote telemetry -> {out_path}")
    return writer.document()


# ---------------------------------------------------------------------------
# Data loading + CLI
# ---------------------------------------------------------------------------


def _load_tapes(args: argparse.Namespace) -> list[TokenTape]:  # pragma: no cover - IO
    from oct_trading_agent.data.dataset import MarketSwapDataset

    protocols = tuple(p.strip() for p in args.protocols.split(",") if p.strip())
    dataset = MarketSwapDataset(Path(args.dataset))
    return dataset.load_token_tapes(
        max_tokens=args.tokens, min_swaps=args.min_swaps, protocols=protocols
    )


def main() -> None:  # pragma: no cover - CLI
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=str, required=True, help="MarketSwapDataset root")
    parser.add_argument("--protocols", type=str, default="pumpfun_amm", help="comma-separated venues")
    parser.add_argument("--tokens", type=int, default=120, help="max tokens to load (bounds the run)")
    parser.add_argument("--min-swaps", type=int, default=24)
    parser.add_argument("--population", type=int, default=24)
    parser.add_argument("--generations", type=int, default=6)
    parser.add_argument("--train-steps-per-gen", type=int, default=3)
    parser.add_argument("--episodes-per-iter", type=int, default=1)
    parser.add_argument("--eval-batch-size", type=int, default=8, help="members per mini-batch")
    parser.add_argument("--max-train-envs", type=int, default=6)
    parser.add_argument("--max-test-envs", type=int, default=16)
    parser.add_argument("--hidden-dim", type=int, default=32)
    parser.add_argument("--exploit-frac", type=float, default=0.25)
    parser.add_argument("--torch-threads", type=int, default=2)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument(
        "--device", type=str, default="auto", choices=("auto", "cuda", "cpu"),
        help="compute device for the population nets (auto = cuda if available, else cpu)",
    )
    parser.add_argument(
        "--out", type=str, default=None,
        help="telemetry JSON path (default data/desk_telemetry/pbt-<date>-seed<seed>.json)",
    )
    parser.add_argument(
        "--checkpoint-every", type=int, default=0,
        help="atomically checkpoint the population+RNG every N generations (0 = off)",
    )
    parser.add_argument(
        "--checkpoint-path", type=str, default=None,
        help="checkpoint file to write (default <out>.ckpt.pt)",
    )
    parser.add_argument(
        "--resume", type=str, default=None,
        help="resume from a checkpoint file and continue from the next generation",
    )
    args = parser.parse_args()

    tapes = _load_tapes(args)
    print(f"[data] loaded {len(tapes)} token tape(s) from {args.dataset}")
    wf = build_market_walk_forward(tapes)
    print(f"[data] tradeable train={len(wf.train)} test={len(wf.test)} skipped={len(wf.skipped)}")

    out_path = (
        Path(args.out)
        if args.out
        else Path("data/desk_telemetry") / f"pbt-{datetime.now(UTC):%Y-%m-%d}-seed{args.seed}.json"
    )
    cfg = PBTConfig(
        population_size=args.population,
        generations=args.generations,
        train_steps_per_gen=args.train_steps_per_gen,
        episodes_per_iter=args.episodes_per_iter,
        eval_batch_size=args.eval_batch_size,
        exploit_frac=args.exploit_frac,
        max_train_envs=args.max_train_envs,
        max_test_envs=args.max_test_envs,
        hidden_dim=args.hidden_dim,
        torch_threads=args.torch_threads,
    )
    from oct_trading_agent.agent.device import resolve_device

    device = resolve_device(args.device)
    print(f"[device] requested={args.device!r} resolved={device}")
    run_pbt(
        wf, out_path, cfg=cfg, seed=args.seed, device=device,
        checkpoint_path=Path(args.checkpoint_path) if args.checkpoint_path else None,
        checkpoint_every=args.checkpoint_every,
        resume=Path(args.resume) if args.resume else None,
    )
    print(f"\n[pbt] DONE - telemetry at {out_path}")


if __name__ == "__main__":  # pragma: no cover
    main()


__all__ = [
    "LR_BOUNDS",
    "ENTROPY_BOUNDS",
    "RISK_BETA_BOUNDS",
    "Hyperparams",
    "select_exploit_explore",
    "PBTMember",
    "PBTConfig",
    "PBTMemberState",
    "PBTCheckpoint",
    "apply_exploit",
    "run_pbt",
    "save_pbt_checkpoint",
    "load_pbt_checkpoint",
]
