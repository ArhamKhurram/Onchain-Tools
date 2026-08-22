"""RolloutBuffer + GAE tests (pure-numpy; run in the base suite without torch)."""

from __future__ import annotations

import numpy as np

from oct_trading_agent.agent.online.buffer import RolloutBuffer, Transition


def _t(reward: float, value: float, *, terminated: bool = False, truncated: bool = False) -> Transition:
    return Transition(
        obs_vector=np.zeros(3, dtype=np.float32),
        intent_index=0,
        size=0.0,
        log_prob=0.0,
        value=value,
        reward=reward,
        terminated=terminated,
        truncated=truncated,
    )


def test_gae_terminal_gives_monte_carlo_returns() -> None:
    """With gamma=lam=1 and a natural terminal, λ-returns equal the realized reward-to-go."""
    buf = RolloutBuffer(gamma=1.0, lam=1.0)
    buf.add_episode([_t(1.0, 0.5), _t(2.0, 0.5, terminated=True)], last_value=99.0)
    batch = buf.compute(normalize_adv=False)
    # returns = reward-to-go: [r0+r1, r1] = [3, 2]; last_value must be ignored on a terminal.
    assert np.allclose(batch.returns, [3.0, 2.0])
    # advantages = returns - values = [3-0.5, 2-0.5]
    assert np.allclose(batch.advantages, [2.5, 1.5])


def test_gae_truncation_bootstraps_last_value() -> None:
    """A truncation is not the end of the MDP: the tail is bootstrapped with last_value."""
    buf = RolloutBuffer(gamma=1.0, lam=1.0)
    buf.add_episode([_t(1.0, 0.0, truncated=True)], last_value=5.0)
    batch = buf.compute(normalize_adv=False)
    # single truncated step: return = r + last_value = 6; advantage = 6 - value(0) = 6
    assert np.allclose(batch.returns, [6.0])
    assert np.allclose(batch.advantages, [6.0])


def test_gae_discount_applies() -> None:
    buf = RolloutBuffer(gamma=0.5, lam=1.0)
    buf.add_episode([_t(1.0, 0.0), _t(4.0, 0.0, terminated=True)], last_value=0.0)
    batch = buf.compute(normalize_adv=False)
    # r0 + gamma*r1 = 1 + 0.5*4 = 3 ; r1 = 4
    assert np.allclose(batch.returns, [3.0, 4.0])


def test_advantage_normalization_zero_mean_unit_std() -> None:
    buf = RolloutBuffer(gamma=1.0, lam=1.0)
    buf.add_episode([_t(1.0, 0.0), _t(3.0, 0.0), _t(-2.0, 0.0, terminated=True)], last_value=0.0)
    batch = buf.compute(normalize_adv=True)
    assert abs(float(batch.advantages.mean())) < 1e-5
    assert abs(float(batch.advantages.std()) - 1.0) < 1e-3


def test_returns_equal_advantage_plus_value() -> None:
    buf = RolloutBuffer(gamma=0.9, lam=0.8)
    buf.add_episode([_t(0.3, 0.2), _t(0.1, 0.4, terminated=True)], last_value=0.0)
    batch = buf.compute(normalize_adv=False)
    assert np.allclose(batch.returns, batch.advantages + batch.values)


def test_empty_episode_is_dropped() -> None:
    buf = RolloutBuffer()
    buf.add_episode([], last_value=0.0)
    assert buf.n_episodes == 0
    assert buf.n_steps == 0
