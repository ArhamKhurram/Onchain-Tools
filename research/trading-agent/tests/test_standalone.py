"""Standalone "attention is igniting" signal tests (paper §4.4 point 3, §6.3) — pure numpy.

The alert is a conjunction (rising λ_buy ∧ broadening buyers ∧ n→1 ∧ LOW manipulation), and the
authenticity gate is mandatory: a high λ with high manipulation-suspicion must never fire.
"""

from __future__ import annotations

from datetime import UTC, datetime

from oct_trading_agent.agent.encoders.standalone import (
    IgnitionThresholds,
    evaluate_ignition,
    is_igniting,
)
from oct_trading_agent.core.attention import AttentionState

T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)


def _state(
    *,
    lam_buy: float,
    lam_sell: float,
    n: float,
    breadth: int,
    manip: float,
    score: float = 0.5,
) -> AttentionState:
    return AttentionState(
        mint="MintX",
        as_of=T0,
        lambda_buy=lam_buy,
        lambda_sell=lam_sell,
        branching_ratio_n=n,
        unique_buyer_breadth=breadth,
        concentration=0.1,
        manipulation_suspicion=manip,
        embedding=[0.0] * 4,
        calibrated_score=score,
    )


def test_clean_ignition_fires() -> None:
    s = _state(lam_buy=3.0, lam_sell=1.0, n=0.9, breadth=40, manip=0.1)
    sig = evaluate_ignition(s)
    assert sig.igniting is True
    assert sig.strength > 0.0
    assert sig.low_manipulation and sig.rising_lambda_buy and sig.broadening_buyers
    assert sig.n_near_critical


def test_high_manipulation_suppresses_ignition() -> None:
    # identical attention but wash-suspect → must be suppressed (paper §9.10)
    s = _state(lam_buy=3.0, lam_sell=1.0, n=0.9, breadth=40, manip=0.8)
    sig = evaluate_ignition(s)
    assert sig.igniting is False
    assert sig.strength == 0.0
    assert "suppressed" in sig.reason


def test_low_breadth_not_igniting() -> None:
    s = _state(lam_buy=3.0, lam_sell=1.0, n=0.9, breadth=3, manip=0.1)
    sig = evaluate_ignition(s)
    assert sig.igniting is False
    assert not sig.broadening_buyers


def test_n_outside_band_not_igniting() -> None:
    # n well below the near-critical band
    s = _state(lam_buy=3.0, lam_sell=1.0, n=0.2, breadth=40, manip=0.1)
    assert not evaluate_ignition(s).n_near_critical
    # n explosive (past the high edge) also not "igniting"
    s2 = _state(lam_buy=3.0, lam_sell=1.0, n=1.6, breadth=40, manip=0.1)
    assert not evaluate_ignition(s2).n_near_critical


def test_sell_dominant_not_rising() -> None:
    s = _state(lam_buy=1.0, lam_sell=3.0, n=0.9, breadth=40, manip=0.1)
    assert not evaluate_ignition(s).rising_lambda_buy


def test_history_requires_strict_increase() -> None:
    prev = _state(lam_buy=3.0, lam_sell=1.0, n=0.9, breadth=40, manip=0.1)
    # not rising vs previous (same λ_buy, same breadth, same n)
    flat = _state(lam_buy=3.0, lam_sell=1.0, n=0.9, breadth=40, manip=0.1)
    sig = evaluate_ignition(flat, previous=prev)
    assert sig.igniting is False

    rising = _state(lam_buy=4.0, lam_sell=1.0, n=0.95, breadth=55, manip=0.1)
    sig2 = evaluate_ignition(rising, previous=prev)
    assert sig2.igniting is True


def test_is_igniting_wrapper_and_thresholds() -> None:
    s = _state(lam_buy=3.0, lam_sell=1.0, n=0.9, breadth=15, manip=0.3)
    assert is_igniting(s) is True
    strict = IgnitionThresholds(min_unique_buyers=50, max_manipulation=0.1)
    assert is_igniting(s, thresholds=strict) is False
