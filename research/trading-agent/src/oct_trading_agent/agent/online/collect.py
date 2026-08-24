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
"""

from __future__ import annotations

from typing import Any

import numpy as np

from oct_trading_agent.agent.envs import TradingEnv, action_from_array
from oct_trading_agent.agent.online.buffer import RolloutBuffer, Transition
from oct_trading_agent.agent.online.normalize import RunningNormalizer

try:  # pragma: no cover - trivial import guard
    import torch
    from torch.distributions import Beta, Categorical

    TORCH_AVAILABLE = True
except ImportError:  # pragma: no cover
    TORCH_AVAILABLE = False


def _require_torch() -> None:
    if not TORCH_AVAILABLE:
        raise ImportError("collect_rollouts requires the optional 'learn' extra (`uv sync --extra learn`).")


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
) -> RolloutBuffer:
    """Collect one stochastic episode per env into ``buffer``; return the same buffer.

    ``model`` is a :class:`~oct_trading_agent.agent.policies.torch_actor.HybridActorCritic`.
    ``normalizer`` maps raw observations to the standardized network input and is updated in place
    when ``update_normalizer`` is set (train-time). Actions are *sampled* (exploration); the joint
    log-prob and the critic's value baseline are recorded for PPO. ``risk_beta > 0`` blends the value
    baseline toward the critic's CVaR_α (paper §6.3), so the advantages PPO forms are tail-aware.
    """
    _require_torch()
    from oct_trading_agent.agent.critics.quantile import risk_blended_value

    # The model carries the device; observation tensors are moved onto it so the forward runs there.
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
            vec = normalizer.normalize(obs)
            obs_t = torch.from_numpy(np.asarray(vec, dtype=np.float32)).unsqueeze(0).to(device)
            with torch.no_grad():
                out = model.forward(obs_t)
                cat = Categorical(logits=out.intent_logits)
                beta = Beta(out.size_alpha, out.size_beta)
                intent = cat.sample()
                size = beta.sample().clamp(0.0, 1.0)
                safe_size = size.clamp(1e-6, 1.0 - 1e-6)
                logp = float((cat.log_prob(intent) + beta.log_prob(safe_size)).item())
                quantiles = out.quantiles.squeeze(0).cpu().numpy()
                value = risk_blended_value(quantiles, risk_beta, cvar_alpha)
            intent_idx = int(intent.item())
            size_val = float(size.item())
            result = env.step(action_from_array(np.array([intent_idx, size_val], dtype=np.float64)))
            transitions.append(
                Transition(
                    obs_vector=np.asarray(vec, dtype=np.float32),
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
                nxt = normalizer.normalize(result.observation)
                with torch.no_grad():
                    nxt_t = torch.from_numpy(np.asarray(nxt, dtype=np.float32)).unsqueeze(0).to(device)
                    nxt_q = model.forward(nxt_t).quantiles.squeeze(0).cpu().numpy()
                    last_value = risk_blended_value(nxt_q, risk_beta, cvar_alpha)
            obs = result.observation
        buffer.add_episode(transitions, last_value)
    return buffer


__all__ = ["collect_rollouts"]
