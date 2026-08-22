"""Tests for the multi-venue curve abstraction (``sim/curves``).

Three things are pinned here:

1. **The refactor changed no results.** ``ConstantProductCurve`` must reproduce the closed-form
   ``fill_buy``/``fill_sell`` bit-for-bit, and a zero-fee ``PumpFunAmmCurve`` must equal the zero-fee
   constant-product law (the pump AMM *is* ``x·y=k`` — only its fee treatment differs).
2. **The venue resolver is explicit.** Known venues resolve to the right curve; unknown venues yield
   a typed unsupported result / raise ``UnsupportedVenueError`` — never a silent constant-product
   fallback.
3. **The pump.fun fee stack is modelled correctly.** Fee-on-top for buys (SDK ``buyQuoteInput``),
   fee-out-of-output for sells, and LP-only reserve retention (protocol+creator leave the pool).
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from oct_trading_agent.core import Side, SwapEvent
from oct_trading_agent.sim.amm.curve import fill_buy, fill_sell
from oct_trading_agent.sim.amm.pool import PoolState
from oct_trading_agent.sim.curves import (
    ConstantProductCurve,
    Curve,
    CurveInput,
    CurveRegistry,
    FeeSplit,
    PumpFunAmmCurve,
    PumpFunAmmFeeSchedule,
    UnsupportedVenueError,
    register_curve,
    resolve_curve,
    try_resolve_curve,
)
from oct_trading_agent.sim.curves.registry import DEFAULT_REGISTRY

_BPS = Decimal(10_000)
R_B = Decimal(1_000_000)
R_Q = Decimal(100)


def _state(base: Decimal = R_B, quote: Decimal = R_Q) -> PoolState:
    return PoolState(
        mint="Mint111",
        base_reserve=base,
        quote_reserve=quote,
        slot=100,
        block_time=datetime(2026, 1, 1, tzinfo=UTC),
        anchored=True,
    )


def _rel(a: Decimal, b: Decimal) -> Decimal:
    return abs(a - b) / abs(b)


# --------------------------------------------------------------------------------------------
# 1. Refactor is result-preserving
# --------------------------------------------------------------------------------------------


@pytest.mark.parametrize("fee_bps", [0, 25, 30, 100])
def test_constant_product_curve_matches_closed_form_buy(fee_bps: int) -> None:
    curve = ConstantProductCurve(fee_bps=fee_bps)
    got = curve.fill_buy(Decimal(10), _state())
    want = fill_buy(Decimal(10), R_B, R_Q, Decimal(fee_bps) / _BPS)
    assert got == want


@pytest.mark.parametrize("fee_bps", [0, 25, 30, 100])
def test_constant_product_curve_matches_closed_form_sell(fee_bps: int) -> None:
    curve = ConstantProductCurve(fee_bps=fee_bps)
    got = curve.fill_sell(Decimal(50_000), _state())
    want = fill_sell(Decimal(50_000), R_B, R_Q, Decimal(fee_bps) / _BPS)
    assert got == want


def test_curve_input_dispatch_matches_convenience_wrappers() -> None:
    curve = ConstantProductCurve(fee_bps=25)
    st = _state()
    assert curve.fill(CurveInput(Side.BUY, Decimal(10)), st) == curve.fill_buy(Decimal(10), st)
    assert curve.fill(CurveInput(Side.SELL, Decimal(5)), st) == curve.fill_sell(Decimal(5), st)


def test_zero_fee_pumpfun_equals_zero_fee_constant_product() -> None:
    """The pump AMM obeys x·y=k; with the fee stack zeroed it must equal the plain CPMM law."""
    pump = PumpFunAmmCurve(fee=FeeSplit(Decimal(0), Decimal(0), Decimal(0)))
    st = _state()
    assert pump.fill_buy(Decimal(10), st) == fill_buy(Decimal(10), R_B, R_Q, Decimal(0))
    assert pump.fill_sell(Decimal(50_000), st) == fill_sell(Decimal(50_000), R_B, R_Q, Decimal(0))


# --------------------------------------------------------------------------------------------
# 2. Venue resolver — explicit support, typed unsupported
# --------------------------------------------------------------------------------------------


def test_default_registry_resolves_known_venues() -> None:
    assert isinstance(resolve_curve("pumpfun_amm"), PumpFunAmmCurve)
    for venue in ("raydium_amm_v4", "raydium_cpmm", "cpmm", "meteora_amm"):
        assert isinstance(resolve_curve(venue), ConstantProductCurve)


def test_unsupported_venue_is_typed_never_falls_back() -> None:
    # NOTE (Wave-2 Agent F): this used ``raydium_clmm`` as the unsupported placeholder, but the CLMM
    # curve now registers that venue. ``jupiter_v6`` is the durable unsupported case — a router that
    # must be resolved per hop, never priced directly (KNOWN_UNSUPPORTED), so it stays typed-absent.
    res = try_resolve_curve("jupiter_v6")
    assert res.supported is False
    assert res.curve is None
    assert res.reason is not None and "router" in res.reason
    with pytest.raises(UnsupportedVenueError) as exc:
        resolve_curve("jupiter_v6")
    assert exc.value.protocol == "jupiter_v6"


def test_missing_protocol_resolves_to_unsupported() -> None:
    res = try_resolve_curve(None)
    assert res.supported is False
    with pytest.raises(UnsupportedVenueError):
        res.unwrap()


def test_resolve_for_swap_reads_protocol_tag() -> None:
    def swap(protocol: str | None) -> SwapEvent:
        return SwapEvent(
            mint="Mint111",
            slot=1,
            block_time=datetime(2026, 1, 1, tzinfo=UTC),
            signer="w",
            side=Side.BUY,
            base_amount=Decimal(1),
            quote_amount=Decimal(1),
            protocol=protocol,
        )

    assert isinstance(DEFAULT_REGISTRY.resolve_for_swap(swap("pumpfun_amm")), PumpFunAmmCurve)
    assert DEFAULT_REGISTRY.try_resolve_for_swap(swap("pumpfun")).supported is False
    with pytest.raises(UnsupportedVenueError):
        DEFAULT_REGISTRY.resolve_for_swap(swap(None))


def test_registered_curves_are_curve_instances_and_advertise_venues() -> None:
    for venue in DEFAULT_REGISTRY.supported_venues():
        curve = resolve_curve(venue)
        assert isinstance(curve, Curve)
        assert venue in curve.venues


# --------------------------------------------------------------------------------------------
# Registry mechanics — isolation, duplicate protection, custom registration
# --------------------------------------------------------------------------------------------


def test_custom_registry_is_isolated_and_pluggable() -> None:
    reg = CurveRegistry()
    assert reg.supported_venues() == frozenset()

    @register_curve("my_amm", registry=reg)
    class _MyCurve(ConstantProductCurve):
        venues = ("my_amm",)

    assert isinstance(reg.resolve("my_amm"), _MyCurve)
    # Registration into a private registry must not leak into the process-wide default.
    assert "my_amm" not in DEFAULT_REGISTRY.supported_venues()


def test_duplicate_registration_is_rejected_unless_replaced() -> None:
    reg = CurveRegistry()
    reg.register("v", factory=ConstantProductCurve)
    with pytest.raises(ValueError, match="already has a registered Curve"):
        reg.register("v", factory=PumpFunAmmCurve)
    reg.register("v", factory=PumpFunAmmCurve, replace=True)
    assert isinstance(reg.resolve("v"), PumpFunAmmCurve)


def test_register_requires_a_protocol_name() -> None:
    reg = CurveRegistry()
    with pytest.raises(ValueError):
        reg.register(factory=ConstantProductCurve)
    with pytest.raises(ValueError):
        reg.register("  ", factory=ConstantProductCurve)


# --------------------------------------------------------------------------------------------
# 3. pump.fun fee stack
# --------------------------------------------------------------------------------------------


def test_fee_split_totals_and_shares() -> None:
    split = FeeSplit(lp_bps=Decimal(20), protocol_bps=Decimal(5), creator_bps=Decimal(5))
    assert split.total_bps == Decimal(30)
    assert split.pool_retained_bps == Decimal(20)
    assert split.lp_share_of_total == Decimal(20) / Decimal(30)


def test_fee_split_validation() -> None:
    with pytest.raises(ValueError):
        FeeSplit(lp_bps=Decimal(-1), protocol_bps=Decimal(0), creator_bps=Decimal(0))
    with pytest.raises(ValueError):
        FeeSplit(lp_bps=Decimal(9000), protocol_bps=Decimal(1000), creator_bps=Decimal(1))


def test_fee_schedule_tiers() -> None:
    sched = PumpFunAmmFeeSchedule()
    assert sched.split_for_market_cap_sol(Decimal(100)).total_bps == Decimal(125)
    assert sched.split_for_market_cap_sol(Decimal(1000)).total_bps == Decimal(120)
    assert sched.split_for_market_cap_sol(Decimal(500_000)).total_bps == Decimal(30)
    # Unknown market cap -> the mature default tier (what busy graduated pools trade at).
    assert sched.split_for_market_cap_sol(None).total_bps == Decimal(30)
    with pytest.raises(ValueError):
        sched.split_for_market_cap_sol(Decimal(-1))


def test_for_market_cap_sol_builds_tiered_curve() -> None:
    young = PumpFunAmmCurve.for_market_cap_sol(Decimal(100))
    mature = PumpFunAmmCurve.for_market_cap_sol(Decimal(500_000))
    assert young.fee.total_bps == Decimal(125)
    assert mature.fee.total_bps == Decimal(30)


def test_pumpfun_buy_uses_fee_on_top_form() -> None:
    """BUY implements the SDK's buyQuoteInput: effective_quote = quote_in·10000/(10000+total)."""
    fee = FeeSplit(lp_bps=Decimal(20), protocol_bps=Decimal(5), creator_bps=Decimal(5))
    curve = PumpFunAmmCurve(fee=fee)
    quote_in = Decimal(10)
    fill = curve.fill_buy(quote_in, _state())

    effective_quote = quote_in * _BPS / (_BPS + fee.total_bps)
    expected_base_out = R_B * effective_quote / (R_Q + effective_quote)
    assert _rel(fill.base_amount, expected_base_out) < Decimal("1e-25")
    # Gross price paid embeds the whole fee, so it is worse (higher) than the pre-trade mid.
    assert fill.executed_price > fill.mid_price_before
    assert fill.slippage_bps > 0


def test_pumpfun_sell_takes_fee_out_of_output() -> None:
    fee = FeeSplit(lp_bps=Decimal(20), protocol_bps=Decimal(5), creator_bps=Decimal(5))
    curve = PumpFunAmmCurve(fee=fee)
    base_in = Decimal(50_000)
    fill = curve.fill_sell(base_in, _state())

    gross_quote_out = R_Q * base_in / (R_B + base_in)
    expected_user_out = gross_quote_out * (_BPS - fee.total_bps) / _BPS
    assert _rel(fill.quote_amount, expected_user_out) < Decimal("1e-25")
    # The trader receives less than mid per token -> executed price below mid.
    assert fill.executed_price < fill.mid_price_before


def test_pumpfun_lp_fee_stays_in_pool_others_leave() -> None:
    """LP fee grows k; a pure protocol/creator fee does not (it leaves the reserves)."""
    st = _state()
    k0 = R_B * R_Q

    lp_only = PumpFunAmmCurve(fee=FeeSplit(Decimal(30), Decimal(0), Decimal(0)))
    lp_fill = lp_only.fill_buy(Decimal(10), st)
    assert lp_fill.base_reserve_after * lp_fill.quote_reserve_after > k0  # retained -> k grows

    out_only = PumpFunAmmCurve(fee=FeeSplit(Decimal(0), Decimal(15), Decimal(15)))
    out_fill = out_only.fill_buy(Decimal(10), st)
    # Protocol+creator leave the pool: the invariant is preserved (no k growth from fees).
    k_after = out_fill.base_reserve_after * out_fill.quote_reserve_after
    assert _rel(k_after, k0) < Decimal("1e-25")


def test_higher_total_fee_is_worse_for_the_trader() -> None:
    st = _state()
    lo = PumpFunAmmCurve(fee=FeeSplit(Decimal(20), Decimal(5), Decimal(5)))  # 30 bps
    hi = PumpFunAmmCurve(fee=FeeSplit(Decimal(20), Decimal(5), Decimal(100)))  # 125 bps
    # BUY: more fee -> higher price paid, less base received.
    assert hi.fill_buy(Decimal(10), st).executed_price > lo.fill_buy(Decimal(10), st).executed_price
    assert hi.fill_buy(Decimal(10), st).base_amount < lo.fill_buy(Decimal(10), st).base_amount
    # SELL: more fee -> less SOL received.
    assert hi.fill_sell(Decimal(5_000), st).quote_amount < lo.fill_sell(Decimal(5_000), st).quote_amount


def test_pumpfun_rejects_untradeable_inputs() -> None:
    curve = PumpFunAmmCurve()
    with pytest.raises(ValueError):
        curve.fill_buy(Decimal(0), _state())
    with pytest.raises(ValueError):
        curve.fill_sell(Decimal(-1), _state())
    with pytest.raises(ValueError):
        curve.fill_buy(Decimal(1), _state(base=Decimal(0)))
