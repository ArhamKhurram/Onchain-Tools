"""Causal running normalization of the observation vector — a *learner* concern, kept pure-numpy.

The Phase-1 observation (``observation.py``) deliberately ships stateless, monotone transforms only:
cross-time normalization "is a featurestore/learner concern and is deliberately out of the
substrate." This module is that learner-side piece. It maintains a **causal** running mean/variance
(Welford) over the observation vector and standardizes it, so the policy/critic see O(1) inputs
without any look-ahead.

Two invariants make it honest for a walk-forward learner:

* **Missingness is never normalized into a fake signal.** The observation vector is
  ``concat(features, mask, state)``; the mask block is 0/1 by construction and is passed through
  untouched (its indices are excluded from the running stats and from standardization). A missing
  feature slot (value ``0.0`` under mask ``0.0``) is *also* excluded from the mean/var update — we
  only accumulate statistics over slots the mask marks OBSERVED — so a run of missing values can
  never drag the normalizer's mean toward zero and disguise itself as a measured zero.
* **Update is train-only; eval is frozen.** :meth:`update` is called during rollout collection;
  at evaluation the caller calls :meth:`normalize` only (no update), so a held-out episode never
  shifts the statistics it is scored against. Freeze/serialize via :meth:`state_dict`.

This is intentionally not torch — the RL math (normalization, GAE) stays testable in the base suite
with no heavy dependency; only the neural policy/critic need the ``learn`` extra.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from oct_trading_agent.agent.envs import Observation, vector_length
from oct_trading_agent.agent.envs.observation import STATE_SLOTS, TIER_A_SLOTS

_N_FEATURES = len(TIER_A_SLOTS)
_N_STATE = len(STATE_SLOTS)


def _mask_block_slice() -> slice:
    """Indices of the mask block inside ``concat(features, mask, state)`` — never normalized."""
    return slice(_N_FEATURES, 2 * _N_FEATURES)


@dataclass
class NormalizerState:
    """Serializable snapshot of a :class:`RunningNormalizer` (for freeze / reload across a run)."""

    count: np.ndarray  # per-dim observation count (float64), shape (D,)
    mean: np.ndarray  # running mean, shape (D,)
    m2: np.ndarray  # running sum of squared deviations, shape (D,)


class RunningNormalizer:
    """Per-dimension causal standardizer of the flat observation vector (Welford, missing-aware).

    ``D = vector_length()``. The mask block indices are excluded from both the update and the
    standardization (passed through as raw 0/1). For a value/state slot, a sample is folded into the
    running stats only when it is *present* — for the feature block that means its paired mask bit is
    1; the state block is always present. Standardization uses ``(x - mean) / sqrt(var + eps)`` with a
    per-dim count-gated fallback to the raw value until enough samples exist.
    """

    def __init__(self, *, eps: float = 1e-6, clip: float = 10.0, warmup: int = 2) -> None:
        d = vector_length()
        self._d = d
        self._eps = eps
        self._clip = clip
        self._warmup = max(1, warmup)
        self._mask_slice = _mask_block_slice()
        self._count = np.zeros(d, dtype=np.float64)
        self._mean = np.zeros(d, dtype=np.float64)
        self._m2 = np.zeros(d, dtype=np.float64)

    def _present_mask(self, vector: np.ndarray, feature_mask: np.ndarray) -> np.ndarray:
        """Boolean vector of which dims to fold in: observed features + all state; never the mask block."""
        present = np.ones(self._d, dtype=bool)
        # Feature block: present only where the observation mask says OBSERVED.
        present[:_N_FEATURES] = feature_mask.astype(bool)
        # Mask block: never accumulate (it is the missingness signal itself).
        present[self._mask_slice] = False
        return present

    def update(self, observation: Observation) -> None:
        """Fold one observation into the running statistics (train-time only)."""
        vec = observation.to_vector().astype(np.float64)
        present = self._present_mask(vec, observation.mask)
        idx = np.where(present)[0]
        if idx.size == 0:
            return
        self._count[idx] += 1.0
        delta = vec[idx] - self._mean[idx]
        self._mean[idx] += delta / self._count[idx]
        delta2 = vec[idx] - self._mean[idx]
        self._m2[idx] += delta * delta2

    def normalize(self, observation: Observation) -> np.ndarray:
        """Return the standardized flat vector (no update). Mask block passes through as raw 0/1."""
        vec = observation.to_vector().astype(np.float64)
        out = vec.copy()
        # Standardize only dims with enough samples; leave the mask block and cold dims as-is.
        var = np.where(self._count > 1.0, self._m2 / np.maximum(self._count - 1.0, 1.0), 1.0)
        std = np.sqrt(var + self._eps)
        ready = self._count >= self._warmup
        ready[self._mask_slice] = False  # mask block never standardized
        norm = (vec - self._mean) / std
        out = np.where(ready, norm, out)
        out = np.clip(out, -self._clip, self._clip)
        # Feature block: re-apply the missingness gate so a standardized *missing* placeholder can
        # never present as a real value — a missing slot stays exactly 0.0 post-normalization.
        gated = out.copy()
        gated[:_N_FEATURES] = out[:_N_FEATURES] * observation.mask
        return gated.astype(np.float32)

    def state_dict(self) -> NormalizerState:
        return NormalizerState(
            count=self._count.copy(), mean=self._mean.copy(), m2=self._m2.copy()
        )

    def load_state_dict(self, state: NormalizerState) -> None:
        self._count = state.count.copy()
        self._mean = state.mean.copy()
        self._m2 = state.m2.copy()


__all__ = ["NormalizerState", "RunningNormalizer"]
