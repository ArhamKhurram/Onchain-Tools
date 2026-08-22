"""Hawkes teacher tests — recovery on synthetic point processes with KNOWN branching ratios.

The interpretable teacher's correctness is load-bearing (paper §4.5), so it is validated by
simulating tapes whose branching ratio ``n = ρ(α/β)`` is known and checking the estimator recovers
it, plus the standard time-rescaling goodness-of-fit diagnostic (§7.4). All pure numpy — no torch.
"""

from __future__ import annotations

import numpy as np
import pytest

from oct_trading_agent.agent.encoders.hawkes import (
    HawkesParams,
    fit_hawkes,
    simulate_hawkes,
)


@pytest.mark.parametrize("true_n", [0.3, 0.5, 0.7])
def test_univariate_branching_ratio_recovered(true_n: float) -> None:
    """A univariate Hawkes with n=α/β is recovered within tolerance from a long simulated tape."""
    rng = np.random.default_rng(int(true_n * 100))
    mu = np.array([0.5])
    beta = 1.0
    alpha = np.array([[true_n * beta]])
    times, dims = simulate_hawkes(mu, alpha, beta, T=2500.0, rng=rng)
    assert times.shape[0] > 200  # enough events for a stable fit

    fit = fit_hawkes(times, dims, n_dims=1, labels=("buy",), beta=beta)
    assert abs(fit.branching_ratio - true_n) < 0.12
    assert abs(float(fit.params.mu[0]) - 0.5) < 0.15
    assert fit.converged


def test_bivariate_cross_excitation_structure() -> None:
    """Buy self-excites; sell is partly driven by buys. The fitted α matrix reflects that."""
    rng = np.random.default_rng(7)
    mu = np.array([0.4, 0.2])
    beta = 1.0
    # alpha[k, l]: k excited by l. Buy self-excites (0.7), sell excited by buys (0.3).
    alpha = np.array([[0.7, 0.0], [0.3, 0.2]])
    times, dims = simulate_hawkes(mu, alpha, beta, T=2000.0, rng=rng)

    fit = fit_hawkes(times, dims, n_dims=2, beta=beta)
    a = fit.params.alpha
    assert a[0, 0] > 0.45  # buy self-excitation present and dominant
    assert a[1, 0] > 0.15  # buys drive sells
    assert a[0, 1] < 0.2  # sells barely drive buys
    assert 0.0 <= fit.branching_ratio < 1.0


def test_beta_profiling_recovers_decay() -> None:
    """With estimate_beta, the profiled decay lands near the true kernel timescale."""
    rng = np.random.default_rng(3)
    mu = np.array([0.6])
    true_beta = 2.0
    alpha = np.array([[1.0]])  # n = 0.5
    times, dims = simulate_hawkes(mu, alpha, true_beta, T=2500.0, rng=rng)

    fit = fit_hawkes(times, dims, n_dims=1, labels=("buy",), estimate_beta=True)
    # profiled beta within a factor of ~2 of truth, and n still near 0.5
    assert 0.7 < fit.params.beta < 5.0
    assert abs(fit.branching_ratio - 0.5) < 0.2


def test_time_rescaling_goodness_of_fit() -> None:
    """Rescaled inter-event times should be ~Exp(1): mean near 1, and not wildly dispersed."""
    rng = np.random.default_rng(11)
    mu = np.array([0.5])
    beta = 1.0
    alpha = np.array([[0.6]])
    times, dims = simulate_hawkes(mu, alpha, beta, T=3000.0, rng=rng)

    fit = fit_hawkes(times, dims, n_dims=1, labels=("buy",), beta=beta)
    rescaled = fit.rescaled_interevent_times(0)
    assert rescaled.shape[0] > 100
    # Exp(1) has mean 1 and std 1; allow slack for a finite sample and fit noise.
    assert 0.8 < float(np.mean(rescaled)) < 1.25
    assert 0.7 < float(np.std(rescaled)) < 1.4


def test_intensity_is_causal_and_nonnegative() -> None:
    """Intensity at t uses only events strictly before t, and background is the floor."""
    times = np.array([0.0, 1.0, 2.0, 3.0])
    dims = np.array([0, 0, 1, 0])
    fit = fit_hawkes(times, dims, n_dims=2, beta=1.0)

    lam0 = fit.intensity(0.0)  # before any event → pure background
    assert np.allclose(lam0, fit.params.mu)
    lam_mid = fit.intensity(2.5)
    assert np.all(lam_mid >= fit.params.mu - 1e-9)  # excitation only adds
    assert np.all(lam_mid >= 0.0)


def test_branching_ratio_matches_spectral_radius() -> None:
    """The reported n equals the spectral radius of α/β for a hand-built param set."""
    params = HawkesParams(
        mu=np.array([0.1, 0.1]),
        alpha=np.array([[0.4, 0.1], [0.1, 0.4]]),
        beta=1.0,
        labels=("buy", "sell"),
    )
    eig = np.max(np.abs(np.linalg.eigvals(params.alpha / params.beta)))
    assert abs(params.branching_ratio - float(eig)) < 1e-9
    # symmetric [[0.4,0.1],[0.1,0.4]] → spectral radius 0.5
    assert abs(params.branching_ratio - 0.5) < 1e-9


def test_empty_tape_raises() -> None:
    with pytest.raises(ValueError, match="empty tape"):
        fit_hawkes(np.array([]), np.array([]), n_dims=2, beta=1.0)


def test_single_event_is_background_only() -> None:
    """One event can't identify excitation; α collapses toward 0, n≈0."""
    fit = fit_hawkes(np.array([0.0]), np.array([0]), n_dims=1, labels=("buy",), beta=1.0, T=10.0)
    assert fit.branching_ratio < 0.2
    assert fit.params.mu[0] > 0.0


def test_T_must_cover_last_event() -> None:
    with pytest.raises(ValueError, match="T must be"):
        fit_hawkes(np.array([0.0, 5.0]), np.array([0, 0]), n_dims=1, labels=("buy",), T=3.0)


def test_bad_dims_rejected() -> None:
    with pytest.raises(ValueError, match="event_dims"):
        fit_hawkes(np.array([0.0, 1.0]), np.array([0, 5]), n_dims=2, beta=1.0)
