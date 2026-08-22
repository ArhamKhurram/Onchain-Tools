"""Tests for the effective-local-liquidity CLMM fill model (``sim/curves/clmm.py``).

Four things are pinned here, matching the honesty contract of the model:

1. **Registration + shape.** The three concentrated-liquidity venues resolve to
   ``ConcentratedLiquidityCurve``; a ``CLMMFill`` IS a ``CurveFill`` (subclass) so downstream is
   unaffected; the virtual reserves are the V3 ``(L/√P, L·√P)`` and the mid is ``P``.
2. **Exact WITHIN a range.** With ``L`` constant, the fill is exactly constant-product on the virtual
   reserves — reproduced bit-for-bit against the hand-computed closed form, and self-consistent under
   sequential propagation. The estimator recovers a constant ``L`` from impactful swaps to <1%.
3. **The identifiability caveat, made explicit.** Tiny (no-impact) swaps do not identify ``L`` — but
   they also barely depend on it, so the FILL stays accurate even when ``L`` is weakly fit. This is
   asserted, not hidden.
4. **Where it BREAKS, asserted.** An out-of-range order is returned FLAGGED (``in_range=False`` /
   ``confidence="low"``), never silently wrong; and a curve fit in one liquidity regime mis-predicts
   swaps after a tick crossing (``L`` stepped) by a wide, documented margin.

No network here. A real-tape fixture (``tests/fixtures/clmm_swaps.json``, written by
``scripts/clmm_local_liquidity_repro.py``) drives an offline real-data check when present.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import numpy as np
import pytest

from oct_trading_agent.core import Side
from oct_trading_agent.sim.amm.curve import CurveFill
from oct_trading_agent.sim.amm.pool import PoolState
from oct_trading_agent.sim.curves import (
    CLMM_VENUES,
    CLMMFill,
    ConcentratedLiquidityCurve,
    LocalSwapObservation,
    RollingLocalLiquidityEstimator,
    resolve_curve,
)
from oct_trading_agent.sim.curves.base import CurveInput
from oct_trading_agent.sim.curves.clmm import _virtual_reserves

_BPS = Decimal(10_000)
_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "clmm_swaps.json"


def _state(price: Decimal) -> PoolState:
    """A pool state whose mid == ``price`` (base=1, quote=price). Only the price ratio is read."""
    return PoolState(
        mint="pool",
        base_reserve=Decimal(1),
        quote_reserve=price,
        slot=1,
        block_time=datetime(2026, 1, 1, tzinfo=UTC),
        anchored=True,
    )


def _rel(a: Decimal, b: Decimal) -> Decimal:
    return abs(a - b) / abs(b)


def _generate_regime(
    liquidity: Decimal,
    p0: Decimal,
    fee_bps: int,
    orders: list[tuple[Side, Decimal]],
) -> tuple[list[dict[str, object]], Decimal]:
    """Drive the shipped curve at constant ``L`` to produce a ground-truth swap sequence.

    Returns per-swap records ``{side, amount_in, observed_out, mid_before}`` and the ending price.
    Because the generator IS the curve, a curve with the same ``L`` reproduces it exactly.
    """
    curve = ConcentratedLiquidityCurve(effective_liquidity=liquidity, fee_bps=fee_bps,
                                       valid_range_fraction=Decimal("0.5"))
    x_v, y_v = _virtual_reserves(liquidity, p0)
    records: list[dict[str, object]] = []
    for side, amount in orders:
        mid = y_v / x_v
        fill = curve.fill(CurveInput(side=side, amount_in=amount), _state(mid))
        out = fill.base_amount if side is Side.BUY else fill.quote_amount
        records.append({"side": side, "amount_in": amount, "observed_out": out, "mid_before": mid})
        x_v, y_v = fill.base_reserve_after, fill.quote_reserve_after
    return records, y_v / x_v


def _impactful_orders(liquidity: Decimal, p0: Decimal, n: int, seed: int) -> list[tuple[Side, Decimal]]:
    """A mix of buys/sells sized to move price ~0.5–2% of a pool with depth ``L`` at ``p0``."""
    rng = np.random.default_rng(seed)
    x_v, y_v = _virtual_reserves(liquidity, p0)  # y_v ~ quote depth, x_v ~ base depth
    orders: list[tuple[Side, Decimal]] = []
    for _ in range(n):
        if rng.random() < 0.5:
            frac = Decimal(str(round(float(rng.uniform(0.005, 0.02)), 5)))
            orders.append((Side.BUY, y_v * frac))
        else:
            frac = Decimal(str(round(float(rng.uniform(0.005, 0.02)), 5)))
            orders.append((Side.SELL, x_v * frac))
    return orders


# --------------------------------------------------------------------------------------------
# 1. Registration + shape
# --------------------------------------------------------------------------------------------


def test_clmm_venues_resolve_to_the_curve() -> None:
    assert set(CLMM_VENUES) == {"orca_whirlpool", "raydium_clmm", "meteora_dlmm"}
    for venue in CLMM_VENUES:
        curve = resolve_curve(venue)
        assert isinstance(curve, ConcentratedLiquidityCurve)
        assert venue in curve.venues


def test_clmm_fill_is_a_curvefill_subclass() -> None:
    curve = ConcentratedLiquidityCurve(effective_liquidity=Decimal(500_000), fee_bps=30)
    fill = curve.fill_buy(Decimal(1), _state(Decimal("0.0002")))
    assert isinstance(fill, CLMMFill)
    assert isinstance(fill, CurveFill)  # downstream reads the shared shape unchanged
    assert fill.reserves_are_virtual is True


def test_virtual_reserves_define_the_mid_and_k() -> None:
    liquidity, price = Decimal(750_000), Decimal("0.00031")
    x_v, y_v = _virtual_reserves(liquidity, price)
    assert _rel(y_v / x_v, price) < Decimal("1e-25")  # mid == P
    assert _rel(x_v * y_v, liquidity * liquidity) < Decimal("1e-20")  # x_v·y_v == L²


# --------------------------------------------------------------------------------------------
# 2. Exact within a range
# --------------------------------------------------------------------------------------------


@pytest.mark.parametrize("fee_bps", [0, 5, 30, 100])
def test_buy_matches_closed_form_virtual_reserve_math(fee_bps: int) -> None:
    liquidity, price, quote_in = Decimal(600_000), Decimal("0.00025"), Decimal(3)
    curve = ConcentratedLiquidityCurve(effective_liquidity=liquidity, fee_bps=fee_bps)
    fill = curve.fill_buy(quote_in, _state(price))

    x_v, y_v = _virtual_reserves(liquidity, price)
    dq_eff = quote_in * (Decimal(1) - Decimal(fee_bps) / _BPS)
    expected_base_out = x_v * dq_eff / (y_v + dq_eff)
    assert fill.base_amount == expected_base_out  # bit-for-bit, same Decimal ops
    assert fill.quote_amount == quote_in
    assert fill.executed_price == quote_in / expected_base_out
    # k_v preserved within the range: fee accrues OUTSIDE the virtual reserves.
    assert _rel(fill.base_reserve_after * fill.quote_reserve_after, liquidity * liquidity) < Decimal("1e-18")


@pytest.mark.parametrize("fee_bps", [0, 5, 30, 100])
def test_sell_matches_closed_form_virtual_reserve_math(fee_bps: int) -> None:
    liquidity, price, base_in = Decimal(600_000), Decimal("0.00025"), Decimal(20_000)
    curve = ConcentratedLiquidityCurve(effective_liquidity=liquidity, fee_bps=fee_bps)
    fill = curve.fill_sell(base_in, _state(price))

    x_v, y_v = _virtual_reserves(liquidity, price)
    db_eff = base_in * (Decimal(1) - Decimal(fee_bps) / _BPS)
    expected_quote_out = y_v * db_eff / (x_v + db_eff)
    assert fill.quote_amount == expected_quote_out
    assert fill.executed_price == expected_quote_out / base_in


def test_sequential_propagation_is_self_consistent() -> None:
    """Constant L: driving the curve swap-by-swap tracks a hand-rolled virtual-reserve replay.

    The curve is stateless — it rebuilds ``(x_v, y_v)`` from the state's mid via ``√P`` every call —
    so the match is to sub-ulp (``√`` round-trip in ``Decimal``), not bit-identical; k_v is preserved
    within the range so the running reserves stay on the ``L²`` hyperbola and the rebuild recovers them.
    """
    liquidity, p0, fee = Decimal(500_000), Decimal("0.0002"), Decimal(30) / _BPS
    curve = ConcentratedLiquidityCurve(effective_liquidity=liquidity, fee_bps=30,
                                       valid_range_fraction=Decimal("0.5"))
    x_v, y_v = _virtual_reserves(liquidity, p0)
    orders = [(Side.BUY, Decimal("2")), (Side.SELL, Decimal("8000")), (Side.BUY, Decimal("5"))]
    for side, amt in orders:
        mid = y_v / x_v
        fill = curve.fill(CurveInput(side=side, amount_in=amt), _state(mid))
        if side is Side.BUY:
            dq = amt * (Decimal(1) - fee)
            out = x_v * dq / (y_v + dq)
            assert _rel(fill.base_amount, out) < Decimal("1e-18")
            x_v, y_v = x_v - out, y_v + dq
        else:
            db = amt * (Decimal(1) - fee)
            out = y_v * db / (x_v + db)
            assert _rel(fill.quote_amount, out) < Decimal("1e-18")
            x_v, y_v = x_v + db, y_v - out
        assert _rel(fill.base_reserve_after, x_v) < Decimal("1e-18")
        assert _rel(fill.quote_reserve_after, y_v) < Decimal("1e-18")


def test_estimator_recovers_constant_liquidity() -> None:
    liquidity, p0, fee_bps = Decimal(800_000), Decimal("0.00015"), 30
    orders = _impactful_orders(liquidity, p0, n=45, seed=7)
    records, _ = _generate_regime(liquidity, p0, fee_bps, orders)
    obs = [
        LocalSwapObservation(side=r["side"], amount_in=r["amount_in"], observed_out=r["observed_out"])
        for r in records
    ]
    est = RollingLocalLiquidityEstimator(window=60, fee_bps=fee_bps).estimate(obs)
    assert _rel(est.effective_liquidity, liquidity) < Decimal("0.01")  # within 1%
    assert est.median_rel_error < Decimal("0.002")  # tight fit on single-regime data


# --------------------------------------------------------------------------------------------
# 3. The identifiability caveat, made explicit
# --------------------------------------------------------------------------------------------


def test_tiny_orders_are_insensitive_to_L() -> None:
    """A no-impact swap predicts nearly the same output under very different L — so a weakly-fit L
    still fills small orders accurately. (The flip side: tiny swaps cannot IDENTIFY L.)"""
    price, tiny = Decimal("0.0002"), Decimal("0.001")  # ~0.001 SOL into a >>1000 SOL depth
    lo = ConcentratedLiquidityCurve(effective_liquidity=Decimal(100_000), fee_bps=0)
    hi = ConcentratedLiquidityCurve(effective_liquidity=Decimal(10_000_000), fee_bps=0)
    out_lo = lo.fill_buy(tiny, _state(price)).base_amount
    out_hi = hi.fill_buy(tiny, _state(price)).base_amount
    # 100x difference in depth -> the small-order outputs still agree to well under 1%.
    assert _rel(out_lo, out_hi) < Decimal("0.005")
    # And both are ~ the no-impact limit (amount_in / price).
    assert _rel(out_hi, tiny / price) < Decimal("0.001")


# --------------------------------------------------------------------------------------------
# 4. Where it breaks — asserted, not hidden
# --------------------------------------------------------------------------------------------


def test_out_of_range_order_is_flagged_not_raised() -> None:
    curve = ConcentratedLiquidityCurve(
        effective_liquidity=Decimal(500_000), fee_bps=30, valid_range_fraction=Decimal("0.02")
    )
    price = Decimal("0.0002")
    small = curve.fill_buy(Decimal("0.5"), _state(price))
    assert small.in_range is True and small.confidence == "high"
    # A large order moves price well past the 2% valid range -> flagged, still returned (no raise).
    big = curve.fill_buy(Decimal(5_000), _state(price))
    assert big.in_range is False and big.confidence == "low"
    assert big.price_move_fraction > Decimal("0.02")
    assert big.base_amount > 0  # a number is returned, just marked untrustworthy


def test_tick_crossing_degrades_prediction() -> None:
    """Fit L in regime 1; after a 'tick crossing' L doubles. Predicting regime-2 swaps with the
    regime-1 curve is off by a wide margin — the model's documented failure mode."""
    fee_bps = 30
    l1, p0 = Decimal(500_000), Decimal("0.0002")
    orders1 = _impactful_orders(l1, p0, n=40, seed=3)
    reg1, p1 = _generate_regime(l1, p0, fee_bps, orders1)

    # Regime 2: liquidity steps up 4x at the new price (a tick crossing the single-window fit can't
    # see), so the regime-1 depth mis-prices every regime-2 impact term.
    l2 = l1 * 4
    orders2 = _impactful_orders(l2, p1, n=40, seed=9)
    reg2, _ = _generate_regime(l2, p1, fee_bps, orders2)

    obs1 = [
        LocalSwapObservation(side=r["side"], amount_in=r["amount_in"], observed_out=r["observed_out"])
        for r in reg1
    ]
    est = RollingLocalLiquidityEstimator(window=60, fee_bps=fee_bps).estimate(obs1)
    fitted = ConcentratedLiquidityCurve(effective_liquidity=est.effective_liquidity, fee_bps=fee_bps,
                                        valid_range_fraction=Decimal("0.5"))

    def median_err(records: list[dict[str, object]]) -> Decimal:
        errs = []
        for r in records:
            fill = fitted.fill(CurveInput(side=r["side"], amount_in=r["amount_in"]),
                               _state(r["mid_before"]))
            pred = fill.base_amount if r["side"] is Side.BUY else fill.quote_amount
            errs.append(_rel(pred, r["observed_out"]))
        return sorted(errs)[len(errs) // 2]

    err_in_regime = median_err(reg1)
    err_after_crossing = median_err(reg2)
    # In-regime prediction is tight; after the tick crossing it blows up by a wide margin.
    assert err_in_regime < Decimal("0.003")
    assert err_after_crossing > Decimal("0.02")
    assert err_after_crossing > err_in_regime * 8


def test_from_recent_swaps_builds_curve_and_estimate() -> None:
    liquidity, p0, fee_bps = Decimal(700_000), Decimal("0.00018"), 30
    orders = _impactful_orders(liquidity, p0, n=40, seed=5)
    records, _ = _generate_regime(liquidity, p0, fee_bps, orders)
    obs = [
        LocalSwapObservation(side=r["side"], amount_in=r["amount_in"], observed_out=r["observed_out"])
        for r in records
    ]
    curve, est = ConcentratedLiquidityCurve.from_recent_swaps(obs, fee_bps=fee_bps)
    assert isinstance(curve, ConcentratedLiquidityCurve)
    assert curve.effective_liquidity == est.effective_liquidity
    assert _rel(est.effective_liquidity, liquidity) < Decimal("0.02")


# --------------------------------------------------------------------------------------------
# Untradeable inputs raise (structural impossibility, distinct from out-of-range flagging)
# --------------------------------------------------------------------------------------------


def test_untradeable_inputs_raise() -> None:
    curve = ConcentratedLiquidityCurve(effective_liquidity=Decimal(500_000), fee_bps=30)
    with pytest.raises(ValueError):
        curve.fill_buy(Decimal(0), _state(Decimal("0.0002")))
    with pytest.raises(ValueError):
        curve.fill_sell(Decimal(-1), _state(Decimal("0.0002")))
    with pytest.raises(ValueError):
        curve.fill_buy(Decimal(1), _state(Decimal(0)))  # no positive price


def test_registry_template_without_liquidity_refuses_to_price() -> None:
    """The zero-arg registry template resolves for venue dispatch but cannot price without an L."""
    template = resolve_curve("orca_whirlpool")
    assert isinstance(template, ConcentratedLiquidityCurve)
    assert template.effective_liquidity is None
    with pytest.raises(ValueError, match="no effective_liquidity"):
        template.fill_buy(Decimal(1), _state(Decimal("0.0002")))


def test_construction_validation() -> None:
    with pytest.raises(ValueError):
        ConcentratedLiquidityCurve(effective_liquidity=Decimal(0))
    with pytest.raises(ValueError):
        ConcentratedLiquidityCurve(valid_range_fraction=Decimal(0))
    with pytest.raises(ValueError):
        RollingLocalLiquidityEstimator(window=2)


# --------------------------------------------------------------------------------------------
# Real-tape check (offline fixture from scripts/clmm_local_liquidity_repro.py)
# --------------------------------------------------------------------------------------------


def _load_fixture() -> dict[str, object] | None:
    if not _FIXTURE.exists():
        return None
    return json.loads(_FIXTURE.read_text(encoding="utf-8"))


def _walk_forward_real(
    swaps: list[LocalSwapObservation], fee_bps: int, window: int = 50
) -> tuple[list[float], list[float]]:
    """Causal walk-forward over real swaps. Returns (in_range_errors, out_of_range_errors)."""
    est = RollingLocalLiquidityEstimator(window=window, fee_bps=fee_bps)
    fee = float(est.fee_fraction)
    in_range: list[float] = []
    out_range: list[float] = []
    for i in range(window, len(swaps)):
        past = swaps[i - window : i]
        try:
            e = est.estimate(past)
        except ValueError:
            continue
        # Anchor the current mid by propagating the window through the fitted L (a float mirror of
        # the curve's law — cheap; the prediction itself uses the real Decimal curve).
        x_v, y_v = _virtual_reserves(e.effective_liquidity, e.reference_price)
        xf, yf = float(x_v), float(y_v)
        for s in past:
            amt = float(s.amount_in)
            if s.side is Side.BUY:
                dq = amt * (1.0 - fee)
                out = xf * dq / (yf + dq)
                xf, yf = xf - out, yf + dq
            else:
                db = amt * (1.0 - fee)
                out = yf * db / (xf + db)
                xf, yf = xf + db, yf - out
            if xf <= 0 or yf <= 0:
                break
        if xf <= 0 or yf <= 0:
            continue
        curve = ConcentratedLiquidityCurve(effective_liquidity=e.effective_liquidity, fee_bps=fee_bps)
        sw = swaps[i]
        try:
            fill = curve.fill(CurveInput(side=sw.side, amount_in=sw.amount_in),
                              _state(Decimal(str(yf / xf))))
        except ValueError:
            continue
        pred = fill.base_amount if sw.side is Side.BUY else fill.quote_amount
        err = float(_rel(pred, sw.observed_out))
        (in_range if fill.in_range else out_range).append(err)
    return in_range, out_range


@pytest.mark.parametrize("protocol", ["orca_whirlpool", "raydium_clmm", "meteora_dlmm"])
def test_real_tape_error_map_holds_where_documented(protocol: str) -> None:
    """The model's THESIS on real data: predictions are materially tighter IN the valid local range
    (small moves) than OUT of it (large moves / tick crossings). This is the error map the model
    exists to be honest about — asserted here, not just a single headline number. Skips a protocol
    absent from the fixture (its busy pools were not SOL-paired / deep enough at pull time)."""
    fixture = _load_fixture()
    if fixture is None or protocol not in fixture:
        pytest.skip(f"no fixture for {protocol}; run scripts/clmm_local_liquidity_repro.py")
    block = fixture[protocol]
    fee_bps = int(block["fee_bps"])
    swaps = [
        LocalSwapObservation(
            side=Side.BUY if s["side"] == "buy" else Side.SELL,
            amount_in=Decimal(str(s["amount_in"])),
            observed_out=Decimal(str(s["observed_out"])),
        )
        for s in block["swaps"]
    ]
    in_range, out_range = _walk_forward_real(swaps, fee_bps)

    assert len(in_range) >= 20, "too few in-range predictions to judge"
    in_median_bps = float(np.median(in_range)) * 1e4
    # Sanity ceiling: even the coarsest case (DLMM's constant-sum bins) predicts to the same order of
    # magnitude, not nonsense. Deliberately generous — the point is the RELATIVE map below.
    assert in_median_bps < 1500, f"{protocol} in-range median {in_median_bps:.0f}bps implausibly high"
    # The core claim: where the single-range assumption holds, the model is better than where it does
    # not. Only assert the ordering when there are enough out-of-range samples to have a stable median.
    if len(out_range) >= 8:
        out_median_bps = float(np.median(out_range)) * 1e4
        assert in_median_bps <= out_median_bps, (
            f"{protocol}: in-range {in_median_bps:.0f}bps should beat out-range {out_median_bps:.0f}bps"
        )
