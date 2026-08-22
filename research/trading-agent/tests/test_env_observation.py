"""Observation tests — the load-bearing property: explicit missingness is masked, never imputed."""

from __future__ import annotations

from datetime import UTC, datetime

from oct_trading_agent.agent.envs.observation import (
    STATE_SLOTS,
    TIER_A_SLOTS,
    AgentState,
    encode,
    observation_space,
    vector_length,
)
from oct_trading_agent.core import (
    Feature,
    FeatureBundle,
    FeatureStatus,
    FeatureTier,
)

MINT = "So11111111111111111111111111111111111111112"
T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)


def _bundle(values: dict[str, float | None]) -> FeatureBundle:
    slots = {}
    for name, value in values.items():
        if value is None:
            slots[name] = Feature(
                value=None, status=FeatureStatus.MISSING_NOT_YET_AVAILABLE, as_of=T0
            )
        else:
            slots[name] = Feature(value=value, status=FeatureStatus.OBSERVED, as_of=T0)
    return FeatureBundle(mint=MINT, as_of=T0, tiers={FeatureTier.A_RAW_CHART: slots})


def _state() -> AgentState:
    return AgentState(has_position=False, steps_elapsed_frac=0.0, balance_ratio=1.0)


def test_missing_slot_is_masked_and_value_zero() -> None:
    bundle = _bundle({"price": None, "trade_count": 5.0})
    obs = encode(bundle, _state())
    price_idx = TIER_A_SLOTS.index("price")
    count_idx = TIER_A_SLOTS.index("trade_count")
    assert obs.mask[price_idx] == 0.0  # missing -> mask off
    assert obs.features[price_idx] == 0.0  # placeholder, NOT imputed (mask is the truth)
    assert obs.mask[count_idx] == 1.0  # observed -> mask on
    assert obs.features[count_idx] != 0.0  # transformed observed value


def test_absent_tier_yields_all_missing() -> None:
    bundle = FeatureBundle(mint=MINT, as_of=T0, tiers={})
    obs = encode(bundle, _state())
    assert obs.mask.sum() == 0.0  # every slot masked-missing
    assert (obs.features == 0.0).all()


def test_vector_layout_is_features_mask_state() -> None:
    bundle = _bundle({name: 1.0 for name in TIER_A_SLOTS})
    obs = encode(bundle, _state())
    vec = obs.to_vector()
    assert vec.shape[0] == vector_length()
    n = len(TIER_A_SLOTS)
    # mask block is all ones (every slot observed); state block length matches
    assert (vec[n : 2 * n] == 1.0).all()
    assert vec[2 * n :].shape[0] == len(STATE_SLOTS)


def test_observation_space_has_three_blocks() -> None:
    space = observation_space()
    assert set(space.spaces) == {"features", "mask", "state"}


def test_imbalance_passes_through_but_magnitudes_compressed() -> None:
    bundle = _bundle({"buy_sell_imbalance": -0.5, "trade_count": 1000.0})
    obs = encode(bundle, _state())
    imb_idx = TIER_A_SLOTS.index("buy_sell_imbalance")
    cnt_idx = TIER_A_SLOTS.index("trade_count")
    assert abs(obs.features[imb_idx] - (-0.5)) < 1e-6  # imbalance untouched
    assert obs.features[cnt_idx] < 1000.0  # count log-compressed
