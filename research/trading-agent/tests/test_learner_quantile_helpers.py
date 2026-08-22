"""Distributional-critic numpy helpers (run in the base suite; the torch head is tested separately)."""

from __future__ import annotations

import numpy as np
import pytest

from oct_trading_agent.agent.critics.quantile import (
    distribution_cvar,
    distribution_mean,
    quantile_levels,
    risk_blended_value,
    to_value_distribution,
)


def test_quantile_levels_are_midpoints() -> None:
    taus = quantile_levels(4)
    assert np.allclose(taus, [0.125, 0.375, 0.625, 0.875])


def test_mean_and_cvar() -> None:
    q = np.array([-1.0, 0.0, 1.0, 2.0])
    assert distribution_mean(q) == pytest.approx(0.5)
    # worst 25% (1 of 4) = -1.0
    assert distribution_cvar(q, 0.25) == pytest.approx(-1.0)
    # worst 50% (2 of 4) = mean(-1, 0) = -0.5
    assert distribution_cvar(q, 0.5) == pytest.approx(-0.5)


def test_cvar_is_never_above_mean() -> None:
    rng = np.random.default_rng(0)
    for _ in range(20):
        q = rng.normal(size=16)
        assert distribution_cvar(q, 0.1) <= distribution_mean(q) + 1e-9


def test_risk_blend_endpoints_and_monotonicity() -> None:
    q = np.array([-2.0, -1.0, 0.0, 1.0, 3.0])
    assert risk_blended_value(q, 0.0) == pytest.approx(distribution_mean(q))
    assert risk_blended_value(q, 1.0) == pytest.approx(distribution_cvar(q, 0.05))
    # Increasing risk_beta pulls the value down (more pessimistic).
    from itertools import pairwise

    vals = [risk_blended_value(q, b) for b in (0.0, 0.25, 0.5, 0.75, 1.0)]
    assert all(a >= b - 1e-12 for a, b in pairwise(vals))


def test_risk_beta_out_of_range_raises() -> None:
    with pytest.raises(ValueError):
        risk_blended_value(np.array([0.0]), 1.5)


def test_to_value_distribution_is_valid() -> None:
    vd = to_value_distribution(np.array([-1.0, 0.0, 2.0]))
    assert vd.representation == "quantile"
    assert vd.mean() == pytest.approx((-1.0 + 0.0 + 2.0) / 3)
    assert len(vd.locations) == 3
