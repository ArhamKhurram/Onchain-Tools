"""End-to-end benchmark of the rollout vectorization on the REAL ladder path.

The claim under test is not "batched forwards are faster than batch-of-1 forwards" — that is a
microbenchmark and was already measured on scripted envs. The claim that matters to the operator is
*how much wall clock one PPO iteration of the actual rung-1000 ladder loses to collection*, and that
number is only knowable on the real substrate: the real dataset, the real
:class:`MarketReplayEnv` fills, the real net, and the real per-iteration episode budget.

So this script reuses ``train_market``'s own helpers (``build_market_walk_forward`` →
``MarketWalkForward.train_envs``) rather than re-deriving env construction, times
``collect_rollouts`` with ``vectorized=True`` against ``vectorized=False`` on the SAME env objects,
and separates three costs that the extrapolation needs kept apart:

* **collect** — what the rewrite touches.
* **env.step alone** (``--floor``) — the irreducible remainder. Vectorizing cannot go below it, so it
  is what turns a raw speedup into an honest Amdahl ceiling for the whole iteration.
* **PPO update** — measured once per configuration; it is per-*batch*, not per-env-step, so it does
  not shrink when collection does and must be added back before quoting an iteration time.

Loading the tapes decodes ~1.3M raw swap rows through pydantic, so the decoded slice is pickled to
``--tape-cache`` and reused across invocations; the cache key is the dataset + protocols + min-swaps
+ token cap, and a mismatch re-decodes rather than silently benchmarking the wrong slice.

Run (from the agent root):
    ./.venv/Scripts/python.exe scripts/bench_rollout_vectorization.py \
        --dataset data/market_dataset_snap800 --protocols pumpfun --min-swaps 16 \
        --rung 1000 --envs 50,200 --devices cpu,cuda
"""

from __future__ import annotations

import argparse
import json
import pickle
import platform
import statistics
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

AGENT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(AGENT_ROOT / "src"))

from oct_trading_agent.agent.envs import TradingEnv, action_from_array  # noqa: E402
from oct_trading_agent.agent.train_market import (  # noqa: E402
    MarketTrainConfig,
    MarketWalkForward,
    build_market_walk_forward,
)
from oct_trading_agent.eval.data import TokenTape  # noqa: E402

# ---------------------------------------------------------------------------
# Tape loading (cached — decoding the snapshot is minutes, the benchmark is not)
# ---------------------------------------------------------------------------


def load_tapes(
    dataset: str, *, protocols: tuple[str, ...], min_swaps: int, max_tokens: int, cache: Path | None
) -> list[TokenTape]:
    key = {
        "dataset": dataset,
        "protocols": list(protocols),
        "min_swaps": min_swaps,
        "max_tokens": max_tokens,
    }
    if cache is not None and cache.exists():
        with cache.open("rb") as fh:
            blob = pickle.load(fh)
        if blob.get("key") == key:
            print(f"[data] {len(blob['tapes'])} tape(s) restored from {cache}")
            return list(blob["tapes"])
        print(f"[data] cache at {cache} is for a different slice — re-decoding")

    from oct_trading_agent.data.dataset import MarketSwapDataset

    t0 = time.perf_counter()
    tapes = MarketSwapDataset(Path(dataset)).load_token_tapes(
        max_tokens=max_tokens, min_swaps=min_swaps, protocols=protocols
    )
    print(f"[data] decoded {len(tapes)} tape(s) from {dataset} in {time.perf_counter() - t0:.1f}s")
    if cache is not None:
        cache.parent.mkdir(parents=True, exist_ok=True)
        with cache.open("wb") as fh:
            pickle.dump({"key": key, "tapes": tapes}, fh, protocol=pickle.HIGHEST_PROTOCOL)
        print(f"[data] cached -> {cache}")
    return tapes


# ---------------------------------------------------------------------------
# One measurement
# ---------------------------------------------------------------------------


@dataclass
class Sample:
    """``repeats`` timed ``collect_rollouts`` calls, aggregated.

    Episode LENGTH is stochastic and differs between the two paths (batching consumes the RNG
    differently and interleaves the normalizer — see ``collect.py``'s docstring), so a raw wall-clock
    ratio can be flattered or penalised by a lucky draw. Both numbers are therefore kept: ``seconds``
    (mean wall clock, what the operator feels) and ``us_per_env_step`` (pooled over every repeat,
    the length-invariant number the extrapolation is built on).
    """

    device: str
    path: str  # "vectorized" | "sequential"
    n_envs: int
    repeats: int
    secs_total: float
    steps_total: int
    episodes_total: int

    @property
    def seconds(self) -> float:
        return self.secs_total / max(1, self.repeats)

    @property
    def n_steps(self) -> float:
        return self.steps_total / max(1, self.repeats)

    @property
    def steps_per_episode(self) -> float:
        return self.steps_total / max(1, self.episodes_total)

    @property
    def us_per_env_step(self) -> float:
        return self.secs_total * 1e6 / max(1, self.steps_total)


def _fresh_model(cfg: MarketTrainConfig, device: Any, seed: int, state: Any = None) -> Any:
    """Build the ladder's actual net on ``device``; optionally load trained weights into it.

    Episode LENGTH is policy-dependent — a random-init actor exits almost immediately, a trained one
    holds — and episode length is the denominator of every number here. So the honest comparison
    against the 27h baseline loads that run's own weights (``--warm-ladder``) rather than timing a
    freshly initialised net that walks much shorter episodes than the real job does.
    """
    import numpy as np
    import torch

    from oct_trading_agent.agent.envs import vector_length
    from oct_trading_agent.agent.policies.torch_actor import ActorConfig, build_actor_critic

    torch.manual_seed(seed)
    np.random.seed(seed)
    model = build_actor_critic(
        ActorConfig(
            hidden_dim=cfg.hidden_dim,
            n_quantiles=cfg.n_quantiles,
            cvar_alpha=cfg.cvar_alpha,
            d_in=vector_length(attention=cfg.attention_features),
        ),
        device=device,
    )
    if state is not None:
        model.load_state_dict(state)
    return model


def _load_warm(path: Path, device: Any) -> tuple[Any, Any]:
    """Read a ladder checkpoint (or a bare ``state_dict``) → ``(model_state, normalizer_or_None)``.

    The ladder is launched as ``python -m oct_trading_agent.agent.train_market``, so its dataclasses
    pickled as ``__main__.LadderCheckpoint`` / ``__main__.RungTrainState``. Unpickling them from a
    *different* ``__main__`` (this script) needs those names bound there first — hence the aliases.
    """
    import torch

    import __main__
    from oct_trading_agent.agent import train_market as _tm

    for name in ("LadderCheckpoint", "RungTrainState", "TrainedPolicy", "MarketTrainConfig"):
        if not hasattr(__main__, name):
            setattr(__main__, name, getattr(_tm, name))

    blob = torch.load(path, map_location=device, weights_only=False)
    state = getattr(blob, "warm_model_state", None)
    if state is not None:
        return state, getattr(blob, "warm_normalizer", None)
    return blob, None


def time_collect(
    model: Any,
    envs: list[TradingEnv],
    cfg: MarketTrainConfig,
    *,
    vectorized: bool,
    seed: int,
    normalizer_seed: Any = None,
) -> tuple[float, int, int]:
    """Time ONE ``collect_rollouts`` call (= one episode per env) on a fresh buffer.

    Both paths get an identical starting normalizer (a deep copy of ``normalizer_seed``, or a fresh
    one) — a normalizer carried over between timings would change the actions and therefore the
    episode lengths, silently moving the denominator the two paths are compared on.
    """
    import copy

    import numpy as np
    import torch

    from oct_trading_agent.agent.online import RolloutBuffer, collect_rollouts
    from oct_trading_agent.agent.online.normalize import RunningNormalizer

    torch.manual_seed(seed)
    np.random.seed(seed)
    buffer = RolloutBuffer(gamma=cfg.gamma, lam=cfg.gae_lambda)
    normalizer = copy.deepcopy(normalizer_seed) if normalizer_seed is not None else RunningNormalizer()

    if torch.cuda.is_available():
        torch.cuda.synchronize()
    t0 = time.perf_counter()
    collect_rollouts(
        model,
        envs,
        normalizer,
        buffer,
        update_normalizer=True,
        risk_beta=cfg.risk_beta,
        cvar_alpha=cfg.cvar_alpha,
        vectorized=vectorized,
    )
    if torch.cuda.is_available():
        torch.cuda.synchronize()
    return time.perf_counter() - t0, buffer.n_steps, buffer.n_episodes


def time_env_floor(envs: list[TradingEnv], *, n_steps_target: int) -> tuple[float, int]:
    """Time the env machinery ALONE — reset + step with a fixed action, no network in the loop.

    This is the floor the rewrite can never cross, and the term that decides whether the collection
    speedup survives into the iteration time or gets eaten by ``env.step``.
    """
    import numpy as np

    action = action_from_array(np.array([0, 0.0], dtype=np.float64))
    for env in envs:
        env.reset()
    t0 = time.perf_counter()
    done = [False] * len(envs)
    steps = 0
    while not all(done) and steps < 2000:
        for i, env in enumerate(envs):
            if done[i]:
                continue
            result = env.step(action)
            done[i] = bool(result.terminated or result.truncated)
        steps += 1
    elapsed = time.perf_counter() - t0
    return elapsed, n_steps_target


def time_ppo_update(
    model: Any, envs: list[TradingEnv], cfg: MarketTrainConfig, *, seed: int, normalizer_seed: Any = None
) -> tuple[float, int]:
    """Time one PPO update on a realistically sized batch (``episodes_per_iter`` collections)."""
    import copy

    import numpy as np
    import torch

    from oct_trading_agent.agent.online import (
        PPOConfig,
        PPOTrainer,
        RolloutBuffer,
        collect_rollouts,
    )
    from oct_trading_agent.agent.online.normalize import RunningNormalizer

    torch.manual_seed(seed)
    np.random.seed(seed)
    buffer = RolloutBuffer(gamma=cfg.gamma, lam=cfg.gae_lambda)
    normalizer = copy.deepcopy(normalizer_seed) if normalizer_seed is not None else RunningNormalizer()
    for _ in range(cfg.episodes_per_iter):
        collect_rollouts(
            model, envs, normalizer, buffer,
            update_normalizer=True, risk_beta=cfg.risk_beta, cvar_alpha=cfg.cvar_alpha,
        )
    batch = buffer.compute()
    trainer = PPOTrainer(
        model,
        PPOConfig(
            learning_rate=cfg.learning_rate, entropy_coef=cfg.entropy_coef, gamma=cfg.gamma,
            gae_lambda=cfg.gae_lambda, risk_beta=cfg.risk_beta, cvar_alpha=cfg.cvar_alpha,
        ),
    )
    trainer.update(batch)  # warm-up (kernel autotune / lazy init)
    if torch.cuda.is_available():
        torch.cuda.synchronize()
    t0 = time.perf_counter()
    trainer.update(batch)
    if torch.cuda.is_available():
        torch.cuda.synchronize()
    return time.perf_counter() - t0, len(batch)


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", default="data/market_dataset_snap800")
    parser.add_argument("--protocols", default="pumpfun")
    parser.add_argument("--min-swaps", type=int, default=16)
    parser.add_argument("--rung", type=int, default=1000, help="token cap — the ladder rung to model")
    parser.add_argument("--envs", default="50,200", help="comma-separated env counts to time")
    parser.add_argument("--devices", default="cpu,cuda")
    parser.add_argument("--paths", default="vectorized,sequential")
    parser.add_argument("--repeats", type=int, default=3, help="timed repeats per cell (min is reported)")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--full-scale", action="store_true", help="also time the FULL rung env set (vectorized only)")
    parser.add_argument("--floor", action="store_true", help="also time env.step alone (the Amdahl floor)")
    parser.add_argument("--threads", type=int, default=0, help="torch CPU threads (0 = torch default)")
    parser.add_argument(
        "--warm-ladder", default="",
        help="ladder checkpoint (or bare state_dict) to load — times a TRAINED policy's episode "
        "lengths instead of a random-init policy's much shorter ones",
    )
    parser.add_argument("--tape-cache", default="")
    parser.add_argument("--out", default="", help="write the raw samples as JSON here")
    args = parser.parse_args()

    import torch

    if args.threads > 0:
        torch.set_num_threads(args.threads)

    protocols = tuple(p.strip() for p in args.protocols.split(",") if p.strip())
    env_counts = [int(x) for x in args.envs.split(",") if x.strip()]
    paths = [p.strip() for p in args.paths.split(",") if p.strip()]
    devices = [d.strip() for d in args.devices.split(",") if d.strip()]
    if "cuda" in devices and not torch.cuda.is_available():
        print("[device] cuda requested but unavailable — dropping it")
        devices = [d for d in devices if d != "cuda"]

    print(f"[env] python={platform.python_version()} torch={torch.__version__} "
          f"threads={torch.get_num_threads()} cuda={torch.cuda.is_available()}"
          + (f" gpu={torch.cuda.get_device_name(0)}" if torch.cuda.is_available() else ""))

    cache = Path(args.tape_cache) if args.tape_cache else None
    tapes = load_tapes(
        args.dataset, protocols=protocols, min_swaps=args.min_swaps,
        max_tokens=args.rung, cache=cache,
    )
    cfg = MarketTrainConfig()
    wf: MarketWalkForward = build_market_walk_forward(tapes)
    print(f"[rung {args.rung}] tapes={len(tapes)} tradeable={len(wf.train) + len(wf.test)} "
          f"train={len(wf.train)} test={len(wf.test)} skipped={len(wf.skipped)}")

    scales = list(env_counts)
    if args.full_scale and len(wf.train) not in scales:
        scales.append(len(wf.train))

    samples: list[Sample] = []
    updates: dict[str, tuple[float, int]] = {}
    floors: dict[int, tuple[float, int]] = {}

    for n_envs in scales:
        n = min(n_envs, len(wf.train))
        envs = [wf.env(p, cfg, seed=args.seed) for p in wf.train[:n]]
        if args.floor:
            secs, _ = time_env_floor(envs, n_steps_target=0)
            floors[n] = (secs, 0)
            print(f"[floor] {n} envs: env.step-only collection = {secs:.3f}s")
        for device_name in devices:
            device = torch.device(device_name)
            warm_state, warm_norm = (None, None)
            if args.warm_ladder:
                warm_state, warm_norm = _load_warm(Path(args.warm_ladder), device)
            model = _fresh_model(cfg, device, args.seed, warm_state)
            # Warm-up on a small slice: pays CUDA context/kernel-autotune costs outside the timers.
            time_collect(
                model, envs[: min(4, n)], cfg, vectorized=True, seed=args.seed, normalizer_seed=warm_norm
            )
            for path in paths:
                runs: list[tuple[float, int, int]] = []
                for r in range(args.repeats):
                    runs.append(
                        time_collect(
                            model, envs, cfg, vectorized=(path == "vectorized"),
                            seed=args.seed + r, normalizer_seed=warm_norm,
                        )
                    )
                sample = Sample(
                    device=device_name, path=path, n_envs=n, repeats=len(runs),
                    secs_total=sum(r[0] for r in runs),
                    steps_total=sum(r[1] for r in runs),
                    episodes_total=sum(r[2] for r in runs),
                )
                samples.append(sample)
                spread = max(r[0] for r in runs) - min(r[0] for r in runs)
                print(
                    f"[collect] {device_name:<4} {path:<10} envs={n:<4} "
                    f"{sample.seconds:8.3f}s  steps={sample.n_steps:>9.0f} "
                    f"({sample.steps_per_episode:6.1f} steps/ep)  "
                    f"{sample.us_per_env_step:8.1f} us/env-step  (spread {spread:.3f}s over {len(runs)})"
                )
            key = f"{device_name}@{n}"
            upd_secs, batch_n = time_ppo_update(model, envs, cfg, seed=args.seed, normalizer_seed=warm_norm)
            updates[key] = (upd_secs, batch_n)
            print(f"[ppo]     {device_name:<4} envs={n:<4} update={upd_secs:.3f}s on batch={batch_n}")

    # ---- table ----------------------------------------------------------
    print()
    print("=" * 104)
    print(f"{'device':<8}{'envs':>6}{'seq s':>11}{'vec s':>11}{'wall x':>9}"
          f"{'seq us/step':>13}{'vec us/step':>13}{'per-step x':>12}"
          f"{'seq stp/ep':>12}{'vec stp/ep':>12}")
    print("-" * 104)
    for n_envs in sorted({s.n_envs for s in samples}):
        for device_name in devices:
            seq = next((s for s in samples if s.n_envs == n_envs and s.device == device_name and s.path == "sequential"), None)
            vec = next((s for s in samples if s.n_envs == n_envs and s.device == device_name and s.path == "vectorized"), None)
            if vec is None:
                continue
            if seq is None:
                print(f"{device_name:<8}{n_envs:>6}{'--':>11}{vec.seconds:>11.3f}{'--':>9}"
                      f"{'--':>13}{vec.us_per_env_step:>13.1f}{'--':>12}{'--':>12}"
                      f"{vec.steps_per_episode:>12.1f}")
                continue
            print(f"{device_name:<8}{n_envs:>6}{seq.seconds:>11.3f}{vec.seconds:>11.3f}"
                  f"{seq.seconds / vec.seconds:>8.2f}x{seq.us_per_env_step:>13.1f}"
                  f"{vec.us_per_env_step:>13.1f}"
                  f"{seq.us_per_env_step / vec.us_per_env_step:>11.2f}x"
                  f"{seq.steps_per_episode:>12.1f}{vec.steps_per_episode:>12.1f}")
    print("=" * 104)

    # ---- iteration + rung extrapolation ---------------------------------
    print()
    print(f"Per-iteration model: {cfg.episodes_per_iter} x collect + 1 x PPO update")
    for n_envs in sorted({s.n_envs for s in samples}):
        for device_name in devices:
            vec = next((s for s in samples if s.n_envs == n_envs and s.device == device_name and s.path == "vectorized"), None)
            seq = next((s for s in samples if s.n_envs == n_envs and s.device == device_name and s.path == "sequential"), None)
            upd = updates.get(f"{device_name}@{n_envs}", (0.0, 0))[0]
            if vec is None:
                continue
            vec_iter = cfg.episodes_per_iter * vec.seconds + upd
            line = f"  {device_name:<5} envs={n_envs:<5} vec_iter={vec_iter:7.2f}s"
            if seq is not None:
                seq_iter = cfg.episodes_per_iter * seq.seconds + upd
                line += f"  seq_iter={seq_iter:8.2f}s  iter_speedup={seq_iter / vec_iter:5.2f}x"
            print(line)

    if args.out:
        Path(args.out).write_text(
            json.dumps(
                {
                    "config": vars(args),
                    "torch": torch.__version__,
                    "threads": torch.get_num_threads(),
                    "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
                    "n_train_envs_at_rung": len(wf.train),
                    "n_test_envs_at_rung": len(wf.test),
                    "samples": [asdict(s) for s in samples],
                    "updates": updates,
                    "floors": {str(k): v for k, v in floors.items()},
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"\n[out] raw samples -> {args.out}")

    lens = [len(t.swaps) for t in tapes]
    if lens:
        print(f"\n[tape] swaps/token: min={min(lens)} median={statistics.median(lens):.0f} "
              f"mean={statistics.mean(lens):.0f} p90={sorted(lens)[int(0.9 * len(lens))]} max={max(lens)}")


if __name__ == "__main__":
    main()
