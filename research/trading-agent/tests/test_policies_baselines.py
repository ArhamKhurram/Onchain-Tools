"""Policy-seam + baseline tests: random determinism, the EnvPolicy protocol, and the core adapter."""

from __future__ import annotations

from datetime import UTC, datetime

from oct_trading_agent.agent import HoldPolicy
from oct_trading_agent.agent.envs.observation import AgentState, encode
from oct_trading_agent.agent.policies import CorePolicyAdapter, EnvPolicy, RandomPolicy
from oct_trading_agent.core import (
    Feature,
    FeatureBundle,
    FeatureStatus,
    FeatureTier,
    Intent,
)
from oct_trading_agent.eval.baselines import BuyAndHoldPolicy, HoldSolPolicy

MINT = "So11111111111111111111111111111111111111112"
T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)


def _obs():  # type: ignore[no-untyped-def]
    slots = {"price": Feature(value=0.001, status=FeatureStatus.OBSERVED, as_of=T0)}
    bundle = FeatureBundle(mint=MINT, as_of=T0, tiers={FeatureTier.A_RAW_CHART: slots})
    return encode(bundle, AgentState(has_position=False, steps_elapsed_frac=0.0, balance_ratio=1.0))


def test_random_policy_is_reproducible() -> None:
    a = RandomPolicy(seed=42)
    b = RandomPolicy(seed=42)
    obs = _obs()
    seq_a = [a.act(obs) for _ in range(20)]
    seq_b = [b.act(obs) for _ in range(20)]
    assert seq_a == seq_b


def test_random_policy_reset_restarts_stream() -> None:
    p = RandomPolicy(seed=1)
    obs = _obs()
    first = [p.act(obs) for _ in range(5)]
    p.reset()
    again = [p.act(obs) for _ in range(5)]
    assert first == again


def test_baselines_satisfy_env_policy_protocol() -> None:
    assert isinstance(RandomPolicy(), EnvPolicy)
    assert isinstance(HoldSolPolicy(), EnvPolicy)
    assert isinstance(BuyAndHoldPolicy(), EnvPolicy)
    assert isinstance(CorePolicyAdapter(HoldPolicy()), EnvPolicy)


def test_hold_sol_always_no_op() -> None:
    p = HoldSolPolicy()
    obs = _obs()
    assert all(p.act(obs).intent is Intent.NO_OP for _ in range(5))


def test_buy_and_hold_enters_once_then_holds() -> None:
    p = BuyAndHoldPolicy(size=1.0)
    obs = _obs()
    first = p.act(obs)
    rest = [p.act(obs) for _ in range(4)]
    assert first.intent is Intent.OPEN_LONG
    assert all(a.intent is Intent.HOLD for a in rest)
    p.reset()
    assert p.act(obs).intent is Intent.OPEN_LONG  # reset re-arms the single entry


def test_core_policy_adapter_bridges_bundle_to_action() -> None:
    adapter = CorePolicyAdapter(HoldPolicy())
    action = adapter.act(_obs())
    assert action.intent is Intent.HOLD  # HoldPolicy always HOLDs
    assert action.size == 0.0
