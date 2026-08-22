"""Manipulation-suspicion channel tests (paper §4.4, §9.10) — pure numpy.

The channel must (a) separate organic from manufactured flow on its component heuristics, and
(b) always produce a finite aggregate in [0, 1] — it is the mandatory authenticity companion that
the attention state never ships without.
"""

from __future__ import annotations

import numpy as np

from oct_trading_agent.agent.encoders.manipulation import (
    assess_manipulation,
    benford_suspicion,
    breadth_deficit_suspicion,
    buyer_concentration,
    first_significant_digits,
    herfindahl,
    round_number_suspicion,
)


def _benford_sample(n: int, rng: np.random.Generator) -> np.ndarray:
    """Draw sizes whose leading digits follow Benford's law (log-uniform magnitudes)."""
    return np.power(10.0, rng.uniform(-1.0, 4.0, size=n))


def test_first_significant_digits() -> None:
    d = first_significant_digits(np.array([1.0, 2.5, 0.03, 900.0, 0.0, -7.0]))
    # 1.0->1, 2.5->2, 0.03->3, 900->9, 0 dropped, -7->7
    assert list(d) == [1, 2, 3, 9, 7]


def test_benford_low_for_organic_high_for_uniform() -> None:
    rng = np.random.default_rng(0)
    organic = _benford_sample(2000, rng)
    # uniform leading digits: build sizes with digits ~uniform 1..9
    digits = rng.integers(1, 10, size=2000).astype(float)
    uniform_sizes = digits * np.power(10.0, rng.integers(-1, 4, size=2000))
    assert benford_suspicion(organic) < 0.3
    assert benford_suspicion(uniform_sizes) > benford_suspicion(organic)


def test_benford_abstains_below_min_samples() -> None:
    assert benford_suspicion(np.array([1.0, 2.0, 3.0])) == 0.0


def test_round_number_suspicion() -> None:
    round_sizes = np.array([1.0, 2.0, 5.0, 10.0, 0.5, 100.0, 250.0])
    messy = np.array([1.37, 2.83, 4.19, 0.66, 7.41, 3.02, 8.88])
    assert round_number_suspicion(round_sizes) > 0.8
    assert round_number_suspicion(messy) < 0.3


def test_breadth_deficit() -> None:
    # many buys, few wallets → high suspicion
    assert breadth_deficit_suspicion(unique_buyers=3, n_buys=100) > 0.9
    # broad participation → low suspicion
    assert breadth_deficit_suspicion(unique_buyers=90, n_buys=100) < 0.15
    # too few buys → abstain
    assert breadth_deficit_suspicion(unique_buyers=1, n_buys=3) == 0.0


def test_concentration_gini_extremes() -> None:
    # one wallet holds all volume → high concentration
    assert buyer_concentration(np.array([100.0, 0.0, 0.0, 0.0])) > 0.7
    # perfectly even → low concentration
    assert buyer_concentration(np.array([10.0, 10.0, 10.0, 10.0])) < 0.05


def test_herfindahl_range() -> None:
    assert abs(herfindahl(np.array([1.0, 1.0, 1.0, 1.0])) - 0.25) < 1e-9
    assert herfindahl(np.array([1.0, 0.0, 0.0])) == 1.0
    assert herfindahl(np.array([0.0, 0.0])) == 0.0


def test_assess_organic_vs_wash() -> None:
    rng = np.random.default_rng(5)
    # organic: many distinct buyers, benford-ish messy sizes, spread volume
    n = 300
    organic_ids = np.arange(n)  # all distinct
    organic_sizes = _benford_sample(n, rng)
    organic = assess_manipulation(
        buy_sizes=organic_sizes, buyer_ids=organic_ids, all_sizes=organic_sizes
    )

    # wash: 3 wallets churn, round sizes, concentrated
    wash_ids = rng.integers(0, 3, size=n)
    wash_sizes = rng.choice([1.0, 2.0, 5.0], size=n)
    wash = assess_manipulation(
        buy_sizes=wash_sizes, buyer_ids=wash_ids, all_sizes=wash_sizes, creator_volume_share=0.5
    )

    assert 0.0 <= organic.suspicion <= 1.0
    assert 0.0 <= wash.suspicion <= 1.0
    assert wash.suspicion > organic.suspicion + 0.3
    assert organic.unique_buyers == n
    assert wash.unique_buyers <= 3


def test_assess_is_always_finite_and_bounded() -> None:
    # degenerate empty input must still produce a finite score (the channel never goes missing)
    r = assess_manipulation(buy_sizes=np.array([]), buyer_ids=np.array([]))
    assert np.isfinite(r.suspicion)
    assert 0.0 <= r.suspicion <= 1.0
    assert r.unique_buyers == 0
    assert r.n_buys == 0
