"""End-to-end proof test: the whole substrate runs on the real bonding-curve fixture (offline)."""

from __future__ import annotations

from decimal import Decimal

from oct_trading_agent.eval.baselines import BuyAndHoldPolicy, HoldSolPolicy, RandomPolicy
from oct_trading_agent.eval.data import load_bonding_curve_fixture
from oct_trading_agent.eval.proof import build_envs, format_proof, run_proof
from oct_trading_agent.eval.runner import evaluate_policy, per_token_edge


def test_fixture_loads_real_bonding_curve_swaps() -> None:
    tape = load_bonding_curve_fixture()
    assert tape.n_swaps > 0
    assert tape.source.startswith("fixture:")
    # first swap sits at (or near) the pump.fun seed price — a token captured from birth
    assert tape.swaps[0].price is not None


def test_proof_runs_end_to_end_and_certifies_causality() -> None:
    result = run_proof(live=False, n_windows=6)
    assert result.causal_certified is True
    assert set(result.evaluations) == {"hold_sol", "buy_and_hold", "random"}
    # every policy produced one return per window
    for evaluation in result.evaluations.values():
        assert evaluation.metrics.n_returns == result.n_windows
    # hold-SOL never trades -> zero realized -> zero-return metrics (patience is not taxed)
    assert result.evaluations["hold_sol"].metrics.total_return == 0.0


def test_baselines_run_through_the_same_envs_apples_to_apples() -> None:
    tape = load_bonding_curve_fixture()
    hold = evaluate_policy(build_envs(tape, n_windows=4), HoldSolPolicy(), "hold_sol")
    bah = evaluate_policy(build_envs(tape, n_windows=4), BuyAndHoldPolicy(), "buy_and_hold")
    rand = evaluate_policy(build_envs(tape, n_windows=4), RandomPolicy(seed=3), "random")
    assert hold.metrics.n_returns == bah.metrics.n_returns == rand.metrics.n_returns == 4
    # buy-and-hold actually trades (enters + forced exit); hold-SOL never does.
    assert bah.metrics.turnover > 0
    assert hold.metrics.turnover == 0
    edge = per_token_edge(rand, hold)
    assert 0.0 <= edge.fraction_beaten <= 1.0


def test_format_proof_is_ascii_renderable() -> None:
    result = run_proof(live=False, n_windows=4)
    text = format_proof(result)
    text.encode("ascii")  # must not raise — the report is Windows-console safe
    assert "substrate" in text.lower()


def test_build_envs_share_initial_balance() -> None:
    tape = load_bonding_curve_fixture()
    envs = build_envs(tape, n_windows=3, initial_balance_quote=Decimal(2))
    assert all(env.config.initial_balance_quote == Decimal(2) for env in envs)
