"""Vectorized rollout collection — exact equivalence at one env, plus the bookkeeping batching adds.

``collect_rollouts`` is a *performance* rewrite of a semantics-critical loop, so the tests here are
about proving the batched path fills the buffer with exactly what the sequential path would have.

The load-bearing test is the single-env one: with one env the batch is size 1, so the two paths draw
the same RNG in the same order and must agree **exactly** — any divergence there is a real bug, not
the documented multi-env interleaving. The rest pin what batching genuinely changes the shape of:
episode ordering and count, the per-env step budget, which boundary earns a bootstrap value, and
(via a forward-counting proxy) that the batched path really does one forward per *timestep* rather
than one per env-step. Torch-gated like the rest of the learner suite.
"""

from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import numpy as np
import pytest

from oct_trading_agent.agent.envs import (
    EnvAction,
    EnvConfig,
    Observation,
    StepResult,
    TradingEnv,
    bonding_curve_sim_config,
    prepare_bonding_curve_tape,
)
from oct_trading_agent.agent.online import RolloutBuffer, RunningNormalizer, collect_rollouts
from oct_trading_agent.agent.online.buffer import Transition
from oct_trading_agent.core import FeatureBundle, Side, SwapEvent
from oct_trading_agent.eval.data import TokenTape

MINT = "TokenMintPumpFunBondingLearnerTest0000000000"
T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)


# ---------------------------------------------------------------------------
# Fixtures: a real env for the equivalence proof, a scripted stub for the boundaries
# ---------------------------------------------------------------------------


def _synthetic_tape(n: int = 48) -> TokenTape:
    """A small deterministic pump.fun-style tape: mostly buys with rising quote size."""
    swaps = [
        SwapEvent(
            mint=MINT,
            slot=1000 + i,
            block_time=T0 + timedelta(seconds=i),
            signature=f"s{i}",
            signer=f"w{i % 8}",
            side=Side.BUY if i % 4 != 3 else Side.SELL,
            base_amount=Decimal("1900"),
            quote_amount=Decimal(f"{0.00004 + 0.0000005 * i:.8f}"),
            price=Decimal(f"{0.00004 + 0.0000005 * i:.8f}") / Decimal("1900"),
            protocol="pumpfun",
        )
        for i in range(n)
    ]
    return TokenTape(mint=MINT, swaps=swaps, source="synthetic")


def _real_env() -> TradingEnv:
    """A fresh :class:`TradingEnv` over the synthetic tape (deterministic given the same tape)."""
    tape = prepare_bonding_curve_tape(list(_synthetic_tape().swaps))
    return TradingEnv(
        tape,
        MINT,
        bonding_curve_sim_config(risk_budget_quote=Decimal("0.01")),
        config=EnvConfig(initial_balance_quote=Decimal(1)),
    )


class _StubEnv:
    """A scripted env: ``length`` steps, then end — naturally (``terminate``) or by truncation.

    The boundary tests need an episode that ends a *chosen* way at a *chosen* step, which no market
    tape can be asked for. ``tag`` is folded into every reward and observation so a transition that
    was routed to the wrong env's episode is visible rather than merely suspicious.
    """

    def __init__(self, *, length: int, terminate: bool, tag: float = 0.0) -> None:
        self._length = length
        self._terminate = terminate
        self._tag = tag
        self._i = 0

    def _observation(self) -> Observation:
        base = self._tag + float(self._i)
        features = np.array(
            [base + 0.5, base + 1.5, base + 2.5, base + 3.5, 0.25, base + 4.5], dtype=np.float32
        )
        mask = np.ones(6, dtype=np.float32)
        state = np.array([0.0, float(self._i) / 100.0, 1.0], dtype=np.float32)
        return Observation(
            features=features,
            mask=mask,
            state=state,
            bundle=FeatureBundle(mint=MINT, as_of=T0, tiers={}),
        )

    def reset(self) -> Observation:
        self._i = 0
        return self._observation()

    def step(self, action: EnvAction | np.ndarray) -> StepResult:
        self._i += 1
        done = self._i >= self._length
        return StepResult(
            observation=self._observation(),
            reward=self._tag + float(self._i),
            terminated=done and self._terminate,
            truncated=done and not self._terminate,
            info={},
        )


class _CountingModel:
    """Forward-counting proxy around the actor-critic — the only observable proof of batching.

    ``collect_rollouts`` touches a model through exactly two members (``parameters`` for the device
    and ``forward``), so a thin proxy is enough and keeps the real network's numerics untouched.
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.forwards = 0

    def parameters(self) -> Any:
        return self._inner.parameters()

    def forward(self, obs: Any) -> Any:
        self.forwards += 1
        return self._inner.forward(obs)


def _model(seed: int = 0) -> Any:
    """Build the small actor-critic under test (torch-only; callers ``importorskip`` first)."""
    import torch

    from oct_trading_agent.agent.policies.torch_actor import ActorConfig, build_actor_critic

    torch.manual_seed(seed)
    return build_actor_critic(ActorConfig(hidden_dim=16, n_quantiles=6))


def _seed_everything(seed: int) -> None:
    """Pin every generator collection can consume, so a rerun follows the same trajectory."""
    import torch

    torch.manual_seed(seed)
    np.random.seed(seed)
    random.seed(seed)


def _episodes(buffer: RolloutBuffer) -> list[tuple[list[Transition], float]]:
    """The stored episodes. Read privately on purpose: ``last_value`` is an episode-boundary fact
    and is consumed by GAE, so it never appears in the flattened batch these tests would otherwise
    have to assert against."""
    return buffer._episodes


def _assert_episodes_identical(
    left: list[tuple[list[Transition], float]], right: list[tuple[list[Transition], float]]
) -> None:
    """Every field of every transition, in order — the whole point of the equivalence claim."""
    assert len(left) == len(right)
    for (lhs, left_boot), (rhs, right_boot) in zip(left, right, strict=True):
        assert len(lhs) == len(rhs)
        assert left_boot == pytest.approx(right_boot)
        for a, b in zip(lhs, rhs, strict=True):
            assert a.intent_index == b.intent_index
            assert a.size == pytest.approx(b.size)
            assert a.log_prob == pytest.approx(b.log_prob)
            assert a.value == pytest.approx(b.value)
            assert a.reward == pytest.approx(b.reward)
            assert a.terminated is b.terminated
            assert a.truncated is b.truncated
            assert a.obs_vector == pytest.approx(b.obs_vector)


# ---------------------------------------------------------------------------
# The correctness proof
# ---------------------------------------------------------------------------


def test_single_env_vectorized_matches_sequential_exactly() -> None:
    """One env ⇒ batch of 1 ⇒ identical RNG draws ⇒ byte-for-byte the same episode.

    This is the strongest statement available: the batched loop is only allowed to differ from the
    reference loop through batching itself (interleaved normalizer updates and batched RNG draws),
    both of which vanish at a single env. Anything else that differs is a bookkeeping bug.
    """
    pytest.importorskip("torch")
    model = _model()

    def run(*, vectorized: bool) -> RolloutBuffer:
        _seed_everything(1234)
        buffer = RolloutBuffer()
        collect_rollouts(
            model,
            [_real_env()],
            RunningNormalizer(),
            buffer,
            update_normalizer=True,
            risk_beta=0.3,  # exercise the CVaR blend, not just the mean, on both paths
            cvar_alpha=0.1,
            vectorized=vectorized,
        )
        return buffer

    sequential = run(vectorized=False)
    vectorized = run(vectorized=True)

    assert sequential.n_episodes == 1
    assert sequential.n_steps >= 2  # a one-step episode would make the comparison vacuous
    _assert_episodes_identical(_episodes(sequential), _episodes(vectorized))


def test_vectorized_is_deterministic_for_a_fixed_seed() -> None:
    """Batching changes the trajectory (documented); it must not make it irreproducible."""
    pytest.importorskip("torch")
    model = _model()

    def run() -> RolloutBuffer:
        _seed_everything(7)
        buffer = RolloutBuffer()
        collect_rollouts(
            model,
            [_real_env(), _real_env(), _real_env()],
            RunningNormalizer(),
            buffer,
            update_normalizer=True,
        )
        return buffer

    _assert_episodes_identical(_episodes(run()), _episodes(run()))


# ---------------------------------------------------------------------------
# Bookkeeping the batch introduces
# ---------------------------------------------------------------------------


def test_one_episode_per_env_in_env_order_with_the_right_transitions() -> None:
    """N envs ⇒ N episodes, added in env order, each holding only *its own* env's transitions.

    Envs of different lengths finish on different timesteps, so this also covers dropping an env out
    of the active set mid-flight without disturbing the ones still running.
    """
    pytest.importorskip("torch")
    lengths = [1, 4, 2, 7, 3]
    envs: list[Any] = [
        _StubEnv(length=n, terminate=True, tag=100.0 * (i + 1)) for i, n in enumerate(lengths)
    ]
    buffer = RolloutBuffer()
    _seed_everything(0)
    collect_rollouts(_model(), envs, RunningNormalizer(), buffer)

    episodes = _episodes(buffer)
    assert buffer.n_episodes == len(lengths)
    assert buffer.n_steps == sum(lengths)
    for i, (transitions, _last) in enumerate(episodes):
        assert len(transitions) == lengths[i]  # env order preserved, not finish order
        # The stub's reward encodes (env tag, step) — proof no transition crossed episodes.
        expected = [100.0 * (i + 1) + (k + 1) for k in range(lengths[i])]
        assert [t.reward for t in transitions] == pytest.approx(expected)
        assert transitions[-1].terminated and not transitions[-1].truncated


def test_step_budget_is_per_env_and_enforced() -> None:
    """``max_steps_per_episode`` caps every env independently, even one that never ends."""
    pytest.importorskip("torch")
    envs: list[Any] = [_StubEnv(length=1000, terminate=True, tag=float(i)) for i in range(4)]
    buffer = RolloutBuffer()
    _seed_everything(0)
    collect_rollouts(_model(), envs, RunningNormalizer(), buffer, max_steps_per_episode=3)

    assert buffer.n_episodes == 4
    for transitions, last_value in _episodes(buffer):
        assert len(transitions) == 3
        assert not transitions[-1].terminated and not transitions[-1].truncated
        # Running out of collector budget is not an env truncation, so nothing is bootstrapped —
        # the pre-vectorization path behaved the same way and this pins it.
        assert last_value == 0.0


def test_truncation_bootstraps_and_natural_terminal_does_not() -> None:
    """A truncated tail gets the critic's value of the next state; a real terminal gets exactly 0."""
    pytest.importorskip("torch")
    envs: list[Any] = [
        _StubEnv(length=3, terminate=False, tag=10.0),  # truncates
        _StubEnv(length=3, terminate=True, tag=20.0),  # terminates naturally
    ]
    buffer = RolloutBuffer()
    _seed_everything(0)
    collect_rollouts(_model(), envs, RunningNormalizer(), buffer)

    (truncated, truncated_boot), (terminated, terminated_boot) = _episodes(buffer)
    assert truncated[-1].truncated and not truncated[-1].terminated
    assert truncated_boot != 0.0  # bootstrapped from a randomly-initialized critic
    assert np.isfinite(truncated_boot)
    assert terminated[-1].terminated and not terminated[-1].truncated
    assert terminated_boot == 0.0


def test_batched_path_does_one_forward_per_timestep_not_per_env_step() -> None:
    """The whole point: 12 envs × 5 steps costs 5 forwards, not 60."""
    pytest.importorskip("torch")
    lengths = [5, 5, 5, 5, 4, 4, 3, 3, 2, 2, 1, 1]
    counting = _CountingModel(_model())
    envs: list[Any] = [
        _StubEnv(length=n, terminate=True, tag=10.0 * (i + 1)) for i, n in enumerate(lengths)
    ]
    buffer = RolloutBuffer()
    _seed_everything(0)
    collect_rollouts(counting, envs, RunningNormalizer(), buffer)

    assert buffer.n_episodes == len(lengths)
    assert buffer.n_steps == sum(lengths)
    # All envs terminate naturally, so there are no bootstrap forwards to account for: the count is
    # exactly the number of timesteps the longest episode needed.
    assert counting.forwards == max(lengths)
    assert counting.forwards < sum(lengths)


def test_multi_env_smoke_fills_the_buffer_with_finite_on_policy_data() -> None:
    """Many real envs through the batched path produce a well-formed, trainable batch."""
    pytest.importorskip("torch")
    envs: list[Any] = [_real_env() for _ in range(6)]
    buffer = RolloutBuffer()
    _seed_everything(3)
    collect_rollouts(
        _model(), envs, RunningNormalizer(), buffer, update_normalizer=True, risk_beta=0.5
    )

    assert buffer.n_episodes == 6
    assert buffer.n_steps > 0
    batch = buffer.compute()
    assert len(batch) == buffer.n_steps
    assert np.isfinite(batch.obs).all()
    assert np.isfinite(batch.log_probs).all()
    assert np.isfinite(batch.values).all()
    assert np.isfinite(batch.advantages).all()
    assert np.isfinite(batch.returns).all()
    assert ((batch.intents >= 0) & (batch.intents < 6)).all()
    assert ((batch.sizes >= 0.0) & (batch.sizes <= 1.0)).all()
