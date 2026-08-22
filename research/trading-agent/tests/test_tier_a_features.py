"""Tier-A raw-chart feature computations: as-of correctness + explicit, reason-tagged missingness.

Synthetic ``SwapEvent`` / ``LiquidityEvent`` tapes only — no data or sim layer. Each test pins one
feature's causal behavior and its missingness reason on ragged/sparse new-pair data.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from oct_trading_agent.core import (
    FeatureStatus,
    FeatureTier,
    LiquidityEvent,
    Side,
    SwapEvent,
    TapeEvent,
)
from oct_trading_agent.featurestore.tiers import (
    BuySellImbalance,
    LastPrice,
    MeanInterTradeSeconds,
    PoolLiquidityQuote,
    RollingVolumeQuote,
    TradeCount,
    default_tier_a_features,
)

MINT = "So11111111111111111111111111111111111111112"
T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)


def _swap(
    slot: int,
    when: datetime,
    *,
    side: Side = Side.BUY,
    price: str | None = "1",
    base: str = "1000",
    quote: str = "1",
    quote_reserve_after: str | None = None,
    base_reserve_after: str | None = None,
) -> SwapEvent:
    return SwapEvent(
        mint=MINT,
        slot=slot,
        block_time=when,
        signer="Wa11etWa11etWa11etWa11etWa11etWa11etWa11",
        side=side,
        base_amount=Decimal(base),
        quote_amount=Decimal(quote),
        price=Decimal(price) if price is not None else None,
        quote_reserve_after=Decimal(quote_reserve_after) if quote_reserve_after else None,
        base_reserve_after=Decimal(base_reserve_after) if base_reserve_after else None,
    )


def _liq(slot: int, when: datetime, *, quote_reserve_after: str, base_reserve_after: str) -> LiquidityEvent:
    return LiquidityEvent(
        mint=MINT,
        slot=slot,
        block_time=when,
        action="add",
        base_amount=Decimal("1"),
        quote_amount=Decimal("1"),
        quote_reserve_after=Decimal(quote_reserve_after),
        base_reserve_after=Decimal(base_reserve_after),
    )


# --------------------------------------------------------------------------- price


def test_last_price_is_latest_swap_at_or_before_as_of() -> None:
    tape: list[TapeEvent] = [
        _swap(100, T0, price="0.001"),
        _swap(101, T0 + timedelta(seconds=5), price="0.002"),
        _swap(200, T0 + timedelta(hours=1), price="9.999"),  # future — must not leak
    ]
    f = LastPrice().compute_as_of(tape, as_of=T0 + timedelta(seconds=10))
    assert f.observed
    assert f.value == 0.002
    assert f.as_of == T0 + timedelta(seconds=5)  # stamped at the informing swap, not the request


def test_last_price_missing_before_first_trade() -> None:
    f = LastPrice().compute_as_of([], as_of=T0)
    assert not f.observed
    assert f.value is None
    assert f.status is FeatureStatus.MISSING_NOT_YET_AVAILABLE


def test_last_price_falls_back_to_quote_over_base_when_price_absent() -> None:
    tape: list[TapeEvent] = [_swap(100, T0, price=None, base="1000", quote="3")]
    f = LastPrice().compute_as_of(tape, as_of=T0)
    assert f.observed
    assert f.value == 0.003


def test_last_price_not_applicable_when_no_usable_amounts() -> None:
    tape: list[TapeEvent] = [_swap(100, T0, price=None, base="0", quote="0")]
    f = LastPrice().compute_as_of(tape, as_of=T0)
    assert not f.observed
    assert f.status is FeatureStatus.MISSING_NOT_APPLICABLE


# --------------------------------------------------------------------------- liquidity


def test_pool_liquidity_reconstructs_latest_reserve() -> None:
    tape: list[TapeEvent] = [
        _liq(90, T0 - timedelta(seconds=1), quote_reserve_after="50", base_reserve_after="1000"),
        _swap(100, T0, quote_reserve_after="52", base_reserve_after="980"),
    ]
    f = PoolLiquidityQuote().compute_as_of(tape, as_of=T0 + timedelta(seconds=1))
    assert f.observed
    assert f.value == 52.0
    assert f.as_of == T0


def test_pool_liquidity_source_gap_when_events_carry_no_reserves() -> None:
    tape: list[TapeEvent] = [_swap(100, T0, quote_reserve_after=None)]
    f = PoolLiquidityQuote().compute_as_of(tape, as_of=T0)
    assert not f.observed
    assert f.status is FeatureStatus.MISSING_SOURCE_GAP  # events exist, reserves just not carried


def test_pool_liquidity_not_yet_available_when_no_events() -> None:
    f = PoolLiquidityQuote().compute_as_of([], as_of=T0)
    assert f.status is FeatureStatus.MISSING_NOT_YET_AVAILABLE


# --------------------------------------------------------------------------- rolling volume


def test_rolling_volume_sums_only_in_window() -> None:
    tape: list[TapeEvent] = [
        _swap(100, T0, quote="10"),
        _swap(101, T0 + timedelta(minutes=1), quote="5"),
        _swap(102, T0 + timedelta(minutes=4), quote="2"),
    ]
    f = RollingVolumeQuote(window=timedelta(minutes=5)).compute_as_of(
        tape, as_of=T0 + timedelta(minutes=4)
    )
    assert f.observed
    assert f.value == 17.0


def test_rolling_volume_observed_zero_when_live_but_no_recent_trades() -> None:
    """A live pair with no in-window trades has OBSERVED 0.0 volume — a real measure, not imputation."""
    tape: list[TapeEvent] = [_swap(100, T0, quote="10")]
    f = RollingVolumeQuote(window=timedelta(minutes=5)).compute_as_of(
        tape, as_of=T0 + timedelta(minutes=30)
    )
    assert f.observed
    assert f.value == 0.0


def test_rolling_volume_missing_before_first_trade() -> None:
    f = RollingVolumeQuote().compute_as_of([], as_of=T0)
    assert f.status is FeatureStatus.MISSING_NOT_YET_AVAILABLE


# --------------------------------------------------------------------------- trade count


def test_trade_count_cumulative_counts_all_at_or_before() -> None:
    tape: list[TapeEvent] = [
        _swap(100, T0),
        _swap(101, T0 + timedelta(seconds=5)),
        _swap(200, T0 + timedelta(hours=1)),  # future
    ]
    f = TradeCount().compute_as_of(tape, as_of=T0 + timedelta(seconds=10))
    assert f.observed
    assert f.value == 2


def test_trade_count_windowed() -> None:
    tape: list[TapeEvent] = [
        _swap(100, T0),
        _swap(101, T0 + timedelta(minutes=1)),
        _swap(102, T0 + timedelta(minutes=9)),
    ]
    f = TradeCount(window=timedelta(minutes=5)).compute_as_of(
        tape, as_of=T0 + timedelta(minutes=9)
    )
    assert f.observed
    assert f.value == 1  # only the minute-9 swap is within the last 5 minutes


def test_trade_count_missing_before_first_trade() -> None:
    f = TradeCount().compute_as_of([], as_of=T0)
    assert f.status is FeatureStatus.MISSING_NOT_YET_AVAILABLE


# --------------------------------------------------------------------------- imbalance


def test_buy_sell_imbalance_signed_and_bounded() -> None:
    tape: list[TapeEvent] = [
        _swap(100, T0, side=Side.BUY, quote="3"),
        _swap(101, T0 + timedelta(seconds=1), side=Side.SELL, quote="1"),
    ]
    f = BuySellImbalance().compute_as_of(tape, as_of=T0 + timedelta(seconds=2))
    assert f.observed
    assert f.value == 0.5  # (3 - 1) / (3 + 1)


def test_buy_sell_imbalance_all_buys_is_plus_one() -> None:
    tape: list[TapeEvent] = [_swap(100, T0, side=Side.BUY, quote="2")]
    f = BuySellImbalance().compute_as_of(tape, as_of=T0)
    assert f.value == 1.0


def test_buy_sell_imbalance_not_applicable_with_zero_flow() -> None:
    """Trades exist historically but the in-window quote flow is exactly zero -> undefined ratio."""
    tape: list[TapeEvent] = [_swap(100, T0, side=Side.BUY, quote="0")]
    f = BuySellImbalance().compute_as_of(tape, as_of=T0)
    assert not f.observed
    assert f.status is FeatureStatus.MISSING_NOT_APPLICABLE


def test_buy_sell_imbalance_missing_before_first_trade() -> None:
    f = BuySellImbalance().compute_as_of([], as_of=T0)
    assert f.status is FeatureStatus.MISSING_NOT_YET_AVAILABLE


# --------------------------------------------------------------------------- inter-trade timing


def test_mean_inter_trade_seconds() -> None:
    tape: list[TapeEvent] = [
        _swap(100, T0),
        _swap(101, T0 + timedelta(seconds=10)),
        _swap(102, T0 + timedelta(seconds=30)),
    ]
    f = MeanInterTradeSeconds().compute_as_of(tape, as_of=T0 + timedelta(seconds=30))
    assert f.observed
    assert f.value == 15.0  # gaps of 10s and 20s -> mean 15s


def test_mean_inter_trade_not_applicable_with_single_trade() -> None:
    tape: list[TapeEvent] = [_swap(100, T0)]
    f = MeanInterTradeSeconds().compute_as_of(tape, as_of=T0)
    assert not f.observed
    assert f.status is FeatureStatus.MISSING_NOT_APPLICABLE  # need >=2 trades for a gap


def test_mean_inter_trade_missing_before_first_trade() -> None:
    f = MeanInterTradeSeconds().compute_as_of([], as_of=T0)
    assert f.status is FeatureStatus.MISSING_NOT_YET_AVAILABLE


# --------------------------------------------------------------------------- registry


def test_default_tier_a_features_are_all_tier_a_with_unique_names() -> None:
    feats = default_tier_a_features()
    names = [f.name for f in feats]
    assert len(names) == len(set(names))  # no slot-name collisions
    assert all(f.tier is FeatureTier.A_RAW_CHART for f in feats)
    assert {"price", "liquidity_quote", "rolling_volume_quote", "trade_count",
            "buy_sell_imbalance", "mean_inter_trade_secs"} == set(names)
