"""Tier A — the "naked chart" raw-chart features (paper §3.2 Phase A, §7 pure-flow; 04 §2).

Every feature here is a pure function of the swap/liquidity tape **restricted to
``block_time <= as_of``** — price, liquidity, volume, trade count, buy/sell imbalance,
inter-trade timing — computed **without resolving any individual wallet** (that is Tier B).
No name, ticker, or text (Tier C+). This is the deliberately information-free starting point.

Two invariants make each feature leakage-auditable (see ``featurestore/leakage_audit``):

* **Causal by construction.** Each ``compute_as_of`` re-filters the tape to ``block_time <= as_of``
  *itself*. It never trusts the caller to have pre-filtered — this is exactly the property the
  standing leakage audit exploits (append future events → output must be identical).
* **Explicit missingness.** A value the token is "too young" to have yet is
  :attr:`FeatureStatus.MISSING_NOT_YET_AVAILABLE`; a value the tape doesn't *carry* (e.g. pool
  reserves absent from a decoded swap stream) is :attr:`FeatureStatus.MISSING_SOURCE_GAP`; a value
  that is undefined for the current state (e.g. imbalance with zero flow, an inter-trade gap with
  one trade) is :attr:`FeatureStatus.MISSING_NOT_APPLICABLE`. Never a silent zero.

The concrete window/count knobs live on each feature instance; the store registers one canonical
instance per slot name (:func:`default_tier_a_features`). Amounts are summed as ``Decimal`` to avoid
float drift, then narrowed to ``float`` for the :class:`Feature` payload.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from itertools import pairwise

from oct_trading_agent.core import (
    Feature,
    FeatureStatus,
    FeatureTier,
    FeatureValue,
    LiquidityEvent,
    PointInTimeFeature,
    Side,
    SwapEvent,
    TapeEvent,
)

# ---------------------------------------------------------------------------
# Small causal helpers. Each takes the RAW tape and does its own as_of filter,
# so a feature can never accidentally read the future by forgetting to filter.
# ---------------------------------------------------------------------------

_TIER = FeatureTier.A_RAW_CHART


def _swaps_at_or_before(tape: list[TapeEvent], as_of: datetime) -> list[SwapEvent]:
    """Swaps with ``block_time <= as_of``, ordered by the canonical slot key (then time).

    ``slot`` is Solana's deterministic ordering primitive (see ``core/tape.py``); ties are
    broken on ``block_time`` for stability. Filtering here is the causal firewall — the audit
    appends future swaps and asserts nothing downstream changes.
    """
    kept = [e for e in tape if isinstance(e, SwapEvent) and e.block_time <= as_of]
    kept.sort(key=lambda e: (e.slot, e.block_time))
    return kept


def _reserve_events_at_or_before(
    tape: list[TapeEvent], as_of: datetime
) -> list[SwapEvent | LiquidityEvent]:
    """Swap/liquidity events at/before ``as_of`` that *carry* an after-reserve, slot-ordered.

    Pool depth is reconstructed as-of from the most recent event carrying ``*_reserve_after``
    (04 §3 "as-of reconstruction"). Events that don't carry reserves are simply not returned —
    that is a source gap, surfaced by the caller as explicit missingness, not a zero.
    """
    kept: list[SwapEvent | LiquidityEvent] = [
        e
        for e in tape
        if isinstance(e, SwapEvent | LiquidityEvent)
        and e.block_time <= as_of
        and e.quote_reserve_after is not None
        and e.base_reserve_after is not None
    ]
    kept.sort(key=lambda e: (e.slot, e.block_time))
    return kept


def _swap_price(swap: SwapEvent) -> Decimal | None:
    """The swap's execution price (quote per base). Falls back to ``quote/base`` when the decoded
    stream omitted ``price`` but carried both legs. ``None`` if it cannot be determined."""
    if swap.price is not None:
        return swap.price
    if swap.base_amount > 0:
        return swap.quote_amount / swap.base_amount
    return None


def _observed(value: FeatureValue, as_of: datetime) -> Feature[FeatureValue]:
    return Feature(value=value, status=FeatureStatus.OBSERVED, as_of=as_of)


def _missing(status: FeatureStatus, as_of: datetime) -> Feature[FeatureValue]:
    return Feature(value=None, status=status, as_of=as_of)


# ---------------------------------------------------------------------------
# Features. Slotted dataclasses carrying only config (an optional window) plus the
# stable ``name``/``tier`` identifiers. Each structurally satisfies core.PointInTimeFeature
# (whose name/tier are declared writable, so these are not frozen). Treat instances as values.
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class LastPrice:
    """Last executed price (quote per base) at/before ``as_of``.

    Tape input: ``SwapEvent.price`` (or ``quote_amount/base_amount`` fallback). Missing
    (NOT_YET_AVAILABLE) until the first swap; NOT_APPLICABLE if the latest swap carries neither
    a price nor a usable amount pair.
    """

    name: str = "price"
    tier: FeatureTier = _TIER

    def compute_as_of(self, tape: list[TapeEvent], as_of: datetime) -> Feature[FeatureValue]:
        swaps = _swaps_at_or_before(tape, as_of)
        if not swaps:
            return _missing(FeatureStatus.MISSING_NOT_YET_AVAILABLE, as_of)
        last = swaps[-1]
        price = _swap_price(last)
        if price is None:
            return _missing(FeatureStatus.MISSING_NOT_APPLICABLE, last.block_time)
        return _observed(float(price), last.block_time)


@dataclass(slots=True)
class PoolLiquidityQuote:
    """Quote-side pool depth (SOL reserves) reconstructed as-of ``as_of``.

    Tape input: the most recent ``quote_reserve_after`` on a swap or liquidity event. Distinguishes
    two absences deliberately: NOT_YET_AVAILABLE when *no* event exists yet, vs SOURCE_GAP when
    events exist but the decoded stream never carried reserves (``sim/amm`` reconstructs them there,
    not here).
    """

    name: str = "liquidity_quote"
    tier: FeatureTier = _TIER

    def compute_as_of(self, tape: list[TapeEvent], as_of: datetime) -> Feature[FeatureValue]:
        any_event = any(
            isinstance(e, SwapEvent | LiquidityEvent) and e.block_time <= as_of for e in tape
        )
        events = _reserve_events_at_or_before(tape, as_of)
        if not events:
            status = (
                FeatureStatus.MISSING_SOURCE_GAP
                if any_event
                else FeatureStatus.MISSING_NOT_YET_AVAILABLE
            )
            return _missing(status, as_of)
        latest = events[-1]
        assert latest.quote_reserve_after is not None  # guaranteed by the filter
        return _observed(float(latest.quote_reserve_after), latest.block_time)


@dataclass(slots=True)
class RollingVolumeQuote:
    """Quote-denominated traded volume over the trailing ``window`` ending at ``as_of``.

    Tape input: ``SwapEvent.quote_amount`` for swaps in ``(as_of - window, as_of]``. Returns an
    OBSERVED ``0.0`` once the token is live (>=1 swap ever) but had no trades in-window — a genuine
    measured zero, not imputation. Missing (NOT_YET_AVAILABLE) only before the first trade ever.
    """

    window: timedelta = field(default=timedelta(minutes=5))
    name: str = "rolling_volume_quote"
    tier: FeatureTier = _TIER

    def compute_as_of(self, tape: list[TapeEvent], as_of: datetime) -> Feature[FeatureValue]:
        swaps = _swaps_at_or_before(tape, as_of)
        if not swaps:
            return _missing(FeatureStatus.MISSING_NOT_YET_AVAILABLE, as_of)
        floor = as_of - self.window
        in_window = [e for e in swaps if e.block_time > floor]
        total = sum((e.quote_amount for e in in_window), start=Decimal(0))
        latest_ts = in_window[-1].block_time if in_window else as_of
        return _observed(float(total), latest_ts)


@dataclass(slots=True)
class TradeCount:
    """Number of swaps at/before ``as_of``.

    Cumulative when ``window is None`` (the "how much has this pair traded at all" count that the
    Phase-0 vertical slice reads); windowed when a ``window`` is set. Tape input: ``SwapEvent``
    occurrences. Missing (NOT_YET_AVAILABLE) before the first trade — an unborn pair has no count,
    which is distinct from an observed count of zero in a trailing window.
    """

    window: timedelta | None = None
    name: str = "trade_count"
    tier: FeatureTier = _TIER

    def compute_as_of(self, tape: list[TapeEvent], as_of: datetime) -> Feature[FeatureValue]:
        swaps = _swaps_at_or_before(tape, as_of)
        if not swaps:
            return _missing(FeatureStatus.MISSING_NOT_YET_AVAILABLE, as_of)
        if self.window is None:
            return _observed(len(swaps), swaps[-1].block_time)
        floor = as_of - self.window
        in_window = [e for e in swaps if e.block_time > floor]
        latest_ts = in_window[-1].block_time if in_window else as_of
        return _observed(len(in_window), latest_ts)


@dataclass(slots=True)
class BuySellImbalance:
    """Volume-weighted buy/sell imbalance over the trailing ``window``: ``(buy - sell)/(buy + sell)``.

    The AMM-side order-flow-imbalance intuition (Cont-Kukanov-Stoikov, paper §7) restricted to
    Tier A: quote volume by side, no wallet resolution. Range ``[-1, 1]``: +1 all buy pressure,
    -1 all sell. Tape input: ``SwapEvent.side`` + ``quote_amount``. NOT_YET_AVAILABLE before any
    trade; NOT_APPLICABLE when in-window flow is exactly zero (imbalance undefined — 0/0).
    """

    window: timedelta = field(default=timedelta(minutes=5))
    name: str = "buy_sell_imbalance"
    tier: FeatureTier = _TIER

    def compute_as_of(self, tape: list[TapeEvent], as_of: datetime) -> Feature[FeatureValue]:
        swaps = _swaps_at_or_before(tape, as_of)
        if not swaps:
            return _missing(FeatureStatus.MISSING_NOT_YET_AVAILABLE, as_of)
        floor = as_of - self.window
        in_window = [e for e in swaps if e.block_time > floor]
        buy = sum((e.quote_amount for e in in_window if e.side is Side.BUY), start=Decimal(0))
        sell = sum((e.quote_amount for e in in_window if e.side is Side.SELL), start=Decimal(0))
        denom = buy + sell
        if denom == 0:
            return _missing(FeatureStatus.MISSING_NOT_APPLICABLE, as_of)
        latest_ts = in_window[-1].block_time if in_window else as_of
        return _observed(float((buy - sell) / denom), latest_ts)


@dataclass(slots=True)
class MeanInterTradeSeconds:
    """Mean seconds between consecutive swaps over the trailing ``window`` (a flow-cadence feature).

    Inter-trade time and its clustering are the pure-flow cadence signals of paper §7. Tape input:
    consecutive ``SwapEvent.block_time`` gaps. Needs >=2 in-window swaps to define a gap:
    NOT_YET_AVAILABLE with zero trades ever, NOT_APPLICABLE with a single in-window trade (no
    interval exists yet).
    """

    window: timedelta = field(default=timedelta(minutes=5))
    name: str = "mean_inter_trade_secs"
    tier: FeatureTier = _TIER

    def compute_as_of(self, tape: list[TapeEvent], as_of: datetime) -> Feature[FeatureValue]:
        swaps = _swaps_at_or_before(tape, as_of)
        if not swaps:
            return _missing(FeatureStatus.MISSING_NOT_YET_AVAILABLE, as_of)
        floor = as_of - self.window
        in_window = [e for e in swaps if e.block_time > floor]
        if len(in_window) < 2:
            return _missing(FeatureStatus.MISSING_NOT_APPLICABLE, as_of)
        times = [e.block_time for e in in_window]
        gaps = [(b - a).total_seconds() for a, b in pairwise(times)]
        mean_gap = sum(gaps) / len(gaps)
        return _observed(mean_gap, in_window[-1].block_time)


def default_tier_a_features() -> list[PointInTimeFeature]:
    """The canonical Tier-A slot set the point-in-time store registers.

    One instance per slot name; windowed features default to a 5-minute trailing window and
    ``trade_count`` is cumulative (matching the Phase-0 vertical slice). Order is stable so the
    standing audit iterates deterministically.
    """
    return [
        LastPrice(),
        PoolLiquidityQuote(),
        RollingVolumeQuote(),
        TradeCount(),
        BuySellImbalance(),
        MeanInterTradeSeconds(),
    ]
