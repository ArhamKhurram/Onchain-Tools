"""Tests for the pump.fun pre-migration bonding curve (``sim/curves/bonding_curve.py``).

Two kinds of check:

1. **Synthetic, fully deterministic.** The bonding curve is a closed formula over KNOWN constants, so
   every fill is exactly predictable — the analytic form (fee-on-top buy, fee-out-of-output sell),
   exact ``k`` preservation (fees are external, nothing is retained), the graduation cap, and the
   post-graduation handoff are all pinned to exact expected values.
2. **Fixture-driven real data.** A recorded sequence of real ``pumpfun`` bonding-curve swaps for one
   token from creation is replayed from the on-chain initial reserves through the real curve object;
   the per-swap residual must stay at fee-rounding scale. No network here — the pull lives in a
   throwaway script; this test is offline against the captured fixture.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import pytest

from oct_trading_agent.core import Side
from oct_trading_agent.sim.amm.curve import fill_buy, fill_sell
from oct_trading_agent.sim.amm.pool import PoolState
from oct_trading_agent.sim.curves import (
    BondingCurveComplete,
    BondingCurveFee,
    BondingCurveParams,
    Curve,
    CurveInput,
    PumpFunBondingCurve,
    resolve_curve,
    try_resolve_curve,
)

_BPS = Decimal(10_000)
_FIXTURE = Path(__file__).parent / "fixtures" / "pumpfun_bonding_curve_swaps.json"


def _rel(a: Decimal, b: Decimal) -> Decimal:
    return abs(a - b) / abs(b)


def _state(base: Decimal, quote: Decimal) -> PoolState:
    return PoolState(
        mint="bc",
        base_reserve=base,
        quote_reserve=quote,
        slot=1,
        block_time=datetime(2026, 1, 1, tzinfo=UTC),
        anchored=True,
    )


# Small, round custom seeds — arbitrary units, chosen so cap/graduation are exact and hand-checkable.
_SMALL = BondingCurveParams(
    initial_virtual_token_reserves=Decimal(1000),
    initial_virtual_sol_reserves=Decimal(10),
    initial_real_token_reserves=Decimal(200),
    token_total_supply=Decimal(1000),
)


# --------------------------------------------------------------------------------------------
# Registration / resolution
# --------------------------------------------------------------------------------------------


def test_bonding_curve_is_registered_for_pumpfun() -> None:
    curve = resolve_curve("pumpfun")
    assert isinstance(curve, PumpFunBondingCurve)
    assert isinstance(curve, Curve)
    assert "pumpfun" in curve.venues
    # And no longer a "known unsupported" gap.
    assert try_resolve_curve("pumpfun").supported is True


# --------------------------------------------------------------------------------------------
# On-chain seed constants
# --------------------------------------------------------------------------------------------


def test_mainnet_ui_seeds_match_published_constants() -> None:
    p = BondingCurveParams.mainnet_ui()
    assert p.initial_virtual_token_reserves == Decimal("1073000000")
    assert p.initial_virtual_sol_reserves == Decimal("30")
    assert p.initial_real_token_reserves == Decimal("793100000")
    assert p.token_total_supply == Decimal("1000000000")


def test_default_fee_is_125bps_stack() -> None:
    curve = PumpFunBondingCurve()
    assert curve.fee.protocol_bps == Decimal(95)
    assert curve.fee.creator_bps == Decimal(30)
    assert curve.fee.total_bps == Decimal(125)


# --------------------------------------------------------------------------------------------
# Fill law — analytic, exact
# --------------------------------------------------------------------------------------------


def test_buy_uses_fee_on_top_form() -> None:
    curve = PumpFunBondingCurve()  # mainnet seeds, 125 bps
    v_token = Decimal("1073000000")
    v_sol = Decimal("30")
    sol_in = Decimal("1")
    fill = curve.fill_buy(sol_in, _state(v_token, v_sol))

    effective = sol_in * _BPS / (_BPS + Decimal(125))
    expected_out = v_token * effective / (v_sol + effective)
    assert _rel(fill.base_amount, expected_out) < Decimal("1e-25")
    # Fees are external: only the net enters the pool.
    assert _rel(fill.quote_reserve_after, v_sol + effective) < Decimal("1e-25")
    assert fill.executed_price > fill.mid_price_before  # gross price embeds the fee -> worse than mid
    assert fill.slippage_bps > 0


def test_sell_takes_fee_out_of_output() -> None:
    curve = PumpFunBondingCurve()
    v_token = Decimal("1073000000")
    v_sol = Decimal("30")
    tokens_in = Decimal("5000000")
    fill = curve.fill_sell(tokens_in, _state(v_token, v_sol))

    gross = v_sol * tokens_in / (v_token + tokens_in)
    expected_user_out = gross * (_BPS - Decimal(125)) / _BPS
    assert _rel(fill.quote_amount, expected_user_out) < Decimal("1e-25")
    # The whole gross leaves the reserve (fee is skimmed to recipients, not pooled).
    assert _rel(fill.quote_reserve_after, v_sol - gross) < Decimal("1e-25")
    assert fill.executed_price < fill.mid_price_before  # trader receives less than mid


def test_k_is_preserved_exactly_both_sides() -> None:
    """Fees are entirely external -> the invariant is preserved exactly (unlike CPMM / pump AMM)."""
    v_token, v_sol = Decimal("1073000000"), Decimal("30")
    k0 = v_token * v_sol
    curve = PumpFunBondingCurve()

    buy = curve.fill_buy(Decimal("2"), _state(v_token, v_sol))
    assert _rel(buy.base_reserve_after * buy.quote_reserve_after, k0) < Decimal("1e-22")

    sell = curve.fill_sell(Decimal("4000000"), _state(v_token, v_sol))
    assert _rel(sell.base_reserve_after * sell.quote_reserve_after, k0) < Decimal("1e-22")


def test_zero_fee_bonding_equals_zero_fee_constant_product() -> None:
    """With the fee zeroed, the bonding fill (fully external, k-preserving) equals the zero-fee CPMM
    law: the plain ``fill_buy``/``fill_sell`` retain the *whole* input, which at zero fee is the net."""
    v_token, v_sol = Decimal("1073000000"), Decimal("30")
    curve = PumpFunBondingCurve(fee=BondingCurveFee(Decimal(0), Decimal(0)))
    st = _state(v_token, v_sol)

    got_buy = curve.fill_buy(Decimal("3"), st)
    want_buy = fill_buy(Decimal("3"), v_token, v_sol, Decimal(0))
    assert _rel(got_buy.base_amount, want_buy.base_amount) < Decimal("1e-25")
    assert _rel(got_buy.quote_reserve_after, want_buy.quote_reserve_after) < Decimal("1e-25")

    got_sell = curve.fill_sell(Decimal("5000000"), st)
    want_sell = fill_sell(Decimal("5000000"), v_token, v_sol, Decimal(0))
    assert _rel(got_sell.quote_amount, want_sell.quote_amount) < Decimal("1e-25")


def test_higher_total_fee_is_worse_for_the_trader() -> None:
    v_token, v_sol = Decimal("1073000000"), Decimal("30")
    st = _state(v_token, v_sol)
    lo = PumpFunBondingCurve(fee=BondingCurveFee(Decimal(95), Decimal(30)))  # 125
    hi = PumpFunBondingCurve(fee=BondingCurveFee(Decimal(200), Decimal(100)))  # 300
    assert hi.fill_buy(Decimal("1"), st).base_amount < lo.fill_buy(Decimal("1"), st).base_amount
    assert hi.fill_sell(Decimal("5000000"), st).quote_amount < lo.fill_sell(Decimal("5000000"), st).quote_amount


# --------------------------------------------------------------------------------------------
# Real-token derivation & graduation
# --------------------------------------------------------------------------------------------


def test_real_token_reserves_and_progress_derivation() -> None:
    curve = PumpFunBondingCurve(params=_SMALL)
    # At the seed virtual reserve: full float, zero progress.
    fresh = _state(Decimal(1000), Decimal(10))
    assert curve.real_token_reserves(fresh) == Decimal(200)
    assert curve.graduation_progress(fresh) == Decimal(0)
    assert curve.is_complete(fresh) is False
    # After 150 tokens sold (virtual token 1000 -> 850): real float 200 -> 50, progress 0.75.
    mid = _state(Decimal(850), Decimal("12"))
    assert curve.real_token_reserves(mid) == Decimal(50)
    assert curve.graduation_progress(mid) == Decimal("0.75")
    assert curve.is_complete(mid) is False


def test_buy_caps_at_real_float_and_graduates() -> None:
    curve = PumpFunBondingCurve(params=_SMALL)  # real float = 200 tokens
    st = _state(Decimal(1000), Decimal(10))
    # A huge buy would want far more than 200 tokens -> capped at the remaining real float.
    fill = curve.fill_buy(Decimal("1000000"), st)
    assert fill.base_amount == Decimal(200)  # exactly the remaining real tokens
    # SOL charged corresponds to exactly those 200 tokens (invariant inverted), + fee on top.
    eff_needed = Decimal(10) * Decimal(200) / (Decimal(1000) - Decimal(200))  # 2.5
    expected_gross = eff_needed * (_BPS + Decimal(125)) / _BPS
    assert _rel(fill.quote_amount, expected_gross) < Decimal("1e-25")
    # Post-fill virtual token reserve = 800 -> real float exhausted -> curve complete.
    after = _state(fill.base_reserve_after, fill.quote_reserve_after)
    assert curve.real_token_reserves(after) == Decimal(0)
    assert curve.is_complete(after) is True
    assert curve.graduation_progress(after) == Decimal(1)


def test_fill_on_graduated_curve_raises_complete() -> None:
    curve = PumpFunBondingCurve(params=_SMALL)
    graduated = _state(Decimal(800), Decimal("12.5"))  # real float == 0
    assert curve.is_complete(graduated) is True
    with pytest.raises(BondingCurveComplete) as exc:
        curve.fill_buy(Decimal("1"), graduated)
    assert exc.value.real_token_reserves <= 0
    with pytest.raises(BondingCurveComplete):
        curve.fill_sell(Decimal("1"), graduated)


def test_exact_fill_to_the_last_real_token_graduates() -> None:
    """A buy sized to consume precisely the remaining float graduates without over-extrapolating."""
    curve = PumpFunBondingCurve(params=_SMALL)
    st = _state(Decimal(1000), Decimal(10))
    # SOL that buys exactly 200 tokens: eff = 2.5, gross = 2.5 * 1.0125.
    gross = Decimal("2.5") * (_BPS + Decimal(125)) / _BPS
    fill = curve.fill_buy(gross, st)
    assert _rel(fill.base_amount, Decimal(200)) < Decimal("1e-25")
    assert curve.is_complete(_state(fill.base_reserve_after, fill.quote_reserve_after)) is True


# --------------------------------------------------------------------------------------------
# Scale invariance (raw vs UI units)
# --------------------------------------------------------------------------------------------


def test_raw_and_ui_curves_agree_on_graduation_fraction() -> None:
    """The same *fraction* of the float sold must read identically whether priced in UI or raw units."""
    ui = PumpFunBondingCurve(params=BondingCurveParams.mainnet_ui())
    raw = PumpFunBondingCurve(params=BondingCurveParams.mainnet_raw())
    # Sell-side-of-float: 100M tokens sold, in each unit system.
    ui_state = _state(Decimal("1073000000") - Decimal("100000000"), Decimal("40"))
    raw_state = _state(
        Decimal("1073000000000000") - Decimal("100000000000000"), Decimal("40000000000")
    )
    assert _rel(ui.graduation_progress(ui_state), raw.graduation_progress(raw_state)) < Decimal("1e-25")


# --------------------------------------------------------------------------------------------
# Validation guards
# --------------------------------------------------------------------------------------------


def test_rejects_untradeable_inputs() -> None:
    curve = PumpFunBondingCurve()
    st = _state(Decimal("1073000000"), Decimal("30"))
    with pytest.raises(ValueError):
        curve.fill_buy(Decimal(0), st)
    with pytest.raises(ValueError):
        curve.fill_sell(Decimal(-1), st)
    with pytest.raises(ValueError):
        curve.fill_buy(Decimal(1), _state(Decimal(0), Decimal(30)))


def test_fee_validation() -> None:
    with pytest.raises(ValueError):
        BondingCurveFee(protocol_bps=Decimal(-1), creator_bps=Decimal(0))
    with pytest.raises(ValueError):
        BondingCurveFee(protocol_bps=Decimal(9000), creator_bps=Decimal(1000))


def test_params_validation() -> None:
    with pytest.raises(ValueError):
        BondingCurveParams(
            initial_virtual_token_reserves=Decimal(0),
            initial_virtual_sol_reserves=Decimal(30),
            initial_real_token_reserves=Decimal(10),
            token_total_supply=Decimal(1000),
        )
    with pytest.raises(ValueError):
        # real cannot exceed virtual token reserves
        BondingCurveParams(
            initial_virtual_token_reserves=Decimal(100),
            initial_virtual_sol_reserves=Decimal(30),
            initial_real_token_reserves=Decimal(200),
            token_total_supply=Decimal(1000),
        )


# --------------------------------------------------------------------------------------------
# Fixture-driven real-data reproduction (offline)
# --------------------------------------------------------------------------------------------


def _median(xs: list[Decimal]) -> Decimal:
    s = sorted(xs)
    return s[len(s) // 2]


def test_reproduces_real_bonding_curve_tape() -> None:
    """Anchor at the KNOWN seed virtual reserves and reproduce one real token's curve life.

    The fixture is one token's complete bonding-curve life from creation — its first swap sits at the
    on-chain seed price (``v_sol/v_token = 30/1.073e9``), captured in one atomic page so the sequence
    is contiguous (no offset-pagination gaps). Pinax records CURVE-LEVEL (fee-exclusive) amounts.
    Three things are pinned against this real tape:

    1. **Law + seed constants are exact.** The pure constant-product invariant (fee zeroed) reproduces
       every real BUY's token output to rounding — the strong evidence that ``x·y=k`` on the virtual
       reserves, anchored at 1.073e9 / 30, is the right law with the right constants.
    2. **The 125 bps trader fee is wired on top.** The default curve (fee stack on) predicts ~125 bps
       fewer tokens than the fee-exclusive amount — exactly the documented trader fee sitting on top
       of the curve leg, in the right direction and magnitude.
    3. **Sells reproduce within the Pinax sell-output convention.** Pinax's SELL SOL-out sits ~1%
       above the pure curve gross (a recording-convention offset, constant across the tape and
       independent of fee), so the curve gross reproduces observed sells to within a couple percent.
    """
    fixture = json.loads(_FIXTURE.read_text())
    seed_b = Decimal(str(fixture["initial_virtual_token_reserves_ui"]))
    seed_q = Decimal(str(fixture["initial_virtual_sol_reserves_ui"]))

    # The first swap must sit at the seed price (proof the fixture is anchored at creation).
    first = fixture["swaps"][0]
    first_mid = (
        Decimal(str(first["amount_in"])) / Decimal(str(first["observed_out"]))
        if first["side"] == "buy"
        else Decimal(str(first["observed_out"])) / Decimal(str(first["amount_in"]))
    )
    assert _rel(first_mid, seed_q / seed_b) < Decimal("0.03")

    pure = PumpFunBondingCurve(fee=BondingCurveFee(Decimal(0), Decimal(0)))  # curve-level invariant
    priced = PumpFunBondingCurve(  # documented 125 bps trader-fee stack
        fee=BondingCurveFee(
            protocol_bps=Decimal(str(fixture["fee_protocol_bps"])),
            creator_bps=Decimal(str(fixture["fee_creator_bps"])),
        )
    )
    base, quote = seed_b, seed_q
    buy_pure_resid: list[Decimal] = []
    buy_fee_signed: list[Decimal] = []
    sell_ratio: list[Decimal] = []
    for sw in fixture["swaps"]:
        side = Side.BUY if sw["side"] == "buy" else Side.SELL
        amount_in = Decimal(str(sw["amount_in"]))
        observed = Decimal(str(sw["observed_out"]))
        state = _state(base, quote)
        pure_fill = pure.fill(CurveInput(side=side, amount_in=amount_in), state)
        if side is Side.BUY:
            buy_pure_resid.append(abs(pure_fill.base_amount / observed - Decimal(1)))
            priced_fill = priced.fill(CurveInput(side=side, amount_in=amount_in), state)
            buy_fee_signed.append(priced_fill.base_amount / observed - Decimal(1))
            base -= observed  # advance by observed (fee-exclusive curve deltas)
            quote += amount_in
        else:
            sell_ratio.append(observed / pure_fill.quote_amount)  # observed SOL / curve gross
            base += amount_in
            quote -= pure_fill.quote_amount

    assert len(buy_pure_resid) >= 15
    # 1. Pure invariant reproduces real buys essentially exactly (law + seed constants correct).
    assert _median(buy_pure_resid) < Decimal("0.0025")  # < 25 bps
    # 2. The 125 bps trader fee is applied on top -> buys get ~1.25% fewer tokens than fee-exclusive.
    assert Decimal("-0.016") < _median(buy_fee_signed) < Decimal("-0.009")
    # 3. Pinax sell SOL-out sits ~1% above the pure curve gross (recording convention), within a few %.
    assert Decimal("0.98") < _median(sell_ratio) < Decimal("1.03")
