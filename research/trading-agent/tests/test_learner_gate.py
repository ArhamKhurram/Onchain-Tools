"""Phase-1 gate verdict logic (pure; runs without torch). GO / NO-GO / INCONCLUSIVE are all valid."""

from __future__ import annotations

from oct_trading_agent.agent.train import phase1_gate
from oct_trading_agent.eval.metrics import MetricReport
from oct_trading_agent.eval.runner import PolicyEvaluation


def _eval(name: str, *, mean_return: float, sharpe: float) -> PolicyEvaluation:
    report = MetricReport(
        n_returns=8,
        mean_return=mean_return,
        median_return=mean_return,
        std_return=0.1,
        total_return=mean_return * 8,
        sharpe=sharpe,
        sortino=sharpe,
        cvar=-0.1,
        cvar_alpha=0.05,
        max_drawdown=0.1,
        hit_rate=0.5,
        win_rate=0.5,
        avg_win=0.1,
        avg_loss=-0.1,
        expectancy=mean_return,
        skew=0.0,
        kurtosis=0.0,
    )
    return PolicyEvaluation(policy_name=name, outcomes=[], metrics=report)


def test_go_when_beats_both_and_guard_passes() -> None:
    agent = _eval("agent", mean_return=0.05, sharpe=0.4)
    hold = _eval("hold_sol", mean_return=0.0, sharpe=0.0)
    buy = _eval("buy_and_hold", mean_return=0.01, sharpe=0.1)
    v = phase1_gate(
        agent, hold, buy,
        edge_vs_hold_sol=(0.75, 0.05),
        edge_vs_buy_and_hold=(0.63, 0.04),
        noised_agent_shows_edge=False,  # edge collapsed under noise
    )
    assert v.verdict == "GO"
    assert v.beats_hold_sol and v.beats_buy_and_hold and v.leakage_guard_passed


def test_no_go_when_no_edge() -> None:
    agent = _eval("agent", mean_return=-0.02, sharpe=-0.3)
    hold = _eval("hold_sol", mean_return=0.0, sharpe=0.0)
    buy = _eval("buy_and_hold", mean_return=0.01, sharpe=0.1)
    v = phase1_gate(
        agent, hold, buy,
        edge_vs_hold_sol=(0.2, -0.02),
        edge_vs_buy_and_hold=(0.3, -0.03),
        noised_agent_shows_edge=False,
    )
    assert v.verdict == "NO-GO"
    assert not v.beats_hold_sol


def test_inconclusive_when_beats_both_but_guard_fails() -> None:
    """Beating both baselines but the noised agent ALSO beats them = suspect leakage, not a GO."""
    agent = _eval("agent", mean_return=0.05, sharpe=0.4)
    hold = _eval("hold_sol", mean_return=0.0, sharpe=0.0)
    buy = _eval("buy_and_hold", mean_return=0.01, sharpe=0.1)
    v = phase1_gate(
        agent, hold, buy,
        edge_vs_hold_sol=(0.75, 0.05),
        edge_vs_buy_and_hold=(0.63, 0.04),
        noised_agent_shows_edge=True,  # did NOT collapse -> suspicious
    )
    assert v.verdict == "INCONCLUSIVE"
    assert not v.leakage_guard_passed


def test_inconclusive_when_guard_not_run() -> None:
    agent = _eval("agent", mean_return=0.05, sharpe=0.4)
    hold = _eval("hold_sol", mean_return=0.0, sharpe=0.0)
    buy = _eval("buy_and_hold", mean_return=0.01, sharpe=0.1)
    v = phase1_gate(
        agent, hold, buy,
        edge_vs_hold_sol=(0.75, 0.05),
        edge_vs_buy_and_hold=(0.63, 0.04),
        noised_agent_shows_edge=None,  # guard not run
    )
    assert v.verdict == "INCONCLUSIVE"
    assert not v.leakage_guard_passed


def test_higher_mean_but_worse_sharpe_does_not_beat() -> None:
    """The lottery tell: a higher mean with a worse risk profile must not count as a beat (§8.3)."""
    agent = _eval("agent", mean_return=0.10, sharpe=-0.5)  # high mean, terrible Sharpe
    hold = _eval("hold_sol", mean_return=0.0, sharpe=0.0)
    buy = _eval("buy_and_hold", mean_return=0.01, sharpe=0.1)
    v = phase1_gate(
        agent, hold, buy,
        edge_vs_hold_sol=(0.9, 0.10),
        edge_vs_buy_and_hold=(0.9, 0.09),
        noised_agent_shows_edge=False,
    )
    assert not v.beats_hold_sol  # Sharpe gate blocks it
    assert v.verdict == "NO-GO"
