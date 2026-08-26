"""The opt-in `normalize_returns` knob on RolloutBuffer.compute.

Advantages are standardised and returns are not, so the critic regresses raw lambda-returns
through a quantile Huber loss with no value clipping. On fat-tailed payoffs one survivor token
can move the value loss by two orders of magnitude. This pins the knob's behaviour AND its
default, because a learning knob that silently flips would make runs incomparable.
"""
from __future__ import annotations

import numpy as np

from oct_trading_agent.agent.online.buffer import RolloutBuffer, Transition


def _episode(rewards: list[float], value: float = 0.0) -> list[Transition]:
    return [
        Transition(
            obs_vector=np.zeros(4, dtype=np.float32), intent_index=0, size=0.0,
            log_prob=0.0, value=value, reward=r, terminated=(i == len(rewards) - 1),
            truncated=False,
        )
        for i, r in enumerate(rewards)
    ]


def _buf(rewards: list[float]) -> RolloutBuffer:
    b = RolloutBuffer(gamma=0.99, lam=0.95)
    b.add_episode(_episode(rewards), 0.0)
    return b


def test_default_is_off_so_runs_stay_comparable():
    """The default must not change what the critic sees. This is the regression that matters."""
    raw = _buf([1.0, 2.0, 300.0]).compute().returns
    explicit_off = _buf([1.0, 2.0, 300.0]).compute(normalize_returns=False).returns
    assert np.allclose(raw, explicit_off)


def test_enabling_it_scales_returns_down():
    off = _buf([1.0, 2.0, 300.0]).compute().returns
    on = _buf([1.0, 2.0, 300.0]).compute(normalize_returns=True).returns
    assert float(np.abs(on).max()) < float(np.abs(off).max())


def test_it_scales_without_shifting_the_zero_point():
    """Scale only, no mean subtraction.

    The critic's output is read as PnL, so moving its zero would change what "break even" means.
    A pure scale preserves the sign of every return and their ratios.
    """
    off = _buf([1.0, -2.0, 50.0]).compute().returns
    on = _buf([1.0, -2.0, 50.0]).compute(normalize_returns=True).returns
    assert np.all(np.sign(on) == np.sign(off))
    nz = off != 0
    ratios = on[nz] / off[nz]
    assert np.allclose(ratios, ratios[0], rtol=1e-4), "every return scaled by the same factor"


def test_a_fat_tailed_outlier_is_compressed_relative_to_the_body():
    """The actual motivation: one survivor token must stop dominating the target."""
    rewards = [0.1] * 20 + [5000.0]
    on = _buf(rewards).compute(normalize_returns=True).returns
    off = _buf(rewards).compute(normalize_returns=False).returns
    assert float(np.abs(on).max()) < float(np.abs(off).max()) / 10.0


def test_degenerate_batches_are_left_alone():
    """Zero variance (or a single sample) must not divide by ~0 and produce inf/nan."""
    flat = _buf([0.0, 0.0, 0.0]).compute(normalize_returns=True).returns
    assert np.all(np.isfinite(flat))
    single = _buf([1.0]).compute(normalize_returns=True).returns
    assert np.all(np.isfinite(single))


def test_advantages_are_normalised_regardless():
    """The pre-existing behaviour is untouched by the new flag."""
    for flag in (True, False):
        adv = _buf([1.0, 2.0, 3.0, 4.0]).compute(normalize_returns=flag).advantages
        assert abs(float(adv.mean())) < 1e-4
        assert abs(float(adv.std()) - 1.0) < 1e-3
