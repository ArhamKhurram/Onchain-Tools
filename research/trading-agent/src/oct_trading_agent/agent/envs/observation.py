"""The tier-A (raw-chart) observation — a masked feature vector, missingness never imputed.

Phase 1 is the "naked chart" tier (paper §3.2 Phase A, §5.1): the observation is exactly the
tier-A :class:`~oct_trading_agent.core.features.FeatureBundle` as-of the decision instant — price,
liquidity, volume, trade count, buy/sell imbalance, inter-trade cadence — plus the agent's own
realized position/wealth state, and **nothing else** (no wallet data, no metadata, no text).

The single hard rule this module encodes: **explicit missingness is respected — we feed a mask,
never an imputed value** (paper §3.2; ``core.features`` no-silent-zero invariant). A missing slot
contributes ``0.0`` in the value block *and* ``0.0`` in the mask block; an observed slot contributes
its (transformed) value and ``1.0`` in the mask. A consumer MUST gate on the mask — a masked-off
``0.0`` is not a measured zero. This is why the observation is exposed as three named blocks
(:class:`Observation`), not a single flat vector that would let a learner mistake the two.

Feature transforms are **stateless, monotone, causal** (log of the heavy-tailed magnitudes; the
imbalance passes through in ``[-1, 1]``). They keep the vector numerically sane without any
cross-time or cross-episode statistic — causal per-feature *normalization* (running stats) is a
featurestore/learner concern and is deliberately out of the substrate.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from oct_trading_agent.core import FeatureBundle, FeatureTier

from .spaces import BoxSpace, DictSpace

# Canonical tier-A slot order — matches ``featurestore.default_tier_a_features`` and is STABLE
# (a learned policy encodes against these positions).
TIER_A_SLOTS: tuple[str, ...] = (
    "price",
    "liquidity_quote",
    "rolling_volume_quote",
    "trade_count",
    "buy_sell_imbalance",
    "mean_inter_trade_secs",
)

# Agent-state slots appended after the raw-chart block. All REALIZED (balance moves only on realized
# cash flows + gas); no unrealized/peak mark ever enters here, keeping the observation aligned with
# the reward's realized-only discipline (paper §3.5.4). Order is stable.
STATE_SLOTS: tuple[str, ...] = (
    "has_position",
    "steps_elapsed_frac",
    "balance_ratio",
)

_N_FEATURES = len(TIER_A_SLOTS)
_N_STATE = len(STATE_SLOTS)


def _transform(slot: str, value: float) -> float:
    """Stateless, monotone, causal squashing of an observed slot value.

    ``buy_sell_imbalance`` is already in ``[-1, 1]``; the heavy-tailed magnitudes (price, liquidity,
    volume, count, cadence) get a signed ``log1p`` so their dynamic range is compressed without any
    running statistic. Non-finite inputs collapse to ``0.0`` (defensive; the featurestore should
    never emit them).
    """
    if not np.isfinite(value):
        return 0.0
    if slot == "buy_sell_imbalance":
        return float(value)
    if slot == "price":
        # Prices are tiny positive numbers; a signed log10 keeps them O(1) and monotone.
        return float(np.sign(value) * np.log10(1.0 + abs(value)))
    return float(np.sign(value) * np.log1p(abs(value)))


@dataclass(frozen=True)
class AgentState:
    """The agent's realized, point-in-time state fed into the observation (never unrealized)."""

    has_position: bool
    steps_elapsed_frac: float
    balance_ratio: float


@dataclass(frozen=True)
class Observation:
    """A tier-A observation as three named blocks — values, missingness mask, agent state.

    ``features`` and ``mask`` are aligned to :data:`TIER_A_SLOTS`; ``state`` to :data:`STATE_SLOTS`.
    ``mask[i] == 0.0`` means slot ``i`` was MISSING and ``features[i]`` is a placeholder, not a
    measured value — always branch on the mask. :attr:`bundle` is the raw point-in-time bundle the
    vector was built from, so a policy that prefers to read typed features directly (rather than the
    vector) still can.
    """

    features: np.ndarray  # shape (len(TIER_A_SLOTS),), float32 — masked-missing slots are 0.0
    mask: np.ndarray  # shape (len(TIER_A_SLOTS),), float32 in {0.0, 1.0}
    state: np.ndarray  # shape (len(STATE_SLOTS),), float32
    bundle: FeatureBundle

    def to_vector(self) -> np.ndarray:
        """Flat ``concat(features, mask, state)`` for an RL library that wants a single Box.

        The mask block travels *inside* the vector precisely so the flat form does not silently drop
        the missingness signal — a learner reconstructs which slots were observed from it.
        """
        return np.concatenate([self.features, self.mask, self.state]).astype(np.float32)


def observation_space() -> DictSpace:
    """The observation space: three named boxes (features, mask, state)."""
    return DictSpace(
        spaces={
            "features": BoxSpace(low=(-30.0,) * _N_FEATURES, high=(30.0,) * _N_FEATURES),
            "mask": BoxSpace(low=(0.0,) * _N_FEATURES, high=(1.0,) * _N_FEATURES),
            "state": BoxSpace(low=(0.0, 0.0, 0.0), high=(1.0, 1.0, 1e6)),
        }
    )


def vector_length() -> int:
    """Length of :meth:`Observation.to_vector` (features + mask + state)."""
    return _N_FEATURES + _N_FEATURES + _N_STATE


def encode(bundle: FeatureBundle, state: AgentState) -> Observation:
    """Build an :class:`Observation` from a tier-A bundle and the agent's realized state.

    Missing slots (or absent slots) yield ``0.0`` value + ``0.0`` mask — explicit missingness, never
    an imputed number (paper §3.2). Only ``FeatureStatus.OBSERVED`` slots carry a real value + mask 1.
    """
    features = np.zeros(_N_FEATURES, dtype=np.float32)
    mask = np.zeros(_N_FEATURES, dtype=np.float32)
    for i, slot in enumerate(TIER_A_SLOTS):
        feat = bundle.get(FeatureTier.A_RAW_CHART, slot)
        if feat is not None and feat.observed and isinstance(feat.value, (int, float)):
            features[i] = _transform(slot, float(feat.value))
            mask[i] = 1.0
        # else: leave 0.0 value + 0.0 mask — the missingness is explicit, not imputed.

    state_vec = np.array(
        [
            1.0 if state.has_position else 0.0,
            float(np.clip(state.steps_elapsed_frac, 0.0, 1.0)),
            float(max(0.0, state.balance_ratio)),
        ],
        dtype=np.float32,
    )
    return Observation(features=features, mask=mask, state=state_vec, bundle=bundle)


__all__ = [
    "STATE_SLOTS",
    "TIER_A_SLOTS",
    "AgentState",
    "Observation",
    "encode",
    "observation_space",
    "vector_length",
]
