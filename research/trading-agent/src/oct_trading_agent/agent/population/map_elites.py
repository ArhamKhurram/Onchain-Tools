"""MAP-Elites — the quality-DIVERSITY trainer (paper §6.4; 02 §2 (4); 03-experiment-plan.md).

PBT (:mod:`.pbt`) proved the failure mode the whole program exists to avoid: it maximized fitness and
COLLAPSED diversity — the population piled into one niche as coverage fell generation over generation.
MAP-Elites is the fix. It is an ARCHIVE-centric algorithm: it maintains one **elite** (the best agent
seen) per behavioral niche and never lets a filled niche go empty, so coverage only ever GROWS. The
deliverable of the research program is exactly that archive — a diverse ensemble of individually
edge-positive archetypes, not one champion.

The loop, per the QD recipe:

  1. **Seed** the archive with a small random initial population, each evaluated on the held-out
     tokens, binned by its behavioral descriptor (:mod:`.descriptor`) into its niche.
  2. **Illuminate**: repeatedly sample a parent elite from the archive, MUTATE it (perturb its network
     weights with Gaussian noise and its hyperparameters), give the child a short PPO polish on the
     market envs, evaluate it on the held-out tokens, compute its descriptor → niche, and if it beats
     that niche's incumbent elite (or the niche is empty) it TAKES the cell (:func:`elite_beats`).
  3. Every ``batch_size`` evaluations, emit one desk-telemetry "generation" — a snapshot of the
     current archive — so the viz animates coverage growing and each niche's champion improving.

The descriptor → niche seam, the env/sim/eval substrate, the PPO update, the policy, and the telemetry
contract are reused VERBATIM from PBT so the two runs are directly comparable. The elite-replacement
RULE and the :class:`EliteArchive` container are pure and torch-free (the archive treats each elite's
network state as an opaque payload it never inspects), so they are unit-tested without the ``learn``
extra; mutation, training, and evaluation are torch-gated exactly as PBT is.

Run:
    uv run --extra learn python -m oct_trading_agent.agent.population.map_elites \\
        --dataset data/market_dataset --init-population 12 --iterations 48 \\
        --batch-size 8 --seed 0
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
from .descriptor import MEMECOIN_ROLES, BehaviorProfile, bin_descriptor, profile_policy
from .pbt import Hyperparams
from .telemetry import DeskTelemetryWriter

ALGO = "map_elites"


# ---------------------------------------------------------------------------
# Elite + the archive — pure, torch-free (network state is an opaque payload)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Elite:
    """One niche's incumbent: its id, its held-out profile (fitness + descriptor), and its genome.

    ``genome`` is the opaque, deep-copied network state a child is bred from — a
    :class:`EliteGenome` in a real (torch) run, ``None`` in the pure unit tests. The archive NEVER
    inspects it; only ``profile.pnl_bps`` (and, for binning, ``profile.descriptor``) drive placement,
    which is what keeps the container torch-free and O(niches).
    """

    agent_id: str
    profile: BehaviorProfile
    genome: Any = None


def elite_beats(challenger: BehaviorProfile, incumbent: BehaviorProfile | None) -> bool:
    """The MAP-Elites cell-replacement rule (pure): does ``challenger`` take the niche?

    A challenger claims a cell iff the cell is EMPTY (``incumbent is None``) or its held-out
    ``pnl_bps`` STRICTLY exceeds the incumbent's. Strict ``>`` means an equal-fitness child does not
    churn a filled cell — once a niche is filled it stays filled and only ever improves, the exact
    monotonicity PBT lacked.
    """
    return incumbent is None or challenger.pnl_bps > incumbent.pnl_bps


class EliteArchive:
    """The MAP-Elites archive: at most one :class:`Elite` per behavioral niche.

    A challenger is binned by its own descriptor into exactly one role (the same seam PBT uses) and
    admitted by :func:`elite_beats`. The archive holds only the current elite per role, so its
    footprint is O(niches) no matter how many children are evaluated — the whole search history is
    never resident. Sampling a parent draws uniformly from the filled niches. Rendering telemetry bins
    the current elites into a fresh :class:`NicheArchive`, so the viz contract is reused unchanged.
    """

    def __init__(self, roles: tuple[str, ...] = MEMECOIN_ROLES) -> None:
        self._roles = tuple(roles)
        self._elites: dict[str, Elite] = {}
        self._considered = 0
        self._admitted = 0

    @classmethod
    def restore(
        cls,
        elites: list[Elite],
        *,
        considered: int,
        admitted: int,
        roles: tuple[str, ...] = MEMECOIN_ROLES,
    ) -> EliteArchive:
        """Rebuild an archive from a checkpoint's elites + counters (the exact inverse of what is saved).

        Each stored elite re-bins to its own niche (it was the incumbent there), and the search counters
        are restored verbatim so the resumed run's admitted/considered accounting continues unbroken. Pure
        and torch-free — the genome payload is placed back untouched, exactly as the archive keeps it.
        """
        archive = cls(roles)
        for elite in elites:
            archive._elites[bin_descriptor(elite.profile.descriptor)] = elite
        archive._considered = considered
        archive._admitted = admitted
        return archive

    @property
    def roles(self) -> tuple[str, ...]:
        return self._roles

    def try_add(self, elite: Elite) -> tuple[str, bool]:
        """Bin ``elite`` into its niche and admit it if it beats the incumbent. Returns (role, took_cell)."""
        role = bin_descriptor(elite.profile.descriptor)
        self._considered += 1
        incumbent = self._elites.get(role)
        if elite_beats(elite.profile, incumbent.profile if incumbent is not None else None):
            self._elites[role] = elite
            self._admitted += 1
            return role, True
        return role, False

    def get(self, role: str) -> Elite | None:
        return self._elites.get(role)

    def is_filled(self, role: str) -> bool:
        return role in self._elites

    def filled_roles(self) -> list[str]:
        return [r for r in self._roles if r in self._elites]

    def elites(self) -> list[Elite]:
        return [self._elites[r] for r in self._roles if r in self._elites]

    @property
    def size(self) -> int:
        """Number of filled niches (the archive's live population)."""
        return len(self._elites)

    @property
    def coverage(self) -> float:
        return len(self._elites) / len(self._roles)

    @property
    def considered(self) -> int:
        return self._considered

    @property
    def admitted(self) -> int:
        return self._admitted

    def sample_parent(self, rng: Any) -> Elite | None:
        """Draw a random parent uniformly from the filled niches (``None`` if the archive is empty)."""
        filled = self.filled_roles()
        if not filled:
            return None
        return self._elites[str(rng.choice(filled))]

    def to_niche_archive(self) -> NicheArchive:
        """Snapshot the current elites into a fresh :class:`NicheArchive` for telemetry rendering.

        Each elite re-bins to its own niche (occupancy 1, itself the champion), so the rendered
        generation shows exactly the archive state: coverage = filled/6 and each cell's champion the
        best genome bred into it so far.
        """
        archive = NicheArchive(self._roles)
        archive.add_batch(
            AgentReport(agent_id=e.agent_id, profile=e.profile) for e in self.elites()
        )
        return archive


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MapElitesConfig:
    """MAP-Elites run budget — deliberately modest (a diversity signal, comparable to the PBT pass)."""

    init_population: int = 24  # random genomes seeding the archive (evaluated as "generation 0")
    iterations: int = 96  # child evaluations AFTER the seed (illumination steps)
    batch_size: int = 8  # evaluations per reported telemetry generation
    train_steps_per_child: int = 1  # short PPO polish after mutation (0 = pure evolutionary)
    episodes_per_iter: int = 1
    mutation_sigma: float = 0.05  # Gaussian weight-perturbation scale (the diversity injection)
    exploit_frac: float = 0.0  # unused (kept for signature parity with PBTConfig readers)
    max_train_envs: int = 6
    max_test_envs: int = 16
    hidden_dim: int = 32
    n_quantiles: int = 8
    cvar_alpha: float = 0.05
    torch_threads: int = 2  # be polite: a CPU-heavy ladder run may share this machine


# ---------------------------------------------------------------------------
# Checkpointing — atomic, resumable archive + RNG + telemetry timeline
# ---------------------------------------------------------------------------


@dataclass
class MapElitesCheckpoint:
    """The full resumable state of a MAP-Elites run: the archive, the loop counters, and the RNG.

    Saved atomically every ``checkpoint_every`` evaluations. ``elites`` carries each filled niche's
    incumbent (id + held-out profile + genome weights); ``generations`` is the desk-telemetry timeline, so
    a resume continues the growing viz JSON instead of restarting it; the three RNG snapshots let the
    continued search reproduce the run that would have happened without the interruption. ``seed_done`` /
    ``iter_done`` record how far into the seed and illumination phases the killed run got.
    """

    run_id: str
    seed: int
    gen: int
    n_eval: int
    seed_done: int
    iter_done: int
    considered: int
    admitted: int
    elites: list[Elite]
    generations: list[dict[str, Any]]
    rng_state: dict[str, Any]
    np_state: Any
    torch_state: Any


def save_map_elites_checkpoint(
    path: Path,
    *,
    run_id: str,
    seed: int,
    gen: int,
    n_eval: int,
    seed_done: int,
    iter_done: int,
    archive: EliteArchive,
    rng: Any,
    generations: list[dict[str, Any]],
) -> None:  # pragma: no cover - torch
    """Atomically persist the run's resumable state (archive + counters + RNG + telemetry timeline)."""
    import numpy as np
    import torch

    ckpt = MapElitesCheckpoint(
        run_id=run_id, seed=seed, gen=gen, n_eval=n_eval,
        seed_done=seed_done, iter_done=iter_done,
        considered=archive.considered, admitted=archive.admitted,
        elites=archive.elites(), generations=list(generations),
        rng_state=rng.bit_generator.state,
        np_state=np.random.get_state(), torch_state=torch.get_rng_state(),
    )
    save_torch(path, ckpt)


def load_map_elites_checkpoint(
    path: Path, *, device: Any = None
) -> MapElitesCheckpoint:  # pragma: no cover - torch
    """Load a MAP-Elites checkpoint, mapping its genome tensors onto ``device``."""
    ckpt = load_torch(path, map_location=device)
    assert isinstance(ckpt, MapElitesCheckpoint)
    return ckpt


# ---------------------------------------------------------------------------
# Genome + mutation/eval (torch-gated)
# ---------------------------------------------------------------------------


@dataclass
class EliteGenome:
    """A breedable network state: the actor-critic weights, the obs-normalizer, and hyperparameters.

    Held as the opaque ``Elite.genome`` payload. Deep-copied on birth and on admission so parent and
    child evolve independently; the archive itself never touches these fields (torch stays out of it).
    """

    state_dict: Any  # model.state_dict() (deep-copied)
    normalizer: Any  # RunningNormalizer (deep-copied)
    hyperparams: Hyperparams


def _build_model(cfg: MapElitesConfig, *, device: Any = None) -> Any:  # pragma: no cover - torch
    from oct_trading_agent.agent.policies.torch_actor import ActorConfig, build_actor_critic

    return build_actor_critic(
        ActorConfig(hidden_dim=cfg.hidden_dim, n_quantiles=cfg.n_quantiles, cvar_alpha=cfg.cvar_alpha),
        device=device,
    )


def _ppo_config(
    hyperparams: Hyperparams, base: MarketTrainConfig, cfg: MapElitesConfig
) -> Any:  # pragma: no cover - torch
    """Build the PPO config for one child from its hyperparameters (mirrors PBT's mapping)."""
    from oct_trading_agent.agent.online import PPOConfig

    return PPOConfig(
        learning_rate=hyperparams.learning_rate,
        entropy_coef=hyperparams.entropy_coef,
        gamma=base.gamma,
        gae_lambda=base.gae_lambda,
        risk_beta=hyperparams.risk_beta,
        cvar_alpha=cfg.cvar_alpha,
    )


def _random_genome(
    hyperparams: Hyperparams, cfg: MapElitesConfig, *, device: Any = None
) -> EliteGenome:  # pragma: no cover - torch
    """A fresh, randomly initialized genome — one seed member of the initial population."""
    import copy

    from oct_trading_agent.agent.online.normalize import RunningNormalizer

    model = _build_model(cfg, device=device)
    return EliteGenome(
        state_dict=copy.deepcopy(model.state_dict()),
        normalizer=RunningNormalizer(),
        hyperparams=hyperparams,
    )


def mutate_genome(
    parent: EliteGenome, rng: Any, cfg: MapElitesConfig
) -> EliteGenome:  # pragma: no cover - torch
    """Breed a child: Gaussian-perturb every weight tensor and perturb the hyperparameters.

    The weight perturbation (``N(0, mutation_sigma)`` added to each float parameter) is the diversity
    injection that pushes the child toward a possibly-different behavioral niche; the hyperparameter
    perturbation reuses PBT's explore step. The parent's normalizer state is inherited (deep-copied) so
    the child starts from a sane observation scale. Returns a NEW genome; the parent is untouched.
    """
    import copy

    import torch

    child_state = copy.deepcopy(parent.state_dict)
    with torch.no_grad():
        for tensor in child_state.values():
            if torch.is_floating_point(tensor):
                tensor.add_(torch.randn_like(tensor) * cfg.mutation_sigma)
    return EliteGenome(
        state_dict=child_state,
        normalizer=copy.deepcopy(parent.normalizer),
        hyperparams=parent.hyperparams.perturb(rng),
    )


def _polish_and_evaluate(
    genome: EliteGenome,
    train_envs: list[Any],
    test_envs: list[Any],
    base: MarketTrainConfig,
    cfg: MapElitesConfig,
    *,
    device: Any = None,
) -> tuple[BehaviorProfile, EliteGenome]:  # pragma: no cover - torch
    """Give a genome a short PPO polish on the train envs, then profile it on the held-out envs.

    Returns the held-out :class:`BehaviorProfile` (fitness + descriptor) and the genome as it stands
    AFTER polishing (its post-training weights/normalizer), so the elite stored in a cell is exactly
    the agent that earned the fitness — the same train-then-eval discipline PBT and the ladder use.
    """
    import copy

    from oct_trading_agent.agent.online import PPOTrainer, RolloutBuffer, collect_rollouts
    from oct_trading_agent.agent.policies import TorchPolicy

    model = _build_model(cfg, device=device)
    model.load_state_dict(copy.deepcopy(genome.state_dict))
    normalizer = copy.deepcopy(genome.normalizer)
    trainer = PPOTrainer(model, _ppo_config(genome.hyperparams, base, cfg))

    for _ in range(max(0, cfg.train_steps_per_child)):
        buffer = RolloutBuffer(gamma=base.gamma, lam=base.gae_lambda)
        for _ in range(max(1, cfg.episodes_per_iter)):
            collect_rollouts(
                model, train_envs, normalizer, buffer,
                update_normalizer=True,
                risk_beta=genome.hyperparams.risk_beta, cvar_alpha=cfg.cvar_alpha,
            )
        trainer.update(buffer.compute())

    policy = TorchPolicy(model, normalizer=normalizer, deterministic=True)
    profile = profile_policy(test_envs, policy)
    polished = EliteGenome(
        state_dict=copy.deepcopy(model.state_dict()),
        normalizer=copy.deepcopy(normalizer),
        hyperparams=genome.hyperparams,
    )
    return profile, polished


# ---------------------------------------------------------------------------
# The MAP-Elites loop
# ---------------------------------------------------------------------------


def _bounded(prepared: list[PreparedMarket], limit: int) -> list[PreparedMarket]:
    return prepared[: max(1, limit)] if prepared else prepared


def run_map_elites(
    wf: MarketWalkForward,
    out_path: Path,
    *,
    cfg: MapElitesConfig | None = None,
    base: MarketTrainConfig | None = None,
    seed: int = 0,
    run_id: str | None = None,
    device: Any = None,
    checkpoint_path: Path | None = None,
    checkpoint_every: int = 0,
    resume: Path | None = None,
    log: Callable[[str], None] = print,
) -> dict[str, Any]:  # pragma: no cover - torch/integration
    """Run MAP-Elites over the held-out-tokens split; emit the GROWING desk telemetry; return the doc.

    Seeds the archive with ``init_population`` random genomes (telemetry generation 0), then runs
    ``iterations`` illumination steps — sample parent → mutate → polish → evaluate → try to take a cell
    — flushing one telemetry generation per ``batch_size`` evaluations. Requires the ``learn`` extra.

    Overnight-survival: with ``checkpoint_every > 0`` the full resumable state (archive + RNG + telemetry
    timeline + loop counters) is written atomically every ``checkpoint_every`` evaluations to
    ``checkpoint_path`` (default ``<out>.ckpt.pt``). ``resume`` restores such a checkpoint and continues
    from the exact seed/illumination step it stopped at, so a killed run loses at most ``checkpoint_every``
    evaluations rather than the whole run.
    """
    import numpy as np
    import torch

    config = cfg or MapElitesConfig()
    base_cfg = base or MarketTrainConfig(hidden_dim=config.hidden_dim)
    torch.set_num_threads(max(1, config.torch_threads))

    state = load_map_elites_checkpoint(resume, device=device) if resume is not None else None
    if state is not None:
        run_id = state.run_id
        seed = state.seed
        rng = np.random.default_rng(seed)
        rng.bit_generator.state = state.rng_state
        np.random.set_state(state.np_state)
        torch.set_rng_state(state.torch_state.cpu())
        archive = EliteArchive.restore(
            state.elites, considered=state.considered, admitted=state.admitted
        )
        writer = DeskTelemetryWriter(
            out_path, run_id=run_id, algo=ALGO, generations=state.generations
        )
        gen, n_eval, seed_done, iter_done = state.gen, state.n_eval, state.seed_done, state.iter_done
    else:
        torch.manual_seed(seed)
        np.random.seed(seed)
        rng = np.random.default_rng(seed)
        run_id = run_id or f"mapelites-{datetime.now(UTC):%Y-%m-%d}-seed{seed}"
        writer = DeskTelemetryWriter(out_path, run_id=run_id, algo=ALGO)
        archive = EliteArchive()
        gen = n_eval = seed_done = iter_done = 0

    ckpt_path = checkpoint_path or out_path.with_name(out_path.stem + ".ckpt.pt")
    every = max(0, checkpoint_every)

    train_prepared = _bounded(wf.train, config.max_train_envs)
    test_prepared = _bounded(wf.test or wf.train, config.max_test_envs)
    train_envs = [wf.env(p, base_cfg, seed=seed) for p in train_prepared]
    test_envs = [wf.env(p, base_cfg, seed=seed + 1) for p in test_prepared]
    if not train_envs or not test_envs:
        raise ValueError("MAP-Elites needs at least one train and one eval env (dataset too small)")
    resumed = " RESUMED" if state is not None else ""
    log(
        f"[mapelites]{resumed} init_population={config.init_population} iterations={config.iterations} "
        f"batch_size={config.batch_size} train_envs={len(train_envs)} test_envs={len(test_envs)} "
        f"run_id={run_id} seed_done={seed_done} iter_done={iter_done} "
        f"checkpoint_every={every or 'off'}"
    )

    def _flush(g: int) -> None:
        snap = archive.to_niche_archive()
        summary = writer.add_generation(snap, gen=g, population_size=archive.size)
        log(
            f"[mapelites] gen {g}: coverage={summary['coverage']:.2f} "
            f"best={summary['best_pnl_bps']:+.1f}bps size={archive.size}/6 "
            f"admitted={archive.admitted}/{archive.considered} "
            f"filled={[d['role'] for d in summary['desks'] if d['occupancy'] > 0]}"
        )

    def _checkpoint() -> None:
        save_map_elites_checkpoint(
            ckpt_path, run_id=run_id, seed=seed, gen=gen, n_eval=n_eval,
            seed_done=seed_done, iter_done=iter_done, archive=archive, rng=rng,
            generations=writer.generations,
        )
        log(f"[mapelites] checkpoint @ eval {n_eval} -> {ckpt_path}")

    # --- Generation 0: seed the archive with a random initial population -------------------------
    for i in range(seed_done, max(1, config.init_population)):
        genome = _random_genome(Hyperparams.sample(rng), config, device=device)
        profile, polished = _polish_and_evaluate(
            genome, train_envs, test_envs, base_cfg, config, device=device
        )
        n_eval += 1
        seed_done = i + 1
        archive.try_add(Elite(agent_id=f"seed{i:03d}", profile=profile, genome=polished))
        if every > 0 and n_eval % every == 0:
            _checkpoint()
    if not writer.generations:  # gen 0 not yet flushed (fresh run, or resume before the seed flush)
        _flush(gen)

    # --- Illumination: sample → mutate → polish → evaluate → try to take a cell ------------------
    for step in range(iter_done, max(0, config.iterations)):
        parent = archive.sample_parent(rng)
        if parent is None or parent.genome is None:
            child_genome = _random_genome(Hyperparams.sample(rng), config, device=device)
        else:
            child_genome = mutate_genome(parent.genome, rng, config)
        profile, polished = _polish_and_evaluate(
            child_genome, train_envs, test_envs, base_cfg, config, device=device
        )
        n_eval += 1
        iter_done = step + 1
        archive.try_add(Elite(agent_id=f"c{step:04d}", profile=profile, genome=polished))
        # Flush a telemetry generation on each full batch, and once more on the final step so the
        # trailing partial batch is never lost (behaviour-preserving vs the old post-loop flush).
        if n_eval % max(1, config.batch_size) == 0 or step == config.iterations - 1:
            gen += 1
            _flush(gen)
        if every > 0 and n_eval % every == 0:
            _checkpoint()

    if every > 0:  # a final checkpoint marks the completed run so a resume is a clean no-op
        _checkpoint()
    log(f"[mapelites] wrote telemetry -> {out_path}")
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
    parser.add_argument("--init-population", type=int, default=24, help="random genomes seeding gen 0")
    parser.add_argument("--iterations", type=int, default=96, help="child evaluations after the seed")
    parser.add_argument("--batch-size", type=int, default=8, help="evaluations per telemetry generation")
    parser.add_argument("--train-steps-per-child", type=int, default=1)
    parser.add_argument("--episodes-per-iter", type=int, default=1)
    parser.add_argument("--mutation-sigma", type=float, default=0.05)
    parser.add_argument("--max-train-envs", type=int, default=6)
    parser.add_argument("--max-test-envs", type=int, default=16)
    parser.add_argument("--hidden-dim", type=int, default=32)
    parser.add_argument("--torch-threads", type=int, default=2)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument(
        "--device", type=str, default="auto", choices=("auto", "cuda", "cpu"),
        help="compute device for the genome nets (auto = cuda if available, else cpu)",
    )
    parser.add_argument(
        "--out", type=str, default=None,
        help="telemetry JSON path (default data/desk_telemetry/mapelites-<date>-seed<seed>.json)",
    )
    parser.add_argument(
        "--checkpoint-every", type=int, default=0,
        help="atomically checkpoint the archive+RNG every N evaluations (0 = off)",
    )
    parser.add_argument(
        "--checkpoint-path", type=str, default=None,
        help="checkpoint file to write (default <out>.ckpt.pt)",
    )
    parser.add_argument(
        "--resume", type=str, default=None,
        help="resume from a checkpoint file and continue the run from where it stopped",
    )
    args = parser.parse_args()

    tapes = _load_tapes(args)
    print(f"[data] loaded {len(tapes)} token tape(s) from {args.dataset}")
    wf = build_market_walk_forward(tapes)
    print(f"[data] tradeable train={len(wf.train)} test={len(wf.test)} skipped={len(wf.skipped)}")

    out_path = (
        Path(args.out)
        if args.out
        else Path("data/desk_telemetry") / f"mapelites-{datetime.now(UTC):%Y-%m-%d}-seed{args.seed}.json"
    )
    cfg = MapElitesConfig(
        init_population=args.init_population,
        iterations=args.iterations,
        batch_size=args.batch_size,
        train_steps_per_child=args.train_steps_per_child,
        episodes_per_iter=args.episodes_per_iter,
        mutation_sigma=args.mutation_sigma,
        max_train_envs=args.max_train_envs,
        max_test_envs=args.max_test_envs,
        hidden_dim=args.hidden_dim,
        torch_threads=args.torch_threads,
    )
    from oct_trading_agent.agent.device import resolve_device

    device = resolve_device(args.device)
    print(f"[device] requested={args.device!r} resolved={device}")
    run_map_elites(
        wf, out_path, cfg=cfg, seed=args.seed, device=device,
        checkpoint_path=Path(args.checkpoint_path) if args.checkpoint_path else None,
        checkpoint_every=args.checkpoint_every,
        resume=Path(args.resume) if args.resume else None,
    )
    print(f"\n[mapelites] DONE - telemetry at {out_path}")


if __name__ == "__main__":  # pragma: no cover
    main()


__all__ = [
    "ALGO",
    "Elite",
    "EliteGenome",
    "EliteArchive",
    "MapElitesConfig",
    "MapElitesCheckpoint",
    "elite_beats",
    "mutate_genome",
    "run_map_elites",
    "save_map_elites_checkpoint",
    "load_map_elites_checkpoint",
]
