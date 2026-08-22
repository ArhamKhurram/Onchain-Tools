"""Calibration harness: analytic self-reproduction, fee sensitivity, and a Parquet round-trip.

On synthetic pools the sim reproduces its own generating math to ~0 bps — the closed-form guarantee
that makes the Phase-0 GO-gate meaningful once it points at real Pinax tape.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

from oct_trading_agent.core import LiquidityEvent, Side, SwapEvent, TapeEvent
from oct_trading_agent.sim.amm.curve import fill_buy, fill_sell
from oct_trading_agent.sim.calibration import (
    CalibrationConfig,
    calibrate,
    load_tape_parquet,
)

MINT = "So11111111111111111111111111111111111111112"
T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)
FEE = Decimal("0.0025")  # 25 bps — the fee the synthetic tape is generated with


def _synthetic_tape() -> list[TapeEvent]:
    """A tape whose swaps carry the reserves the curve produced, so pre-swap state is exact."""
    r_b = Decimal(1_000_000)
    r_q = Decimal(100)
    tape: list[TapeEvent] = [
        LiquidityEvent(
            mint=MINT,
            slot=100,
            block_time=T0,
            signature="lp-100",
            action="add",
            base_amount=r_b,
            quote_amount=r_q,
            base_reserve_after=r_b,
            quote_reserve_after=r_q,
        )
    ]
    slot = 200
    for i in range(10):
        when = T0 + timedelta(seconds=slot)
        if i % 2 == 0:
            curve = fill_buy(Decimal(2), r_b, r_q, FEE)
            tape.append(
                SwapEvent(
                    mint=MINT,
                    slot=slot,
                    block_time=when,
                    signature=f"sig-{slot}",
                    signer="w",
                    side=Side.BUY,
                    base_amount=curve.base_amount,
                    quote_amount=Decimal(2),
                    price=curve.executed_price,
                    base_reserve_after=curve.base_reserve_after,
                    quote_reserve_after=curve.quote_reserve_after,
                )
            )
        else:
            curve = fill_sell(Decimal(3000), r_b, r_q, FEE)
            tape.append(
                SwapEvent(
                    mint=MINT,
                    slot=slot,
                    block_time=when,
                    signature=f"sig-{slot}",
                    signer="w",
                    side=Side.SELL,
                    base_amount=Decimal(3000),
                    quote_amount=curve.quote_amount,
                    price=curve.executed_price,
                    base_reserve_after=curve.base_reserve_after,
                    quote_reserve_after=curve.quote_reserve_after,
                )
            )
        r_b, r_q = curve.base_reserve_after, curve.quote_reserve_after
        slot += 100
    return tape


def test_matching_fee_reproduces_fills_near_zero() -> None:
    report = calibrate(_synthetic_tape(), CalibrationConfig(fee_bps=25))
    assert report.n_evaluated == 10  # every swap has a prior anchor
    assert report.n_skipped == 0
    assert report.max_error_bps is not None
    assert report.max_error_bps < 1e-6  # analytic self-reproduction
    assert report.fraction_within_tolerance == 1.0
    assert report.passed


def test_wrong_fee_blows_reproduction_error() -> None:
    # Score the 25-bps tape with a 100-bps assumption: a systematic, tolerance-busting error.
    report = calibrate(_synthetic_tape(), CalibrationConfig(fee_bps=100, tolerance_bps=Decimal(50)))
    assert report.median_error_bps is not None
    assert report.median_error_bps > 50
    assert not report.passed
    assert (report.fraction_within_tolerance or 0.0) < 1.0


def test_unanchored_swaps_are_skipped_not_imputed() -> None:
    # A swap with no prior anchoring event cannot have its pre-depth reconstructed -> skipped.
    tape: list[TapeEvent] = [
        SwapEvent(
            mint=MINT,
            slot=200,
            block_time=T0,
            signature="sig-200",
            signer="w",
            side=Side.BUY,
            base_amount=Decimal(1000),
            quote_amount=Decimal(1),
            price=Decimal("0.001"),
        )
    ]
    report = calibrate(tape, CalibrationConfig(fee_bps=25))
    assert report.n_evaluated == 0
    assert report.n_skipped == 1
    assert report.skip_reasons["pool_unanchored"] == 1
    assert not report.passed  # nothing evaluable is not a GO


def test_summary_is_human_readable() -> None:
    report = calibrate(_synthetic_tape(), CalibrationConfig(fee_bps=25))
    text = report.summary()
    assert "GO" in text
    assert "median" in text


def test_parquet_round_trip(tmp_path: Path) -> None:
    import polars as pl

    tape = _synthetic_tape()
    rows = []
    for ev in tape:
        assert isinstance(ev, SwapEvent | LiquidityEvent)  # the synthetic tape is swaps + liquidity
        row: dict[str, object] = {
            "kind": ev.kind,
            "mint": ev.mint,
            "slot": ev.slot,
            # Naive timestamp: polars' tz-aware row export needs the IANA tzdata DB, which is
            # absent on bare Windows. Calibration orders by ``slot``, so wall-clock tz is moot.
            "block_time": ev.block_time.replace(tzinfo=None),
            "signature": ev.signature,
            "signer": ev.signer if isinstance(ev, SwapEvent) else None,
            "side": ev.side.value if isinstance(ev, SwapEvent) else None,
            "action": ev.action if isinstance(ev, LiquidityEvent) else None,
            "base_amount": str(ev.base_amount),
            "quote_amount": str(ev.quote_amount),
            "price": str(ev.price) if isinstance(ev, SwapEvent) and ev.price is not None else None,
            "base_reserve_after": str(ev.base_reserve_after)
            if ev.base_reserve_after is not None
            else None,
            "quote_reserve_after": str(ev.quote_reserve_after)
            if ev.quote_reserve_after is not None
            else None,
        }
        rows.append(row)

    path = tmp_path / "tape.parquet"
    pl.DataFrame(rows).write_parquet(path)

    loaded = load_tape_parquet(path)
    assert len(loaded) == len(tape)
    # The loaded tape calibrates identically to the in-memory one.
    report = calibrate(loaded, CalibrationConfig(fee_bps=25))
    assert report.n_evaluated == 10
    assert report.passed
