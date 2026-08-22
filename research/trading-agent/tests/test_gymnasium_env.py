"""Optional gymnasium-adapter test — skipped unless the ``rl`` extra is installed."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from oct_trading_agent.agent.envs import bonding_curve_sim_config, prepare_bonding_curve_tape
from oct_trading_agent.core import Side, SwapEvent

MINT = "TokenMintPumpFunBonding0000000000000000000000"
T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)


def _tape():  # type: ignore[no-untyped-def]
    swaps = [
        SwapEvent(
            mint=MINT, slot=1000 + i, block_time=T0 + timedelta(seconds=i), signature=f"s{i}",
            signer=f"w{i}", side=Side.BUY, base_amount=Decimal("1900"),
            quote_amount=Decimal("0.00005"), price=Decimal("0.00005") / Decimal("1900"),
            protocol="pumpfun",
        )
        for i in range(6)
    ]
    return prepare_bonding_curve_tape(swaps)


def test_gymnasium_adapter_reset_step() -> None:
    pytest.importorskip("gymnasium", reason="requires the 'rl' extra (gymnasium)")
    from oct_trading_agent.agent.envs import make_gymnasium_env

    env = make_gymnasium_env(
        _tape(), MINT, bonding_curve_sim_config(risk_budget_quote=Decimal("0.01"))
    )
    obs, _info = env.reset()
    assert obs.shape[0] == env.observation_space.shape[0]
    action = env.action_space.sample()
    _obs2, reward, terminated, truncated, _info2 = env.step(action)
    assert isinstance(reward, float)
    assert isinstance(terminated, bool) and isinstance(truncated, bool)
