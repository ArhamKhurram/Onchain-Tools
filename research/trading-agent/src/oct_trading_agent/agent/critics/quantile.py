"""Distributional value critic — quantile regression over the return distribution (paper §6.3). TORCH.

Fat-tailed new-pair returns make a scalar value estimate a liability, not a simplification: the whole
sizing problem is *tail* risk, and a mean cannot express it (paper §6.3, §3.5.2). So the critic emits
a **distribution** of the (λ-return) value as ``n_quantiles`` monotone-in-expectation quantile
estimates — QR-DQN's representation (Dabney et al. 2018) applied to a state-value baseline for PPO —
and the sizing objective reads a **risk measure (CVaR)** straight off it rather than the mean.

Design (kept deliberately small — this is a first honest signal, not an architecture search):

* **Head** — a linear map from the shared torso to ``n_quantiles`` outputs ``θ_1..θ_N``, the values
  of the return distribution at the midpoint quantile levels ``τ_i = (i + 0.5)/N``. No monotonicity
  is imposed on the raw outputs (QR-DQN does not either); the quantile-Huber loss induces the
  ordering in expectation.
* **Mean** — ``mean(θ)`` is the scalar value baseline GAE consumes.
* **CVaR** — ``mean of the lowest ⌈αN⌉ quantiles`` is the tail value the risk-sensitive objective
  uses (``risk_beta`` in the PPO objective blends mean→CVaR; see ``online/ppo.py``). This is exactly
  "bake risk-aversion into the value estimate, not only the reward" (paper §6.3).
* **Loss** — the **quantile Huber** loss (:func:`quantile_huber_loss`) regresses every predicted
  quantile toward the (scalar) λ-return target at its level ``τ_i``; the asymmetric weighting is what
  makes low-τ heads sit in the loss tail and high-τ heads in the gains, so the spread across states
  recovers the conditional return distribution.

``torch`` is an OPTIONAL extra. This module imports cleanly without it — only *constructing* a critic
(or calling the loss) raises, with a clear pointer to ``uv sync --extra learn``. The pure helpers
:func:`quantile_levels`, :func:`distribution_mean`, :func:`distribution_cvar` are numpy and run in the
base suite. A :func:`to_value_distribution` bridge emits the repo's typed
:class:`~oct_trading_agent.core.decision.ValueDistribution` for interop with the OCT-facing decision.
"""

from __future__ import annotations

import numpy as np

from oct_trading_agent.core.decision import ValueDistribution

try:  # pragma: no cover - trivial import guard
    import torch
    from torch import nn

    TORCH_AVAILABLE = True
except ImportError:  # pragma: no cover
    TORCH_AVAILABLE = False


def _require_torch() -> None:
    if not TORCH_AVAILABLE:
        raise ImportError(
            "the distributional quantile critic requires the optional 'learn' (or 'torch') extra "
            "(`uv sync --extra learn`); the numpy quantile helpers run without it"
        )


def quantile_levels(n_quantiles: int) -> np.ndarray:
    """Midpoint quantile levels ``τ_i = (i + 0.5) / N`` for ``i in [0, N)`` (QR-DQN convention)."""
    if n_quantiles < 1:
        raise ValueError("n_quantiles must be >= 1")
    return (np.arange(n_quantiles, dtype=np.float64) + 0.5) / n_quantiles


def distribution_mean(quantiles: np.ndarray) -> float:
    """Mean of an equal-weighted quantile set (the scalar value baseline)."""
    q = np.asarray(quantiles, dtype=np.float64).reshape(-1)
    if q.size == 0:
        return 0.0
    return float(q.mean())


def distribution_cvar(quantiles: np.ndarray, alpha: float = 0.05) -> float:
    """CVaR_α of an equal-weighted quantile set: mean of the worst ``⌈αN⌉`` quantiles (a loss < 0).

    The tail value the risk-sensitive sizing objective maximizes instead of the mean (paper §6.3) —
    this is what penalizes the martingale/lottery attractor at the *value* level.
    """
    if not 0.0 < alpha <= 1.0:
        raise ValueError("alpha must be in (0, 1]")
    q = np.sort(np.asarray(quantiles, dtype=np.float64).reshape(-1))
    if q.size == 0:
        return 0.0
    k = max(1, int(np.ceil(alpha * q.size)))
    return float(q[:k].mean())


def risk_blended_value(quantiles: np.ndarray, risk_beta: float, cvar_alpha: float = 0.05) -> float:
    """Blend the distribution's mean toward its CVaR_α by ``risk_beta`` (paper §6.3 risk-sensitivity).

    ``risk_beta == 0`` returns the plain mean value (the headline honest run); ``risk_beta == 1``
    returns the pure CVaR tail value; in between is a pessimistic baseline. Used as the value the
    advantage is formed against, so the policy is optimized for a tail-aware objective, not the mean.
    """
    if not 0.0 <= risk_beta <= 1.0:
        raise ValueError("risk_beta must be in [0, 1]")
    mean_v = distribution_mean(quantiles)
    if risk_beta <= 0.0:
        return mean_v
    return (1.0 - risk_beta) * mean_v + risk_beta * distribution_cvar(quantiles, cvar_alpha)


def to_value_distribution(quantiles: np.ndarray) -> ValueDistribution:
    """Bridge a raw quantile vector to the repo's typed :class:`ValueDistribution` (quantile form)."""
    q = np.asarray(quantiles, dtype=np.float64).reshape(-1)
    if q.size == 0:
        q = np.zeros(1, dtype=np.float64)
    return ValueDistribution(
        representation="quantile",
        locations=[float(x) for x in q],
        weights=[1.0 / q.size] * q.size,
    )


if TORCH_AVAILABLE:

    class QuantileValueHead(nn.Module):  # type: ignore[misc, unused-ignore]  # torch Any in lean check
        """Linear ``torso → n_quantiles`` head predicting the return distribution's quantiles."""

        def __init__(self, in_features: int, n_quantiles: int = 8) -> None:
            _require_torch()
            if n_quantiles < 1:
                raise ValueError("n_quantiles must be >= 1")
            super().__init__()
            self.n_quantiles = n_quantiles
            self.head = nn.Linear(in_features, n_quantiles)
            # Register the (constant) quantile levels so risk measures can be read on-device.
            taus = torch.as_tensor(quantile_levels(n_quantiles), dtype=torch.float32)
            self.register_buffer("taus", taus)

        def forward(self, torso: torch.Tensor) -> torch.Tensor:
            """Return predicted quantiles, shape ``(B, n_quantiles)``."""
            return self.head(torso)  # type: ignore[no-any-return, unused-ignore]

        def value(self, torso: torch.Tensor) -> torch.Tensor:
            """Scalar mean value baseline, shape ``(B,)``."""
            return self.forward(torso).mean(dim=-1)

        def cvar(self, torso: torch.Tensor, alpha: float = 0.05) -> torch.Tensor:
            """Risk-sensitive CVaR_α value, shape ``(B,)`` — mean of the lowest ⌈αN⌉ quantiles."""
            q, _ = torch.sort(self.forward(torso), dim=-1)
            k = max(1, int(np.ceil(alpha * self.n_quantiles)))
            return q[:, :k].mean(dim=-1)

    def quantile_huber_loss(
        predicted: torch.Tensor, target: torch.Tensor, taus: torch.Tensor, kappa: float = 1.0
    ) -> torch.Tensor:
        """Quantile Huber loss (Dabney et al. 2018) regressing ``predicted`` quantiles to ``target``.

        ``predicted`` is ``(B, N)``; ``target`` is ``(B,)`` (the scalar λ-return per sample) or
        ``(B, M)`` (a target distribution). ``taus`` is the ``(N,)`` level vector. The pairwise
        TD-error ``u = target_j - predicted_i`` is Huber-smoothed and weighted by
        ``|τ_i − 1{u<0}|`` — the asymmetry that turns L2 regression into quantile regression.
        """
        _require_torch()
        if target.dim() == 1:
            target = target.unsqueeze(-1)  # (B, 1)
        # u: (B, N, M) = target_j - predicted_i
        u = target.unsqueeze(1) - predicted.unsqueeze(2)
        abs_u = u.abs()
        huber = torch.where(
            abs_u <= kappa, 0.5 * u.pow(2), kappa * (abs_u - 0.5 * kappa)
        )
        tau = taus.view(1, -1, 1)  # (1, N, 1)
        weight = (tau - (u.detach() < 0).float()).abs()
        loss = (weight * huber / kappa).sum(dim=1).mean(dim=1)  # sum over quantiles, mean over targets
        return loss.mean()

    __all__ = [
        "QuantileValueHead",
        "TORCH_AVAILABLE",
        "ValueDistribution",
        "distribution_cvar",
        "distribution_mean",
        "quantile_huber_loss",
        "quantile_levels",
        "risk_blended_value",
        "to_value_distribution",
    ]
else:  # pragma: no cover - exercised only in a lean (no-torch) install
    __all__ = [
        "TORCH_AVAILABLE",
        "ValueDistribution",
        "distribution_cvar",
        "distribution_mean",
        "quantile_levels",
        "risk_blended_value",
        "to_value_distribution",
    ]
