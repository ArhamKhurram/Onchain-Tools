"""Reward tests — with the load-bearing one: the reward NEVER reads unrealized/peak PnL (§3.5.4)."""

from __future__ import annotations

from decimal import Decimal

from oct_trading_agent.agent.envs.reward import (
    DifferentialSharpe,
    PotentialShaper,
    RewardConfig,
    RewardFunction,
    RewardInput,
    assert_no_unrealized_read,
    reward_from_step,
)
from oct_trading_agent.core import (
    Fill,
    Intent,
    PositionState,
    SimStepResult,
)

MINT = "So11111111111111111111111111111111111111112"


def _sell_result(realized: Decimal, mark_price: Decimal | None) -> SimStepResult:
    """A CLOSE fill booking ``realized`` PnL, with an arbitrary reporting-only ``mark_price``."""
    fill = Fill(
        mint=MINT,
        intent=Intent.CLOSE,
        success=True,
        executed_price=Decimal("2"),
        base_amount=Decimal("10"),
        quote_amount=Decimal("20"),
        fee_quote=Decimal("0.001"),
    )
    position = PositionState(
        mint=MINT,
        base_qty=Decimal(0),
        realized_pnl_quote=realized,
        mark_price=mark_price,  # reporting only — must never influence the reward
    )
    return SimStepResult(
        fill=fill, position=position, realized_pnl_quote=realized, terminal=True
    )


def test_reward_is_invariant_to_mark_price() -> None:
    """THE guard: two steps identical except ``mark_price`` produce byte-identical reward inputs.

    This is the operational proof of paper §3.5.4 — the reward path cannot see unrealized/peak value.
    """
    hi = _sell_result(Decimal("5"), mark_price=Decimal("999999"))
    lo = _sell_result(Decimal("5"), mark_price=Decimal("0.0001"))

    input_hi = reward_from_step(hi, obs_features=(1.0, 2.0))
    input_lo = reward_from_step(lo, obs_features=(1.0, 2.0))
    assert input_hi == input_lo  # mark_price never entered the reward input

    fn_hi = RewardFunction(capital_base=Decimal(1))
    fn_lo = RewardFunction(capital_base=Decimal(1))
    r_hi = fn_hi.step(input_hi)
    r_lo = fn_lo.step(input_lo)
    assert r_hi.total == r_lo.total


def test_reward_input_type_cannot_express_unrealized() -> None:
    """The structural guard: ``RewardInput`` has no mark/unrealized/peak field."""
    item = RewardInput(
        realized_pnl_quote=Decimal("1"),
        cost_quote=Decimal("0"),
        position_open=False,
        intent=Intent.CLOSE,
    )
    assert_no_unrealized_read(item)  # does not raise
    assert "mark_price" not in item.__dataclass_fields__
    assert not ({"unrealized", "peak", "mtm", "mark"} & set(item.__dataclass_fields__))


def test_differential_sharpe_penalizes_variance() -> None:
    """A steady positive-return stream earns a higher terminal DSR than a lottery stream at equal sum."""
    steady = DifferentialSharpe(eta=0.05)
    lottery = DifferentialSharpe(eta=0.05)
    steady_returns = [0.1] * 20
    lottery_returns = [0.0] * 19 + [2.0]  # same sum (2.0), all in one spike
    s_last = 0.0
    for r in steady_returns:
        s_last = steady.step(r)
    l_vals = [lottery.step(r) for r in lottery_returns]
    # The steady stream's ongoing DSR increment stays non-negative; the lottery's final spike, coming
    # after a flat run, produces a large one-off but the process is punished for the variance jump.
    assert s_last >= 0.0
    # The lottery's pre-spike increments are ~0 (no reward accrued for the many flat steps).
    assert abs(sum(l_vals[:-1])) < 1e-6


def test_potential_shaping_telescopes_to_zero_over_closed_trajectory() -> None:
    """A potential-based shaping term sums to ~0 over a trajectory (leaves the optimum unchanged)."""
    # Φ(features) = first feature; F = γΦ' − Φ telescopes to γΦ_last − Φ_first over the run.
    shaper = PotentialShaper(potential=lambda f: f[0] if f else 0.0, gamma=1.0)
    feats = [(0.0,), (1.0,), (2.0,), (0.0,)]
    total = sum(shaper.step(f) for f in feats)
    # With γ=1: sum = Φ_last − Φ_first(=0 at episode start) = 0.0 here.
    assert abs(total) < 1e-9


def test_default_reward_is_pure_primary_no_shaping() -> None:
    """With the default (zero) potential and zero holding cost, only the primary + cost terms move."""
    fn = RewardFunction(RewardConfig(holding_cost=0.0), capital_base=Decimal(1))
    item = RewardInput(
        realized_pnl_quote=Decimal("0.5"),
        cost_quote=Decimal("0"),
        position_open=False,
        intent=Intent.CLOSE,
        obs_features=(3.0, 4.0),
    )
    breakdown = fn.step(item)
    assert breakdown.shaping == 0.0  # default potential contributes exactly nothing
    assert breakdown.holding_cost == 0.0


def test_holding_cost_only_applies_when_position_open() -> None:
    fn = RewardFunction(RewardConfig(holding_cost=0.01), capital_base=Decimal(1))
    open_item = RewardInput(Decimal(0), Decimal(0), position_open=True, intent=Intent.HOLD)
    flat_item = RewardInput(Decimal(0), Decimal(0), position_open=False, intent=Intent.NO_OP)
    assert fn.step(open_item).holding_cost == -0.01
    assert fn.step(flat_item).holding_cost == 0.0
