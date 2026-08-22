"""RunningNormalizer tests (pure-numpy) — missingness discipline + causal standardization."""

from __future__ import annotations

from datetime import UTC, datetime

import numpy as np

from oct_trading_agent.agent.envs import Observation, vector_length
from oct_trading_agent.agent.envs.observation import STATE_SLOTS, TIER_A_SLOTS
from oct_trading_agent.agent.online.normalize import RunningNormalizer
from oct_trading_agent.core import FeatureBundle

_NF = len(TIER_A_SLOTS)
_NS = len(STATE_SLOTS)


def _obs(features: list[float], mask: list[float], state: list[float]) -> Observation:
    bundle = FeatureBundle(mint="m", as_of=datetime(2026, 8, 22, tzinfo=UTC), tiers={})
    return Observation(
        features=np.array(features, dtype=np.float32),
        mask=np.array(mask, dtype=np.float32),
        state=np.array(state, dtype=np.float32),
        bundle=bundle,
    )


def test_mask_block_passes_through_unchanged() -> None:
    norm = RunningNormalizer()
    obs = _obs([2.0] * _NF, [1.0] * _NF, [1.0, 0.5, 1.0])
    for _ in range(5):
        norm.update(obs)
    out = norm.normalize(obs)
    mask_block = out[_NF : 2 * _NF]
    assert np.allclose(mask_block, obs.mask)  # never standardized


def test_missing_feature_stays_zero_after_normalization() -> None:
    """A masked-off slot must be exactly 0 post-normalize regardless of its placeholder value."""
    norm = RunningNormalizer()
    # Feed observations where slot 0 is always OBSERVED and slot 1 always MISSING.
    for v in (1.0, 2.0, 3.0, 4.0):
        norm.update(_obs([v, 999.0, 0, 0, 0, 0], [1, 0, 1, 1, 1, 1], [0.0, 0.0, 1.0]))
    out = norm.normalize(_obs([5.0, 999.0, 0, 0, 0, 0], [1, 0, 1, 1, 1, 1], [0.0, 0.0, 1.0]))
    assert out[1] == 0.0  # missing slot 1 is gated to exactly 0, not a normalized 999


def test_missing_values_do_not_drag_mean() -> None:
    """Stats for a slot accumulate only when OBSERVED — a run of missing values cannot shift it."""
    norm = RunningNormalizer()
    # slot 0 observed as a constant 10; interleave observations where slot 0 is missing (placeholder 0).
    norm.update(_obs([10.0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1], [0, 0, 1]))
    norm.update(_obs([0.0, 0, 0, 0, 0, 0], [0, 1, 1, 1, 1, 1], [0, 0, 1]))  # slot 0 missing
    norm.update(_obs([10.0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1], [0, 0, 1]))
    state = norm.state_dict()
    # Only the two OBSERVED samples (both 10.0) folded into slot 0.
    assert state.count[0] == 2.0
    assert abs(state.mean[0] - 10.0) < 1e-9


def test_standardization_centers_observed_dim() -> None:
    norm = RunningNormalizer(warmup=2)
    vals = [1.0, 2.0, 3.0, 4.0, 5.0]
    for v in vals:
        norm.update(_obs([v, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1], [0, 0, 1]))
    # A value at the running mean should normalize to ~0 in slot 0.
    out = norm.normalize(_obs([3.0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1], [0, 0, 1]))
    assert abs(float(out[0])) < 0.2


def test_freeze_reload_roundtrips() -> None:
    norm = RunningNormalizer()
    for v in (1.0, 2.0, 3.0):
        norm.update(_obs([v] * _NF, [1] * _NF, [0, 0, 1]))
    snap = norm.state_dict()
    fresh = RunningNormalizer()
    fresh.load_state_dict(snap)
    obs = _obs([2.0] * _NF, [1] * _NF, [0, 0, 1])
    assert np.allclose(norm.normalize(obs), fresh.normalize(obs))


def test_output_length_matches_vector_length() -> None:
    norm = RunningNormalizer()
    obs = _obs([1.0] * _NF, [1] * _NF, [0, 0, 1])
    assert norm.normalize(obs).shape == (vector_length(),)
