"""Tests for the typed spaces and the §3.3 hybrid action + its translation to a sim Order."""

from __future__ import annotations

import numpy as np

from oct_trading_agent.agent.envs.action import (
    INTENT_ORDER,
    EnvAction,
    action_from_array,
    action_space,
    action_to_order,
    intent_index,
)
from oct_trading_agent.agent.envs.spaces import BoxSpace, DictSpace, DiscreteSpace
from oct_trading_agent.core import Intent

MINT = "So11111111111111111111111111111111111111112"


def test_box_space_sample_within_bounds() -> None:
    rng = np.random.default_rng(0)
    box = BoxSpace(low=(0.0, -1.0), high=(1.0, 1.0))
    for _ in range(50):
        assert box.contains(box.sample(rng))


def test_discrete_space_sample_in_range() -> None:
    rng = np.random.default_rng(0)
    d = DiscreteSpace(6)
    for _ in range(50):
        assert d.contains(d.sample(rng))


def test_dict_space_samples_each_subspace() -> None:
    rng = np.random.default_rng(0)
    space = DictSpace({"a": BoxSpace((0.0,), (1.0,)), "b": DiscreteSpace(3)})
    sample = space.sample(rng)
    assert set(sample) == {"a", "b"}


def test_intent_order_is_stable_and_complete() -> None:
    assert set(INTENT_ORDER) == set(Intent)
    assert INTENT_ORDER[0] is Intent.NO_OP
    for i, intent in enumerate(INTENT_ORDER):
        assert intent_index(intent) == i


def test_action_space_shape() -> None:
    discrete, box = action_space()
    assert discrete.n == len(INTENT_ORDER)
    assert box.shape == (1,)


def test_action_from_array_rounds_and_clamps() -> None:
    # index 1.4 -> 1 (OPEN_LONG); size 1.5 -> clamped to 1.0
    action = action_from_array(np.array([1.4, 1.5]))
    assert action.intent is Intent.OPEN_LONG
    assert action.size == 1.0
    # negative / NaN saturate rather than raise
    assert action_from_array(np.array([-3.0, -1.0])).intent is INTENT_ORDER[0]
    assert action_from_array(np.array([np.nan, np.nan])).size == 0.0


def test_action_to_order_zeroes_size_for_nonsizing_intents() -> None:
    for intent in (Intent.NO_OP, Intent.HOLD, Intent.CLOSE):
        order = action_to_order(EnvAction(intent=intent, size=0.7), MINT)
        assert order.size == 0.0
    for intent in (Intent.OPEN_LONG, Intent.ADD, Intent.TRIM):
        order = action_to_order(EnvAction(intent=intent, size=0.7), MINT)
        assert order.size == 0.7
        assert order.mint == MINT
        assert order.intent is intent
