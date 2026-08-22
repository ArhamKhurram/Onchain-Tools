"""Torch-gated learner tests — skipped without the 'learn' extra. Kept tiny/synthetic (no network)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import numpy as np
import pytest

from oct_trading_agent.core import Side, SwapEvent
from oct_trading_agent.eval.data import TokenTape

MINT = "TokenMintPumpFunBondingLearnerTest0000000000"
T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)


def _swap(i: int, side: Side, base: str, quote: str) -> SwapEvent:
    return SwapEvent(
        mint=MINT,
        slot=1000 + i,
        block_time=T0 + timedelta(seconds=i),
        signature=f"s{i}",
        signer=f"w{i % 8}",
        side=side,
        base_amount=Decimal(base),
        quote_amount=Decimal(quote),
        price=Decimal(quote) / Decimal(base),
        protocol="pumpfun",
    )


def _synthetic_tape(n: int = 60) -> TokenTape:
    """A small deterministic pump.fun-style tape: mostly buys with rising quote size."""
    swaps = []
    for i in range(n):
        side = Side.BUY if i % 4 != 3 else Side.SELL
        q = 0.00004 + 0.0000005 * i
        swaps.append(_swap(i, side, "1900", f"{q:.8f}"))
    return TokenTape(mint=MINT, swaps=swaps, source="synthetic")


def test_actor_critic_forward_shapes() -> None:
    torch = pytest.importorskip("torch")
    from oct_trading_agent.agent.envs import vector_length
    from oct_trading_agent.agent.policies.torch_actor import ActorConfig, build_actor_critic

    torch.manual_seed(0)
    model = build_actor_critic(ActorConfig(hidden_dim=16, n_quantiles=6))
    obs = torch.zeros(4, vector_length())
    out = model.forward(obs)
    assert out.intent_logits.shape == (4, 6)  # 6 intents
    assert out.size_alpha.shape == (4,)
    assert (out.size_alpha >= 1.0).all() and (out.size_beta >= 1.0).all()
    assert out.quantiles.shape == (4, 6)


def test_evaluate_actions_finite() -> None:
    torch = pytest.importorskip("torch")
    from oct_trading_agent.agent.envs import vector_length
    from oct_trading_agent.agent.policies.torch_actor import ActorConfig, build_actor_critic

    torch.manual_seed(0)
    model = build_actor_critic(ActorConfig(hidden_dim=16))
    obs = torch.randn(5, vector_length())
    intents = torch.randint(0, 6, (5,))
    sizes = torch.rand(5)
    logp, entropy, quantiles = model.evaluate_actions(obs, intents, sizes)
    assert torch.isfinite(logp).all()
    assert torch.isfinite(entropy).all()
    assert quantiles.shape[0] == 5


def test_mask_gating_missing_feature_has_no_effect() -> None:
    """Two observations differing ONLY in a masked-off slot must produce identical actions/values."""
    torch = pytest.importorskip("torch")
    from oct_trading_agent.agent.envs import Observation
    from oct_trading_agent.agent.policies.torch_actor import (
        ActorConfig,
        TorchPolicy,
        build_actor_critic,
    )
    from oct_trading_agent.core import FeatureBundle

    torch.manual_seed(0)
    model = build_actor_critic(ActorConfig(hidden_dim=16))
    policy = TorchPolicy(model, normalizer=None, deterministic=True)  # no normalizer -> raw gate path
    bundle = FeatureBundle(mint=MINT, as_of=T0, tiers={})
    mask = np.array([1, 0, 1, 1, 1, 1], dtype=np.float32)  # slot 1 MISSING
    base_feat = np.array([0.5, 123.0, 0.2, 0.1, 0.0, 0.3], dtype=np.float32)
    alt_feat = base_feat.copy()
    alt_feat[1] = -999.0  # differs only in the masked-off slot
    state = np.array([0.0, 0.0, 1.0], dtype=np.float32)
    a = policy.act(Observation(features=base_feat, mask=mask, state=state, bundle=bundle))
    b = policy.act(Observation(features=alt_feat, mask=mask, state=state, bundle=bundle))
    assert a.intent == b.intent
    assert a.size == pytest.approx(b.size)


def test_quantile_huber_loss_decreases_toward_target() -> None:
    torch = pytest.importorskip("torch")
    from oct_trading_agent.agent.critics.quantile import QuantileValueHead, quantile_huber_loss

    torch.manual_seed(0)
    head = QuantileValueHead(4, n_quantiles=8)
    opt = torch.optim.Adam(head.parameters(), lr=0.05)
    torso = torch.ones(16, 4)
    target = torch.full((16,), 2.0)
    first = None
    for _ in range(50):
        loss = quantile_huber_loss(head(torso), target, head.taus)
        if first is None:
            first = float(loss.item())
        opt.zero_grad()
        loss.backward()
        opt.step()
    assert float(loss.item()) < first  # regression pulls quantiles toward the target
    # Mean of the fitted quantiles approaches the target scalar.
    assert head(torso).mean().item() == pytest.approx(2.0, abs=0.2)


def test_ppo_smoke_updates_without_error() -> None:
    torch = pytest.importorskip("torch")
    from oct_trading_agent.agent.envs import (
        EnvConfig,
        TradingEnv,
        bonding_curve_sim_config,
        prepare_bonding_curve_tape,
    )
    from oct_trading_agent.agent.online import RolloutBuffer, RunningNormalizer, collect_rollouts
    from oct_trading_agent.agent.online.ppo import PPOConfig, PPOTrainer
    from oct_trading_agent.agent.policies.torch_actor import ActorConfig, build_actor_critic

    torch.manual_seed(0)
    np.random.seed(0)
    tape = prepare_bonding_curve_tape(list(_synthetic_tape(48).swaps))
    env = TradingEnv(
        tape, MINT, bonding_curve_sim_config(risk_budget_quote=Decimal("0.01")),
        config=EnvConfig(initial_balance_quote=Decimal(1)),
    )
    model = build_actor_critic(ActorConfig(hidden_dim=16, n_quantiles=6))
    trainer = PPOTrainer(model, PPOConfig(minibatch_size=64, n_epochs=2))
    norm = RunningNormalizer()
    for _ in range(2):
        buf = RolloutBuffer()
        collect_rollouts(model, [env], norm, buf, update_normalizer=True)
        stats = trainer.update(buf.compute())
        assert np.isfinite(stats.policy_loss)
        assert np.isfinite(stats.value_loss)
        assert stats.n_samples > 0


def test_torch_policy_acts_validly() -> None:
    torch = pytest.importorskip("torch")
    from oct_trading_agent.agent.envs import (
        EnvConfig,
        TradingEnv,
        bonding_curve_sim_config,
        prepare_bonding_curve_tape,
    )
    from oct_trading_agent.agent.online import RunningNormalizer
    from oct_trading_agent.agent.policies import EnvPolicy
    from oct_trading_agent.agent.policies.torch_actor import (
        ActorConfig,
        TorchPolicy,
        build_actor_critic,
    )
    from oct_trading_agent.core import Intent

    torch.manual_seed(0)
    model = build_actor_critic(ActorConfig(hidden_dim=16))
    policy = TorchPolicy(model, normalizer=RunningNormalizer(), deterministic=True)
    assert isinstance(policy, EnvPolicy)
    tape = prepare_bonding_curve_tape(list(_synthetic_tape(20).swaps))
    env = TradingEnv(
        tape, MINT, bonding_curve_sim_config(risk_budget_quote=Decimal("0.01")),
        config=EnvConfig(initial_balance_quote=Decimal(1)),
    )
    obs = env.reset()
    action = policy.act(obs)
    assert action.intent in set(Intent)
    assert 0.0 <= action.size <= 1.0


def test_run_phase1_end_to_end_produces_verdict() -> None:
    """A tiny end-to-end Phase-1 run (fast budget, no leakage retrain) yields a valid gate verdict."""
    pytest.importorskip("torch")
    from oct_trading_agent.agent.train import TrainConfig, run_phase1

    result = run_phase1(
        [_synthetic_tape(80)],
        axis="held-out-time",
        train_config=TrainConfig(n_iterations=2, episodes_per_iter=1, hidden_dim=16, n_quantiles=6),
        seed=0,
        n_windows=6,
        run_leakage_guard=False,
        log=lambda _m: None,
    )
    assert result.verdict.verdict in {"GO", "NO-GO", "INCONCLUSIVE"}
    assert "learned_agent" in result.evaluations
    assert set(result.edges) == {"hold_sol", "buy_and_hold"}
    assert result.n_train_envs >= 1 and result.n_eval_envs >= 1
