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
from typing import TYPE_CHECKING

import numpy as np

from oct_trading_agent.core import FeatureBundle, FeatureTier

from .spaces import BoxSpace, DictSpace

if TYPE_CHECKING:
    from oct_trading_agent.agent.encoders.tracker import AttentionFeatures

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

# OPTIONAL tier-A+ attention slots (paper §4.4), appended AFTER the tier-A block when the env's
# ``attention_features`` flag is on — flag-off observations are byte-identical to before. The three
# travel as ONE unit sharing one missingness state: λ/n are never observable without the mandatory
# manipulation-suspicion companion (§9.10), and all three are masked before the first fit window.
ATTENTION_SLOTS: tuple[str, ...] = (
    "attn_lambda_buy_ratio",  # λ_buy(t)/μ_buy — the attention chart, baseline-normalized
    "attn_branching_n",  # attention-momentum scalar n (raw; ≥1 = explosive, honestly reported)
    "attn_suspicion",  # the mandatory authenticity channel, [0, 1]
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
_N_ATTENTION = len(ATTENTION_SLOTS)
_N_STATE = len(STATE_SLOTS)


def _n_features(*, attention: bool) -> int:
    """Feature-block width: tier-A alone, or tier-A plus the optional attention slots."""
    return _N_FEATURES + (_N_ATTENTION if attention else 0)


def _transform(slot: str, value: float) -> float:
    """Stateless, monotone, causal squashing of an observed slot value.

    ``buy_sell_imbalance`` and ``attn_suspicion`` are already bounded and pass through; the
    heavy-tailed magnitudes (price, liquidity, volume, count, cadence, the λ/μ ratio, and the
    branching ratio — which may exceed 1 and stays monotone through the squash) get a signed
    ``log1p`` so their dynamic range is compressed without any running statistic. Non-finite
    inputs collapse to ``0.0`` (defensive; the featurestore should never emit them).
    """
    if not np.isfinite(value):
        return 0.0
    if slot in ("buy_sell_imbalance", "attn_suspicion"):
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

    ``features`` and ``mask`` are aligned to :data:`TIER_A_SLOTS` (followed by
    :data:`ATTENTION_SLOTS` when the env's ``attention_features`` flag is on); ``state`` to
    :data:`STATE_SLOTS`.
    ``mask[i] == 0.0`` means slot ``i`` was MISSING and ``features[i]`` is a placeholder, not a
    measured value — always branch on the mask. :attr:`bundle` is the raw point-in-time bundle the
    vector was built from, so a policy that prefers to read typed features directly (rather than the
    vector) still can.
    """

    features: np.ndarray  # shape (n_feature_slots,), float32 — masked-missing slots are 0.0
    mask: np.ndarray  # shape (n_feature_slots,), float32 in {0.0, 1.0}
    state: np.ndarray  # shape (len(STATE_SLOTS),), float32
    bundle: FeatureBundle

    def to_vector(self) -> np.ndarray:
        """Flat ``concat(features, mask, state)`` for an RL library that wants a single Box.

        The mask block travels *inside* the vector precisely so the flat form does not silently drop
        the missingness signal — a learner reconstructs which slots were observed from it.
        """
        return np.concatenate([self.features, self.mask, self.state]).astype(np.float32)


def observation_space(*, attention: bool = False) -> DictSpace:
    """The observation space: three named boxes (features, mask, state).

    ``attention=True`` widens the feature/mask boxes by the tier-A+ attention slots — the shape the
    env advertises when its ``attention_features`` flag is on.
    """
    n = _n_features(attention=attention)
    return DictSpace(
        spaces={
            "features": BoxSpace(low=(-30.0,) * n, high=(30.0,) * n),
            "mask": BoxSpace(low=(0.0,) * n, high=(1.0,) * n),
            "state": BoxSpace(low=(0.0, 0.0, 0.0), high=(1.0, 1.0, 1e6)),
        }
    )


def vector_length(*, attention: bool = False) -> int:
    """Length of :meth:`Observation.to_vector` (features + mask + state) for the chosen tier."""
    n = _n_features(attention=attention)
    return n + n + _N_STATE


def encode(
    bundle: FeatureBundle,
    state: AgentState,
    *,
    attention: AttentionFeatures | None = None,
) -> Observation:
    """Build an :class:`Observation` from a tier-A bundle and the agent's realized state.

    Missing slots (or absent slots) yield ``0.0`` value + ``0.0`` mask — explicit missingness, never
    an imputed number (paper §3.2). Only ``FeatureStatus.OBSERVED`` slots carry a real value + mask 1.

    ``attention`` (tier-A+, paper §4.4) appends the :data:`ATTENTION_SLOTS` block: pass ``None``
    (the default) for the unchanged tier-A observation, or an
    :class:`~oct_trading_agent.agent.encoders.tracker.AttentionFeatures` to widen the observation —
    masked as one unit while ``attention.observed`` is ``False`` (the honest pre-fit-window
    missingness), valued + mask 1 once the tracker has enough events.
    """
    n_feat = _n_features(attention=attention is not None)
    features = np.zeros(n_feat, dtype=np.float32)
    mask = np.zeros(n_feat, dtype=np.float32)
    for i, slot in enumerate(TIER_A_SLOTS):
        feat = bundle.get(FeatureTier.A_RAW_CHART, slot)
        if feat is not None and feat.observed and isinstance(feat.value, (int, float)):
            features[i] = _transform(slot, float(feat.value))
            mask[i] = 1.0
        # else: leave 0.0 value + 0.0 mask — the missingness is explicit, not imputed.

    if attention is not None and attention.observed:
        att_values = (
            attention.lambda_buy_ratio,
            attention.branching_ratio_n,
            attention.suspicion,
        )
        for j, (slot, value) in enumerate(zip(ATTENTION_SLOTS, att_values, strict=True)):
            features[_N_FEATURES + j] = _transform(slot, float(value))
            mask[_N_FEATURES + j] = 1.0
    # else (attention supplied but not yet observed): the three slots stay 0.0/0.0 as one
    # masked-missing unit — λ/n never appear without their suspicion companion (§9.10).

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
    "ATTENTION_SLOTS",
    "STATE_SLOTS",
    "TIER_A_SLOTS",
    "AgentState",
    "Observation",
    "encode",
    "observation_space",
    "vector_length",
]
