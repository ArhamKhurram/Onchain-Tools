"""Execution model: ideal fidelity, slippage tolerance, failed txns, MEV, latency determinism."""

from __future__ import annotations

from decimal import Decimal

import numpy as np

from oct_trading_agent.core import FillFailureReason, Intent, Order
from oct_trading_agent.sim.amm.curve import fill_buy
from oct_trading_agent.sim.execution.model import ExecutionModel, ExecutionParams
from tests.conftest import MINT

R_B = Decimal(1_000_000)
R_Q = Decimal(100)


def _order(tol: int | None = None) -> Order:
    return Order(mint=MINT, intent=Intent.OPEN_LONG, size=1.0, slippage_tolerance_bps=tol)


def _rng(seed: int = 0) -> np.random.Generator:
    return np.random.default_rng(seed)


def test_ideal_execution_is_pure_curve() -> None:
    curve = fill_buy(Decimal(10), R_B, R_Q, Decimal("0.0025"))
    model = ExecutionModel(ExecutionParams.ideal(), _rng())
    fill = model.realize(curve, _order())
    assert fill.success
    assert fill.fee_quote == Decimal(0)
    assert fill.mev_penalty_quote == Decimal(0)
    assert fill.latency_ms == 0
    assert fill.executed_price == curve.executed_price
    assert fill.base_amount == curve.base_amount


def test_slippage_tolerance_fails_the_order() -> None:
    # This buy eats ~1000 bps of slippage; a 100-bps tolerance must reject it.
    curve = fill_buy(Decimal(10), R_B, R_Q, Decimal(0))
    model = ExecutionModel(ExecutionParams.ideal(), _rng())
    fill = model.realize(curve, _order(tol=100))
    assert not fill.success
    assert fill.failure_reason is FillFailureReason.SLIPPAGE_EXCEEDED
    assert fill.base_amount == Decimal(0)


def test_tx_failure_burns_gas() -> None:
    params = ExecutionParams(
        tx_fail_prob=1.0, base_fee_quote=Decimal("0.000005"), priority_fee_quote=Decimal("0.001")
    )
    curve = fill_buy(Decimal(1), R_B, R_Q, Decimal("0.0025"))
    fill = ExecutionModel(params, _rng()).realize(curve, _order())
    assert not fill.success
    assert fill.failure_reason is FillFailureReason.TX_FAILED
    assert fill.fee_quote == Decimal("0.001005")  # base + priority, burned on the failed tx


def test_mev_sandwich_can_void_the_fill() -> None:
    params = ExecutionParams(mev_prob=1.0, mev_fail_prob=1.0)
    curve = fill_buy(Decimal(1), R_B, R_Q, Decimal("0.0025"))
    fill = ExecutionModel(params, _rng()).realize(curve, _order())
    assert not fill.success
    assert fill.failure_reason is FillFailureReason.MEV_SANDWICH


def test_mev_penalty_charges_extra_without_voiding() -> None:
    params = ExecutionParams(mev_prob=1.0, mev_fail_prob=0.0, mev_penalty_frac=0.5)
    curve = fill_buy(Decimal(10), R_B, R_Q, Decimal(0))
    fill = ExecutionModel(params, _rng()).realize(curve, _order(tol=100000))
    assert fill.success
    assert fill.mev_penalty_quote > Decimal(0)


def test_latency_is_deterministic_for_a_seed() -> None:
    params = ExecutionParams(base_latency_ms=800, latency_jitter_ms=400)
    curve = fill_buy(Decimal(1), R_B, R_Q, Decimal("0.0025"))
    a = ExecutionModel(params, _rng(42)).realize(curve, _order(tol=100000))
    b = ExecutionModel(params, _rng(42)).realize(curve, _order(tol=100000))
    assert a.latency_ms == b.latency_ms
    assert 400 <= a.latency_ms <= 1200


def test_invalid_params_raise() -> None:
    for bad in (
        {"tx_fail_prob": 1.5},
        {"mev_prob": -0.1},
        {"base_latency_ms": -1},
    ):
        try:
            ExecutionParams(**bad)
        except ValueError:
            continue
        raise AssertionError(f"expected ValueError for {bad}")
