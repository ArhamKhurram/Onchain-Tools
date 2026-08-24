"""Tier-A+ attention observation features (paper §4.4) — tracker, env wiring, flag-off regression.

Covers the task's required properties:

* a pure-Poisson tape yields a branching ratio near 0 (no self-excitation to find);
* a metronomic wash-like tape trips the suspicion channel above an organic tape's;
* causality — the features at ``t`` are unchanged by trades after ``t``;
* flag OFF ⇒ the observation is IDENTICAL to today's tier-A observation (regression);
* flag ON ⇒ the obs widens by the three attention slots, masked as one unit before the fit
  window (honest missingness) and observed together after it (λ/n never without suspicion);
* the running normalizer and the network-boundary mask gate handle the widened vector.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import numpy as np

from oct_trading_agent.agent.encoders.hawkes import fit_hawkes
from oct_trading_agent.agent.encoders.tracker import (
    MISSING_ATTENTION,
    AttentionFeatures,
    AttentionTrackerConfig,
    HawkesAttentionTracker,
)
from oct_trading_agent.agent.envs import (
    ATTENTION_SLOTS,
    TIER_A_SLOTS,
    EnvAction,
    EnvConfig,
    TradingEnv,
    bonding_curve_sim_config,
    prepare_bonding_curve_tape,
    vector_length,
)
from oct_trading_agent.agent.envs.spaces import BoxSpace
from oct_trading_agent.agent.online.normalize import RunningNormalizer
from oct_trading_agent.agent.policies.torch_actor import _gate_missing
from oct_trading_agent.core import Intent, Side, SwapEvent

MINT = "TokenMintPumpFunBonding0000000000000000000000"
T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)

_N_A = len(TIER_A_SLOTS)
_N_ATT = len(ATTENTION_SLOTS)

# Small windows so the unit tapes cross the fit bar quickly.
FAST_TRACKER = AttentionTrackerConfig(min_events=8, refit_stride=4, max_iter=60)


def _swap(
    i: int,
    *,
    secs: float,
    side: Side = Side.BUY,
    signer: str = "w0",
    quote: str = "0.05",
    base: str = "1900",
) -> SwapEvent:
    return SwapEvent(
        mint=MINT,
        slot=1000 + i,
        block_time=T0 + timedelta(seconds=secs),
        signature=f"s{i}",
        signer=signer,
        side=side,
        base_amount=Decimal(base),
        quote_amount=Decimal(quote),
        price=Decimal(quote) / Decimal(base),
        protocol="pumpfun",
    )


def _organic_swaps(n: int = 40, seed: int = 7) -> list[SwapEvent]:
    """Varied signers, Benford-ish sizes, irregular clustered gaps — plausibly organic flow."""
    rng = np.random.default_rng(seed)
    t = 0.0
    out: list[SwapEvent] = []
    for i in range(n):
        t += float(rng.exponential(3.0))
        size = float(np.power(10.0, rng.uniform(-2.0, 0.5)))
        side = Side.BUY if rng.uniform() < 0.7 else Side.SELL
        out.append(
            _swap(i, secs=t, side=side, signer=f"organic{i}", quote=f"{size:.6f}")
        )
    return out


def _wash_swaps(n: int = 40) -> list[SwapEvent]:
    """Metronomic ping-pong: two wallets, constant round size, constant cadence — wash-like."""
    out: list[SwapEvent] = []
    for i in range(n):
        side = Side.BUY if i % 2 == 0 else Side.SELL
        out.append(
            _swap(i, secs=2.0 * i, side=side, signer=f"w{i % 2}", quote="1.0")
        )
    return out


# ---------------------------------------------------------------------------
# Hawkes honesty: a Poisson tape has (almost) nothing self-exciting to find
# ---------------------------------------------------------------------------


def test_pure_poisson_tape_yields_near_zero_branching_ratio() -> None:
    rng = np.random.default_rng(1)
    times = np.cumsum(rng.exponential(1.0, size=800))
    dims = rng.integers(0, 2, size=800)
    fit = fit_hawkes(times, dims, n_dims=2, beta=1.0)
    assert fit.branching_ratio < 0.2  # n ≈ 0: arrivals are exogenous discovery only


# ---------------------------------------------------------------------------
# Tracker: cold start, sensible values, suspicion, causality
# ---------------------------------------------------------------------------


def test_tracker_masks_missing_before_fit_window() -> None:
    tracker = HawkesAttentionTracker(_organic_swaps(), config=FAST_TRACKER)
    early = tracker.features_at(T0 + timedelta(seconds=1))
    assert not early.observed
    assert early.n_events < FAST_TRACKER.min_events
    # The empty tape is also a masked miss, never a fabricated reading.
    assert not HawkesAttentionTracker([], config=FAST_TRACKER).features_at(T0).observed
    assert not MISSING_ATTENTION.observed


def test_tracker_reports_sensible_values_after_window() -> None:
    swaps = _organic_swaps()
    tracker = HawkesAttentionTracker(swaps, config=FAST_TRACKER)
    feats = tracker.features_at(swaps[-1].block_time)
    assert feats.observed
    assert feats.n_events == len(swaps)
    assert feats.lambda_buy_ratio > 0.0
    assert feats.branching_ratio_n >= 0.0  # raw, honestly reported (may exceed 1)
    assert 0.0 <= feats.suspicion <= 1.0


def test_metronomic_wash_tape_trips_suspicion_above_organic() -> None:
    organic = HawkesAttentionTracker(_organic_swaps(), config=FAST_TRACKER)
    wash = HawkesAttentionTracker(_wash_swaps(), config=FAST_TRACKER)
    t = T0 + timedelta(seconds=10_000)
    s_organic = organic.features_at(t)
    s_wash = wash.features_at(t)
    assert s_organic.observed and s_wash.observed
    assert s_wash.suspicion > 0.5  # constant round sizes + 2-wallet churn is loudly wash-like
    assert s_wash.suspicion > s_organic.suspicion + 0.2


def test_tracker_features_causal_under_future_trades() -> None:
    """Features at ``t`` from the full tape equal features from the tape truncated at ``t``."""
    swaps = _organic_swaps(60)
    cut = 30
    t = swaps[cut - 1].block_time
    full = HawkesAttentionTracker(swaps, config=FAST_TRACKER)
    truncated = HawkesAttentionTracker(swaps[:cut], config=FAST_TRACKER)
    a = full.features_at(t)
    b = truncated.features_at(t)
    assert a.n_events == b.n_events == cut
    assert a.lambda_buy_ratio == b.lambda_buy_ratio
    assert a.branching_ratio_n == b.branching_ratio_n
    assert a.suspicion == b.suspicion


def test_explosive_branching_flagged_not_clipped() -> None:
    feats = AttentionFeatures(
        lambda_buy_ratio=5.0, branching_ratio_n=1.3, suspicion=0.2, observed=True, n_events=50
    )
    assert feats.explosive
    assert feats.branching_ratio_n == 1.3  # never silently clamped to < 1


# ---------------------------------------------------------------------------
# Env wiring: flag OFF is byte-identical; flag ON widens honestly
# ---------------------------------------------------------------------------


def _env(swaps: list[SwapEvent], **cfg: object) -> TradingEnv:
    tape = prepare_bonding_curve_tape(swaps)
    return TradingEnv(
        tape,
        MINT,
        bonding_curve_sim_config(risk_budget_quote=Decimal("0.01")),
        config=EnvConfig(initial_balance_quote=Decimal(1), **cfg),  # type: ignore[arg-type]
    )


def test_flag_off_observation_is_unchanged_tier_a() -> None:
    swaps = _organic_swaps()
    default_env = _env(swaps)
    explicit_off = _env(swaps, attention_features=False)
    obs_a = default_env.reset()
    obs_b = explicit_off.reset()
    assert obs_a.features.shape == (_N_A,)
    assert obs_a.mask.shape == (_N_A,)
    assert default_env.observation_vector_length == vector_length() == 2 * _N_A + 3
    np.testing.assert_array_equal(obs_a.to_vector(), obs_b.to_vector())
    box = default_env.observation_space.spaces["features"]
    assert isinstance(box, BoxSpace)
    assert len(box.low) == _N_A


def test_flag_on_widens_obs_and_masks_attention_as_one_unit() -> None:
    swaps = _organic_swaps()
    env = _env(swaps, attention_features=True, attention_config=FAST_TRACKER)
    off_env = _env(swaps)
    assert env.observation_vector_length == vector_length(attention=True) == 2 * (_N_A + _N_ATT) + 3

    obs = env.reset()
    off_obs = off_env.reset()
    assert obs.features.shape == (_N_A + _N_ATT,)
    # The tier-A block is untouched by the widening.
    np.testing.assert_array_equal(obs.features[:_N_A], off_obs.features)
    np.testing.assert_array_equal(obs.mask[:_N_A], off_obs.mask)
    # Before the fit window: all three attention slots masked-missing TOGETHER.
    np.testing.assert_array_equal(obs.mask[_N_A:], np.zeros(_N_ATT, dtype=np.float32))
    np.testing.assert_array_equal(obs.features[_N_A:], np.zeros(_N_ATT, dtype=np.float32))

    # Step past the fit window: the three slots become observed TOGETHER (λ/n never
    # without their suspicion companion — §9.10) and carry transformed values.
    result = None
    for _ in range(FAST_TRACKER.min_events + 2):
        result = env.step(EnvAction(intent=Intent.NO_OP))
        if result.terminated or result.truncated:
            break
    assert result is not None
    late = result.observation
    att_mask = late.mask[_N_A:]
    np.testing.assert_array_equal(att_mask, np.ones(_N_ATT, dtype=np.float32))  # one unit, observed
    assert late.features[_N_A] >= 0.0  # log1p(λ ratio)
    assert 0.0 <= late.features[_N_A + 2] <= 1.0  # suspicion passes through untransformed


# ---------------------------------------------------------------------------
# Learner plumbing: normalizer and mask gate follow the widened shape
# ---------------------------------------------------------------------------


def test_normalizer_handles_widened_obs_and_rejects_shape_mix() -> None:
    import pytest

    swaps = _organic_swaps()
    wide_env = _env(swaps, attention_features=True, attention_config=FAST_TRACKER)
    narrow_env = _env(swaps)
    wide_obs = wide_env.reset()
    narrow_obs = narrow_env.reset()

    norm = RunningNormalizer()
    norm.update(wide_obs)
    out = norm.normalize(wide_obs)
    assert out.shape == (vector_length(attention=True),)
    # Mask block passes through as raw 0/1.
    n = _N_A + _N_ATT
    np.testing.assert_array_equal(out[n : 2 * n], wide_obs.mask)
    with pytest.raises(ValueError, match="shape changed"):
        norm.update(narrow_obs)

    # State round-trip keeps the widened dimensions.
    restored = RunningNormalizer()
    restored.load_state_dict(norm.state_dict())
    np.testing.assert_array_equal(restored.normalize(wide_obs), norm.normalize(wide_obs))


def test_gate_missing_uses_mask_width() -> None:
    n = _N_A + _N_ATT
    vec = np.arange(2 * n + 3, dtype=np.float32) + 1.0
    mask = np.ones(n, dtype=np.float32)
    mask[_N_A:] = 0.0  # attention block missing
    gated = _gate_missing(vec, mask)
    np.testing.assert_array_equal(gated[:_N_A], vec[:_N_A])
    np.testing.assert_array_equal(gated[_N_A:n], np.zeros(_N_ATT, dtype=np.float32))
    np.testing.assert_array_equal(gated[n:], vec[n:])  # mask + state blocks untouched
