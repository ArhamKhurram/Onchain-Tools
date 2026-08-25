"""Rollout collection — drive the learned actor through :class:`TradingEnv`s, record on-policy data.

This is the bridge between the numpy :class:`RolloutBuffer` (which owns the GAE math) and the torch
:class:`HybridActorCritic` (which produces the actions, log-probs, and value baselines). For each
env it runs one stochastic episode, folding every step into a :class:`Transition`, and hands the
buffer the bootstrap value at the episode boundary — 0 on a *natural terminal* (the episode proved no
future value) and the critic's value of the final next-state on a *truncation* (the MDP did not end;
the tail is bootstrapped). See ``buffer.py`` for why the two boundaries differ.

The running observation normalizer is updated **here**, during collection, and only on training tape
— evaluation uses the frozen copy, so a held-out episode never shifts the statistics it is judged
against. Torch-gated: importing is fine without the extra, calling :func:`collect_rollouts` is not.

Why this loop is vectorized
---------------------------
Collection, not the gradient step, is the ladder's budget. The network is tiny (a 15-dim observation
through a ≤128-wide two-layer torso into small heads), so a batch-size-1 forward buys no compute and
pays full latency: measured on this exact model, one env-step costs **461 µs on CPU against 2474 µs
on CUDA** — the GPU is 5.4x *slower*, because the step is round-trip-bound and never compute-bound,
and every ``.item()`` / ``.cpu().numpy()`` inside the inner loop forces a device sync. At rung 1000
the ladder walks ~1000 envs × up to 2000 steps × 4 episodes per iteration, so that per-step round
trip *is* the training time.

The default path therefore steps every env in **lockstep**: one ``np.stack`` of the active envs'
observations, ONE batched forward, ONE fused host transfer carrying (intent, size, log-prob,
quantiles) for the whole batch, then the cheap per-env ``env.step`` bookkeeping. Envs drop out of the
active set as their episodes end, so a long tail costs only the envs still running. The truncation
bootstraps are batched the same way — every env that truncated on a given timestep is bootstrapped in
a single extra forward. :class:`HybridActorCritic` was already batch-native (``ActorOutput`` is
``(B, n_intents)`` / ``(B,)`` / ``(B,)`` / ``(B, n_quantiles)``), so the model needed no change; only
this loop did. Measured end-to-end on CPU with cheap scripted envs — so this is the *ceiling*, the
share of the win that env.step does not eat back — collection runs 4x faster at 16 envs and ~12x at
64 (688 µs → 60 µs per env-step); the gain scales with how many envs are still active per timestep.

Honest caveat: vectorizing is NOT bit-identical across multiple envs
--------------------------------------------------------------------
Two things genuinely change relative to the sequential path, and neither is a defect to be fixed:

1. **The normalizer follows a different trajectory.** Its running Welford statistics now see
   observations *interleaved across envs, one timestep at a time* instead of one complete episode at
   a time. The same multiset of observations is folded in, so the statistics are *statistically*
   equivalent — but they are read while they are being written, so the standardized vectors the
   network sees (and therefore the actions) diverge numerically.
2. **RNG consumption differs.** Drawing B samples in one call advances the generator differently from
   B single-sample calls, so the sampled action stream diverges even for identical inputs.

Both are expected consequences of batching, not approximations: a run remains fully deterministic for
a fixed seed, it simply walks a different (equally valid) trajectory. With **exactly one env** the
batch is size 1, the interleaving is trivial, and the RNG draws line up — so the two paths agree
*exactly*, which is what ``tests/test_vectorized_rollouts.py`` pins as the correctness proof. Pass
``vectorized=False`` to reproduce a pre-vectorization run step-for-step.

One precondition the sequential path did not have: the vectorized path resets every env up front and
steps them concurrently, so the entries of ``envs`` must be **distinct instances**.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from oct_trading_agent.agent.envs import EnvAction, TradingEnv, action_from_array
from oct_trading_agent.agent.online.buffer import RolloutBuffer, Transition
from oct_trading_agent.agent.online.normalize import RunningNormalizer

try:  # pragma: no cover - trivial import guard
    import torch
    from torch.distributions import Beta, Categorical

    TORCH_AVAILABLE = True
except ImportError:  # pragma: no cover
    TORCH_AVAILABLE = False

# Layout of the fused host transfer: [intent_index, size, log_prob, *quantiles] per batch row.
_N_SCALAR_COLS = 3


def _require_torch() -> None:
    if not TORCH_AVAILABLE:
        raise ImportError("collect_rollouts requires the optional 'learn' extra (`uv sync --extra learn`).")


def _sample_actions(out: Any) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """Sample the hybrid action for a whole batch: returns ``(intents, sizes, joint_log_probs)``.

    Shared verbatim by both collection paths so they cannot drift apart — at batch size 1 this is
    the exact call sequence (and therefore the exact RNG consumption) of the pre-vectorization
    implementation, which is what makes the single-env equivalence test meaningful.

    ``Beta.log_prob`` is unbounded at the open interval's endpoints and the sampled size can land
    on them after the clamp, so the log-prob is evaluated a hair inside the boundary — the size the
    env actually executes is never nudged.
    """
    cat = Categorical(logits=out.intent_logits)
    beta = Beta(out.size_alpha, out.size_beta)
    intents = cat.sample()
    sizes = beta.sample().clamp(0.0, 1.0)
    safe_sizes = sizes.clamp(1e-6, 1.0 - 1e-6)
    log_probs = cat.log_prob(intents) + beta.log_prob(safe_sizes)
    return intents, sizes, log_probs


def _pack_for_transfer(
    intents: torch.Tensor, sizes: torch.Tensor, log_probs: torch.Tensor, quantiles: torch.Tensor
) -> np.ndarray:
    """Fuse the four per-step outputs into ONE device→host transfer, ``(B, 3 + n_quantiles)``.

    Four separate ``.cpu()`` calls would be four full device syncs per timestep — the very cost this
    rewrite exists to remove — so the columns are concatenated on-device and moved once. The intent
    index rides in a float column, which is lossless here: it indexes ``INTENT_ORDER`` (6 entries),
    far inside float32's exactly-representable integer range.
    """
    scalars = torch.stack([intents.to(quantiles.dtype), sizes, log_probs], dim=1)
    return torch.cat([scalars, quantiles], dim=1).cpu().numpy()  # type: ignore[no-any-return, unused-ignore]


def _env_action(intent_index: int, size: float) -> EnvAction:
    """Narrow one sampled ``(intent_index, size)`` pair into the env's typed hybrid action."""
    return action_from_array(np.array([intent_index, size], dtype=np.float64))


def collect_rollouts(
    model: Any,
    envs: list[TradingEnv],
    normalizer: RunningNormalizer,
    buffer: RolloutBuffer,
    *,
    update_normalizer: bool = True,
    max_steps_per_episode: int = 2000,
    risk_beta: float = 0.0,
    cvar_alpha: float = 0.05,
    vectorized: bool = True,
) -> RolloutBuffer:
    """Collect one stochastic episode per env into ``buffer``; return the same buffer.

    ``model`` is a :class:`~oct_trading_agent.agent.policies.torch_actor.HybridActorCritic`.
    ``normalizer`` maps raw observations to the standardized network input and is updated in place
    when ``update_normalizer`` is set (train-time). Actions are *sampled* (exploration); the joint
    log-prob and the critic's value baseline are recorded for PPO. ``risk_beta > 0`` blends the value
    baseline toward the critic's CVaR_α (paper §6.3), so the advantages PPO forms are tail-aware.

    Episodes are added to ``buffer`` in env order (index 0..n-1) regardless of the order they
    finished in, so buffer contents do not depend on which path collected them.

    ``vectorized`` (default) steps all envs in lockstep behind one batched forward per timestep; set
    it False for the legacy one-env-at-a-time path, which is bit-for-bit reproducible against
    pre-vectorization runs. See the module docstring for exactly what batching changes.
    """
    _require_torch()
    collect = _collect_vectorized if vectorized else _collect_sequential
    return collect(
        model,
        envs,
        normalizer,
        buffer,
        update_normalizer=update_normalizer,
        max_steps_per_episode=max_steps_per_episode,
        risk_beta=risk_beta,
        cvar_alpha=cvar_alpha,
    )


def _collect_vectorized(
    model: Any,
    envs: list[TradingEnv],
    normalizer: RunningNormalizer,
    buffer: RolloutBuffer,
    *,
    update_normalizer: bool,
    max_steps_per_episode: int,
    risk_beta: float,
    cvar_alpha: float,
) -> RolloutBuffer:
    """Step every env in lockstep, one batched forward per timestep. See the module docstring."""
    from oct_trading_agent.agent.critics.quantile import risk_blended_value

    # The model carries the device; observation tensors are moved onto it so the forward runs there.
    device = next(model.parameters()).device
    n_envs = len(envs)

    # Accumulate per env INDEX, not per finish order, so the buffer is filled in env order below.
    episodes: list[list[Transition]] = [[] for _ in range(n_envs)]
    last_values = [0.0] * n_envs
    observations = [env.reset() for env in envs]
    # Envs still running. Every member has taken exactly `steps` steps (they start together and are
    # dropped the moment they finish), so the shared counter *is* each env's own step budget.
    active = list(range(n_envs))
    steps = 0

    while active and steps < max_steps_per_episode:
        vectors: list[np.ndarray] = []
        for i in active:
            observation = observations[i]
            if update_normalizer:
                normalizer.update(observation)
            vectors.append(np.asarray(normalizer.normalize(observation), dtype=np.float32))
        with torch.no_grad():
            batch = torch.from_numpy(np.stack(vectors)).to(device)
            out = model.forward(batch)
            intents, sizes, log_probs = _sample_actions(out)
            packed = _pack_for_transfer(intents, sizes, log_probs, out.quantiles)

        still_active: list[int] = []
        bootstrap_ids: list[int] = []
        bootstrap_vectors: list[np.ndarray] = []
        for slot, i in enumerate(active):
            intent_index = int(packed[slot, 0])
            size = float(packed[slot, 1])
            result = envs[i].step(_env_action(intent_index, size))
            episodes[i].append(
                Transition(
                    obs_vector=vectors[slot],
                    intent_index=intent_index,
                    size=size,
                    log_prob=float(packed[slot, 2]),
                    value=risk_blended_value(packed[slot, _N_SCALAR_COLS:], risk_beta, cvar_alpha),
                    reward=float(result.reward),
                    terminated=bool(result.terminated),
                    truncated=bool(result.truncated),
                )
            )
            observations[i] = result.observation
            if result.terminated or result.truncated:
                # On truncation the tail is bootstrapped with the value of the state we truncated at;
                # a natural terminal keeps last_value at 0.0. Defer the forward so every env that
                # truncated on THIS timestep is bootstrapped in one batch.
                if result.truncated and not result.terminated:
                    bootstrap_ids.append(i)
                    bootstrap_vectors.append(
                        np.asarray(normalizer.normalize(result.observation), dtype=np.float32)
                    )
            else:
                still_active.append(i)
        active = still_active
        steps += 1

        if bootstrap_vectors:
            with torch.no_grad():
                boot_batch = torch.from_numpy(np.stack(bootstrap_vectors)).to(device)
                boot_quantiles = model.forward(boot_batch).quantiles.cpu().numpy()
            for slot, i in enumerate(bootstrap_ids):
                last_values[i] = risk_blended_value(boot_quantiles[slot], risk_beta, cvar_alpha)

    for i in range(n_envs):
        buffer.add_episode(episodes[i], last_values[i])
    return buffer


def _collect_sequential(
    model: Any,
    envs: list[TradingEnv],
    normalizer: RunningNormalizer,
    buffer: RolloutBuffer,
    *,
    update_normalizer: bool,
    max_steps_per_episode: int,
    risk_beta: float,
    cvar_alpha: float,
) -> RolloutBuffer:
    """The legacy path: one env at a time, one batch-of-1 forward per env-step.

    Kept because it is the *reference* semantics — it reproduces pre-vectorization runs step-for-step
    and is what the single-env equivalence test measures the batched path against. It is
    substantially slower (see the module docstring) and should not be the default anywhere.
    """
    from oct_trading_agent.agent.critics.quantile import risk_blended_value

    device = next(model.parameters()).device

    for env in envs:
        obs = env.reset()
        transitions: list[Transition] = []
        done = False
        last_value = 0.0
        steps = 0
        while not done and steps < max_steps_per_episode:
            if update_normalizer:
                normalizer.update(obs)
            vec = np.asarray(normalizer.normalize(obs), dtype=np.float32)
            with torch.no_grad():
                obs_t = torch.from_numpy(vec).unsqueeze(0).to(device)
                out = model.forward(obs_t)
                intent, size, log_prob = _sample_actions(out)
                logp = float(log_prob.item())
                quantiles = out.quantiles.squeeze(0).cpu().numpy()
                value = risk_blended_value(quantiles, risk_beta, cvar_alpha)
            intent_idx = int(intent.item())
            size_val = float(size.item())
            result = env.step(_env_action(intent_idx, size_val))
            transitions.append(
                Transition(
                    obs_vector=vec,
                    intent_index=intent_idx,
                    size=size_val,
                    log_prob=logp,
                    value=value,
                    reward=float(result.reward),
                    terminated=bool(result.terminated),
                    truncated=bool(result.truncated),
                )
            )
            done = result.terminated or result.truncated
            steps += 1
            # On truncation the tail is bootstrapped with the value of the state we truncated at.
            if done and result.truncated and not result.terminated:
                nxt = np.asarray(normalizer.normalize(result.observation), dtype=np.float32)
                with torch.no_grad():
                    nxt_t = torch.from_numpy(nxt).unsqueeze(0).to(device)
                    nxt_q = model.forward(nxt_t).quantiles.squeeze(0).cpu().numpy()
                    last_value = risk_blended_value(nxt_q, risk_beta, cvar_alpha)
            obs = result.observation
        buffer.add_episode(transitions, last_value)
    return buffer


__all__ = ["collect_rollouts"]
