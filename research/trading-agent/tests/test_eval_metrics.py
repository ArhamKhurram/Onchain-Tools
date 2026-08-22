"""Metric-battery tests on known inputs (Sharpe/Sortino/CVaR/drawdown/hit-rate/expectancy)."""

from __future__ import annotations

import numpy as np

from oct_trading_agent.eval.metrics import (
    compute_metrics,
    cvar,
    max_drawdown,
    sharpe,
    sortino,
)


def test_sharpe_zero_variance_is_zero() -> None:
    assert sharpe(np.array([0.1, 0.1, 0.1])) == 0.0


def test_sharpe_sign_follows_mean() -> None:
    assert sharpe(np.array([0.1, -0.05, 0.2, -0.1])) > 0.0
    assert sharpe(np.array([-0.1, 0.05, -0.2, 0.1])) < 0.0


def test_sortino_only_penalizes_downside() -> None:
    # Same mean, but the second series has larger downside deviation -> smaller Sortino.
    mild = np.array([0.1, 0.1, -0.05])
    harsh = np.array([0.3, 0.1, -0.25])
    assert sortino(mild) > sortino(harsh)


def test_cvar_is_the_left_tail_mean() -> None:
    r = np.array([-1.0, -0.5, 0.0, 0.5, 1.0])
    assert cvar(r, alpha=0.2) == -1.0  # worst 20% is the single -1.0
    assert cvar(r, alpha=0.4) == -0.75  # worst 40% is mean(-1.0, -0.5)


def test_max_drawdown_on_known_curve() -> None:
    curve = np.array([1.0, 1.5, 0.75, 1.2])  # peak 1.5 -> trough 0.75 = 50% dd
    assert abs(max_drawdown(curve) - 0.5) < 1e-9


def test_compute_metrics_hit_rate_and_expectancy() -> None:
    r = np.array([0.2, -0.1, 0.3, -0.4])
    report = compute_metrics(r)
    assert report.n_returns == 4
    assert abs(report.hit_rate - 0.5) < 1e-9
    # expectancy decomposition equals the plain mean
    assert abs(report.expectancy - r.mean()) < 1e-9
    assert abs(report.total_return - r.sum()) < 1e-9


def test_empty_returns_are_all_zero() -> None:
    report = compute_metrics(np.array([]))
    assert report.n_returns == 0
    assert report.sharpe == 0.0 and report.max_drawdown == 0.0
