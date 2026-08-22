"""PPO — clipped-objective actor-critic training for the hybrid action + distributional critic. TORCH.

The Phase-1 learner's optimizer (paper §6.6 "PPO online fine-tune against the sim"; the offline/
imitation warm-start of §6 is deferred — it needs the labeled-wallet DB, not yet wired). PPO is the
right first choice here: on-policy, robust to the tiny per-token sample, and it composes cleanly with
the hybrid action (the joint log-prob of the categorical intent and the Beta size) and with a
distributional value baseline.

The update is standard PPO with three terms:

* **Clipped policy loss** over the joint log-prob ratio, on GAE-λ advantages
  (``online/buffer.py``).
* **Distributional critic loss** — the quantile-Huber regression (``critics/quantile.py``) of the
  predicted quantiles toward the λ-return target, *not* an MSE on the mean. This is what makes the
  value estimate distributional (paper §6.3).
* **Entropy bonus** on both action heads, to keep exploration alive on short episodes.

**Risk-sensitivity is wired, not decorative.** ``risk_beta > 0`` blends the critic's mean value
toward its CVaR_α when forming the advantage baseline, so the policy is optimized against a
*pessimistic, tail-aware* value — the §6.3 "optimize CVaR, not the mean" objective at the advantage
level. It defaults to 0 (pure mean baseline) for the headline honest run and is exposed as a knob.

Torch-gated: the module imports without the extra; :class:`PPOTrainer` construction requires it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from oct_trading_agent.agent.online.buffer import RolloutBatch

try:  # pragma: no cover - trivial import guard
    import torch
    from torch.distributions import Beta, Categorical

    TORCH_AVAILABLE = True
except ImportError:  # pragma: no cover
    TORCH_AVAILABLE = False


def _require_torch() -> None:
    if not TORCH_AVAILABLE:
        raise ImportError("PPOTrainer requires the optional 'learn' extra (`uv sync --extra learn`).")


@dataclass(frozen=True)
class PPOConfig:
    """PPO hyperparameters. Deliberately modest — a first honest signal, not a sweep."""

    clip_range: float = 0.2
    value_coef: float = 0.5
    entropy_coef: float = 0.01
    learning_rate: float = 3e-4
    n_epochs: int = 4
    minibatch_size: int = 256
    max_grad_norm: float = 0.5
    gamma: float = 0.99
    gae_lambda: float = 0.95
    # Risk-sensitive advantage blend: 0 = mean baseline; 1 = pure CVaR baseline (paper §6.3).
    risk_beta: float = 0.0
    cvar_alpha: float = 0.05


@dataclass(frozen=True)
class PPOUpdateStats:
    """Diagnostics from one :meth:`PPOTrainer.update` call (for the training log)."""

    policy_loss: float
    value_loss: float
    entropy: float
    approx_kl: float
    clip_fraction: float
    n_samples: int


class PPOTrainer:
    """Owns the optimizer and the PPO update over a :class:`RolloutBatch`.

    ``model`` is a :class:`~oct_trading_agent.agent.policies.torch_actor.HybridActorCritic`. One
    :meth:`update` runs ``n_epochs`` of minibatched PPO on a collected batch and returns aggregated
    stats.
    """

    def __init__(self, model: Any, config: PPOConfig | None = None) -> None:
        _require_torch()
        self.model = model
        self.config = config or PPOConfig()
        self._optimizer = torch.optim.Adam(
            model.parameters(),
            lr=self.config.learning_rate,
        )

    def update(self, batch: RolloutBatch) -> PPOUpdateStats:
        """Run ``n_epochs`` of minibatched clipped-PPO on ``batch``; return aggregated stats."""
        from oct_trading_agent.agent.critics.quantile import quantile_huber_loss

        n = len(batch)
        if n == 0:
            return PPOUpdateStats(0.0, 0.0, 0.0, 0.0, 0.0, 0)

        obs = torch.from_numpy(batch.obs).float()
        intents = torch.from_numpy(batch.intents).long()
        sizes = torch.from_numpy(batch.sizes).float()
        old_logp = torch.from_numpy(batch.log_probs).float()
        advantages = torch.from_numpy(batch.advantages).float()
        returns = torch.from_numpy(batch.returns).float()

        cfg = self.config
        taus = self.model.critic.taus
        idx_all = np.arange(n)
        rng = np.random.default_rng(0)

        pol_losses: list[float] = []
        val_losses: list[float] = []
        ents: list[float] = []
        kls: list[float] = []
        clips: list[float] = []

        for _ in range(cfg.n_epochs):
            rng.shuffle(idx_all)
            for start in range(0, n, cfg.minibatch_size):
                mb = idx_all[start : start + cfg.minibatch_size]
                if mb.size == 0:
                    continue
                mb_t = torch.from_numpy(mb).long()
                out = self.model.forward(obs[mb_t])
                cat = Categorical(logits=out.intent_logits)
                beta_d = Beta(out.size_alpha, out.size_beta)
                safe_size = sizes[mb_t].clamp(1e-6, 1.0 - 1e-6)
                logp = cat.log_prob(intents[mb_t]) + beta_d.log_prob(safe_size)
                entropy = (cat.entropy() + beta_d.entropy()).mean()

                ratio = torch.exp(logp - old_logp[mb_t])
                adv = advantages[mb_t]
                unclipped = ratio * adv
                clipped = torch.clamp(ratio, 1.0 - cfg.clip_range, 1.0 + cfg.clip_range) * adv
                policy_loss = -torch.min(unclipped, clipped).mean()

                # Distributional critic: quantile-Huber toward the λ-return target.
                value_loss = quantile_huber_loss(out.quantiles, returns[mb_t], taus)

                loss = policy_loss + cfg.value_coef * value_loss - cfg.entropy_coef * entropy

                self._optimizer.zero_grad()
                loss.backward()
                torch.nn.utils.clip_grad_norm_(self.model.parameters(), cfg.max_grad_norm)
                self._optimizer.step()

                with torch.no_grad():
                    approx_kl = float((old_logp[mb_t] - logp).mean().item())
                    clip_frac = float(
                        ((ratio - 1.0).abs() > cfg.clip_range).float().mean().item()
                    )
                pol_losses.append(float(policy_loss.item()))
                val_losses.append(float(value_loss.item()))
                ents.append(float(entropy.item()))
                kls.append(approx_kl)
                clips.append(clip_frac)

        return PPOUpdateStats(
            policy_loss=float(np.mean(pol_losses)) if pol_losses else 0.0,
            value_loss=float(np.mean(val_losses)) if val_losses else 0.0,
            entropy=float(np.mean(ents)) if ents else 0.0,
            approx_kl=float(np.mean(kls)) if kls else 0.0,
            clip_fraction=float(np.mean(clips)) if clips else 0.0,
            n_samples=n,
        )


__all__ = ["PPOConfig", "PPOTrainer", "PPOUpdateStats"]
