"""The learned hybrid actor + distributional critic (paper §3.3 action, §6.3 critic). TORCH.

This is the Phase-1 LEARNER's policy: a small shared-torso network that consumes the tier-A masked
observation vector and emits the §3.3 **hybrid action** — a discrete intent over
``{no-op, open-long, add, trim, close, hold}`` paired with a continuous size in ``[0, 1]`` (the
fraction of the risk budget; long-only, no short) — while a :class:`QuantileValueHead` on the *same*
torso gives the distributional value baseline PPO trains against.

Three commitments are structural:

* **The missingness mask is respected — a missing feature never leaks as a real 0.** The observation
  vector is ``concat(features, mask, state)``. The torso input re-applies the gate ``features ← features · mask``
  so a masked-off slot contributes exactly 0 regardless of its placeholder, *and* the mask block is
  fed alongside so the network can condition on *which* slots were observed. (The upstream normalizer
  already re-gates; this is the belt-and-braces second guard at the network boundary.)
* **Size is a Beta law on [0, 1].** A ``Beta(α, β)`` (with ``α, β = 1 + softplus(·) ≥ 1``, so the
  density is finite and unimodal on the open interval) is the natural distribution for a *bounded*
  size and keeps PPO's log-probs and entropy well-defined without the boundary pathologies of a
  squashed Gaussian. The env clamps size to ``[0, 1]`` and ignores it for the non-sizing intents, so
  the policy always emits a size but only the sized intents spend it.
* **One torso, two objectives.** Actor heads and the quantile critic share the torso, so the value
  gradient shapes the representation the policy reads (a single co-trained backbone; paper §6.4 in
  miniature — the full SSL co-training with the swap-sequence encoder is deferred).

``torch`` is the OPTIONAL ``learn`` extra: this module imports without it; constructing the network
or the :class:`TorchPolicy` raises a clear error otherwise. :class:`TorchPolicy` satisfies the
:class:`~oct_trading_agent.agent.policies.EnvPolicy` seam, so a trained actor drops into the eval
runner and the baselines' harness unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from oct_trading_agent.agent.critics.quantile import distribution_cvar, distribution_mean
from oct_trading_agent.agent.envs import (
    INTENT_ORDER,
    EnvAction,
    Observation,
    vector_length,
)
from oct_trading_agent.agent.envs.observation import TIER_A_SLOTS
from oct_trading_agent.agent.online.normalize import RunningNormalizer

_N_FEATURES = len(TIER_A_SLOTS)
_N_INTENTS = len(INTENT_ORDER)

try:  # pragma: no cover - trivial import guard
    import torch
    from torch import nn
    from torch.distributions import Beta, Categorical

    TORCH_AVAILABLE = True
except ImportError:  # pragma: no cover
    TORCH_AVAILABLE = False


def _require_torch() -> None:
    if not TORCH_AVAILABLE:
        raise ImportError(
            "the learned actor-critic requires the optional 'learn' extra "
            "(`uv sync --extra learn`)."
        )


@dataclass(frozen=True)
class ActorConfig:
    """Small-net hyperparameters for the Phase-1 learner (bounded compute by design)."""

    hidden_dim: int = 64
    n_quantiles: int = 8
    cvar_alpha: float = 0.05


def _gate_missing(vector: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Return a copy of the flat obs vector with the feature block zeroed where the mask is 0."""
    out = np.asarray(vector, dtype=np.float32).copy()
    out[:_N_FEATURES] = out[:_N_FEATURES] * mask.astype(np.float32)
    return out


if TORCH_AVAILABLE:
    from oct_trading_agent.agent.critics.quantile import QuantileValueHead

    @dataclass(frozen=True)
    class ActorOutput:
        """One forward pass: the two action distributions and the critic's quantiles."""

        intent_logits: torch.Tensor  # (B, n_intents)
        size_alpha: torch.Tensor  # (B,)
        size_beta: torch.Tensor  # (B,)
        quantiles: torch.Tensor  # (B, n_quantiles)

    class HybridActorCritic(nn.Module):  # type: ignore[misc, unused-ignore]  # torch Any in lean check
        """Shared-torso actor (categorical intent + Beta size) with a distributional quantile critic."""

        def __init__(self, config: ActorConfig | None = None) -> None:
            _require_torch()
            super().__init__()
            self.config = config or ActorConfig()
            d_in = vector_length()
            h = self.config.hidden_dim
            self.torso = nn.Sequential(
                nn.Linear(d_in, h), nn.Tanh(), nn.Linear(h, h), nn.Tanh()
            )
            self.intent_head = nn.Linear(h, _N_INTENTS)
            self.size_head = nn.Linear(h, 2)  # -> (alpha_raw, beta_raw)
            self.critic = QuantileValueHead(h, n_quantiles=self.config.n_quantiles)

        def forward(self, obs: torch.Tensor) -> ActorOutput:
            z = self.torso(obs)
            intent_logits = self.intent_head(z)
            raw = self.size_head(z)
            # alpha, beta >= 1 so the Beta density is finite and unimodal on (0, 1).
            ab = 1.0 + nn.functional.softplus(raw)
            quantiles = self.critic(z)
            return ActorOutput(
                intent_logits=intent_logits,
                size_alpha=ab[:, 0],
                size_beta=ab[:, 1],
                quantiles=quantiles,
            )

        @staticmethod
        def _size_dist(alpha: torch.Tensor, beta: torch.Tensor) -> Beta:
            return Beta(alpha, beta)

        def evaluate_actions(
            self, obs: torch.Tensor, intents: torch.Tensor, sizes: torch.Tensor
        ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
            """For a batch of (obs, intent, size): return (joint_log_prob, entropy, quantiles).

            Joint log-prob = ``log p(intent) + log p(size)``; entropy = the sum of the two heads'
            entropies. Sizes are clamped off the open-interval boundary so ``Beta.log_prob`` is finite.
            """
            out = self.forward(obs)
            cat = Categorical(logits=out.intent_logits)
            beta = self._size_dist(out.size_alpha, out.size_beta)
            safe_size = sizes.clamp(1e-6, 1.0 - 1e-6)
            logp = cat.log_prob(intents) + beta.log_prob(safe_size)
            entropy = cat.entropy() + beta.entropy()
            return logp, entropy, out.quantiles

    def build_actor_critic(
        config: ActorConfig | None = None, *, device: torch.device | None = None
    ) -> HybridActorCritic:
        """Construct a :class:`HybridActorCritic` (requires the ``learn`` extra).

        ``device`` (a :class:`torch.device` from :func:`~oct_trading_agent.agent.device.resolve_device`)
        places the whole network — torso, both action heads, and the quantile critic's registered
        ``taus`` buffer — on that device at construction, so the forward/backward run there. ``None``
        leaves it on the default (CPU) device, so existing callers are unchanged.
        """
        model = HybridActorCritic(config)
        if device is not None:
            model.to(device)  # in-place; nn.Module.to also returns self (device carried by params)
        return model


class TorchPolicy:
    """Wrap a trained :class:`HybridActorCritic` as an :class:`EnvPolicy` (observation → EnvAction).

    ``deterministic`` (the eval default) picks the argmax intent and the Beta *mode* size — the
    apples-to-apples policy the metric battery scores against the baselines. ``deterministic=False``
    samples (used during rollout collection). An optional frozen :class:`RunningNormalizer` maps the
    raw observation to the standardized vector the network was trained on; the mask is always applied
    at the network boundary regardless.
    """

    def __init__(
        self,
        model: Any,
        *,
        normalizer: RunningNormalizer | None = None,
        deterministic: bool = True,
    ) -> None:
        _require_torch()
        self._model = model
        self._normalizer = normalizer
        self._deterministic = deterministic
        # Follow the model onto whatever device it was built on, so observation tensors land there too.
        self._device = next(model.parameters()).device

    def reset(self) -> None:
        return None

    def _obs_vector(self, observation: Observation) -> np.ndarray:
        if self._normalizer is not None:
            vec = self._normalizer.normalize(observation)  # already re-gated + mask-aware
        else:
            vec = _gate_missing(observation.to_vector(), observation.mask)
        return np.asarray(vec, dtype=np.float32)

    def act(self, observation: Observation) -> EnvAction:
        assert TORCH_AVAILABLE  # constructor enforced this
        vec = self._obs_vector(observation)
        with torch.no_grad():
            obs_t = torch.from_numpy(vec).float().unsqueeze(0).to(self._device)
            out = self._model.forward(obs_t)
            if self._deterministic:
                idx = int(torch.argmax(out.intent_logits, dim=-1).item())
                a = float(out.size_alpha.item())
                b = float(out.size_beta.item())
                # Beta mode for α, β > 1; falls back to the mean for the degenerate flats.
                size = (a - 1.0) / (a + b - 2.0) if (a + b) > 2.0 else a / (a + b)
            else:
                cat = Categorical(logits=out.intent_logits)
                idx = int(cat.sample().item())
                size = float(Beta(out.size_alpha, out.size_beta).sample().item())
        size = float(np.clip(size, 0.0, 1.0))
        return EnvAction(intent=INTENT_ORDER[idx], size=size)

    def value_distribution(self, observation: Observation) -> tuple[float, float]:
        """Return ``(mean_value, cvar_value)`` from the critic for one observation (introspection)."""
        assert TORCH_AVAILABLE
        vec = self._obs_vector(observation)
        with torch.no_grad():
            obs_t = torch.from_numpy(vec).float().unsqueeze(0).to(self._device)
            q = self._model.forward(obs_t).quantiles.squeeze(0).cpu().numpy()
        return distribution_mean(q), distribution_cvar(q, self._model.config.cvar_alpha)


__all__ = [
    "ActorConfig",
    "TORCH_AVAILABLE",
    "TorchPolicy",
]
if TORCH_AVAILABLE:
    __all__ += ["ActorOutput", "HybridActorCritic", "build_actor_critic"]
