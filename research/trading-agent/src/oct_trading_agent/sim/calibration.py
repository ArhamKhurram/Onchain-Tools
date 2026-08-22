"""Calibration harness — the Phase-0 GO-gate: does the sim reproduce real fills? (03 §Phase 0)

The Pinax tape **is** the ground truth: every real swap already encodes its executed price, slippage,
and fees on-chain. Calibration therefore needs no external validation set — it holds out each real
swap, reconstructs the pool state as-of the instant *before* it, has the sim predict that swap's
fill from pre-swap depth, and compares the predicted executed price to what actually executed.

**Primary metric:** fill-reproduction error in bps = ``|predicted_price / observed_price - 1| * 1e4``,
aggregated over held-out swaps. **GO** iff the fraction of swaps within the pre-registered slippage
tolerance clears a bar AND the median error is within tolerance (leakage audit + trivial-baseline
run are separate gate conditions owned elsewhere). A NO-GO that a richer (still conservative)
execution model cannot close means no downstream result can be trusted and Phase 1 must not start.

This module runs on real tape once the data agent's Parquet log lands (:func:`load_tape_parquet`);
until then it is exercised on synthetic pools with known analytic fills (``tests/test_calibration.py``),
where the sim reproduces its own generating math to ~0 bps.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

import numpy as np

from oct_trading_agent.core import Mint, Side, SwapEvent, TapeEvent
from oct_trading_agent.sim.amm.curve import fill_buy, fill_sell
from oct_trading_agent.sim.amm.fees import DEFAULT_FEE_BPS, PoolConfig
from oct_trading_agent.sim.amm.pool import PoolReconstructor

_BPS = Decimal(10_000)


@dataclass(frozen=True)
class CalibrationConfig:
    """Pre-registered calibration parameters.

    ``tolerance_bps`` and ``required_fraction`` are the GO bar; both are placeholders here and must
    be *pre-registered* against real tape before the gate is scored (03 §Phase 0). ``fee_bps`` is
    the venue LP fee the sim assumes — a wrong fee shows up directly as reproduction error, so
    calibration is also how the fee is fit.
    """

    tolerance_bps: Decimal = Decimal(50)  # 0.50% reproduction tolerance (placeholder)
    required_fraction: Decimal = Decimal("0.95")  # fraction of swaps that must be within tolerance
    fee_bps: int = DEFAULT_FEE_BPS
    # Skip swaps whose reconstructed pre-state depth is below this (unanchored pools are skipped
    # regardless — a swap with no prior anchoring event cannot have its pre-depth reconstructed).
    min_quote_reserve: Decimal = Decimal(0)


@dataclass(frozen=True)
class SwapReproduction:
    """Per-swap reproduction outcome (or the reason it was skipped)."""

    mint: Mint
    slot: int
    side: Side
    observed_price: Decimal | None
    predicted_price: Decimal | None
    error_bps: float | None
    within_tolerance: bool
    skipped: bool = False
    skip_reason: str | None = None


@dataclass
class CalibrationReport:
    """Aggregate fill-reproduction result over the held-out swaps."""

    config: CalibrationConfig
    n_total: int
    n_evaluated: int
    per_swap: list[SwapReproduction] = field(default_factory=list)
    skip_reasons: Counter[str] = field(default_factory=Counter)

    # Aggregates (populated by ``_finalize``; None when nothing was evaluable).
    mean_error_bps: float | None = None
    median_error_bps: float | None = None
    p90_error_bps: float | None = None
    p99_error_bps: float | None = None
    max_error_bps: float | None = None
    fraction_within_tolerance: float | None = None

    @property
    def n_skipped(self) -> int:
        return self.n_total - self.n_evaluated

    @property
    def passed(self) -> bool:
        """GO iff enough swaps are within tolerance AND the median error is within tolerance."""
        if self.n_evaluated == 0 or self.fraction_within_tolerance is None:
            return False
        if self.median_error_bps is None:
            return False
        return (
            Decimal(str(self.fraction_within_tolerance)) >= self.config.required_fraction
            and Decimal(str(self.median_error_bps)) <= self.config.tolerance_bps
        )

    def summary(self) -> str:
        """One-line human summary for logs / gate reports."""
        if self.n_evaluated == 0:
            return f"calibration: 0/{self.n_total} swaps evaluable (all skipped)"
        verdict = "GO" if self.passed else "NO-GO"
        return (
            f"calibration [{verdict}]: {self.n_evaluated}/{self.n_total} swaps, "
            f"median={self.median_error_bps:.2f}bps p90={self.p90_error_bps:.2f}bps "
            f"p99={self.p99_error_bps:.2f}bps within-tol={self.fraction_within_tolerance:.1%} "
            f"(tol={self.config.tolerance_bps}bps, need={self.config.required_fraction:.0%})"
        )


def _observed_price(swap: SwapEvent) -> Decimal | None:
    if swap.price is not None and swap.price > 0:
        return swap.price
    if swap.base_amount > 0 and swap.quote_amount > 0:
        return swap.quote_amount / swap.base_amount
    return None


def calibrate(
    tape: list[TapeEvent],
    config: CalibrationConfig | None = None,
    *,
    keep_per_swap: bool = True,
) -> CalibrationReport:
    """Hold out every swap, reconstruct pre-swap pool state, predict the fill, score the error.

    ``keep_per_swap=False`` drops the per-swap detail (memory) but keeps the aggregates — useful for
    a large real tape. Skips (unanchored/thin pool, too few prior events, bad price) are counted and
    reported, never silently imputed.
    """
    cfg = config or CalibrationConfig()
    pool_cfg = PoolConfig(fee_bps=cfg.fee_bps)
    fee = pool_cfg.fee_fraction

    swaps_by_mint: dict[Mint, list[SwapEvent]] = {}
    for ev in tape:
        if isinstance(ev, SwapEvent):
            swaps_by_mint.setdefault(ev.mint, []).append(ev)

    n_total = sum(len(v) for v in swaps_by_mint.values())
    per_swap: list[SwapReproduction] = []
    errors: list[float] = []
    within = 0
    skips: Counter[str] = Counter()

    for mint, swaps in swaps_by_mint.items():
        recon = PoolReconstructor(tape, mint)
        # Count prior events per swap by slot position within the mint's own event stream.
        for swap in sorted(swaps, key=lambda e: (e.slot, e.signature or "")):
            rep = _reproduce_one(swap, mint, recon, cfg, fee, pool_cfg.min_quote_reserve)
            if rep.skipped:
                skips[rep.skip_reason or "unknown"] += 1
            else:
                assert rep.error_bps is not None
                errors.append(rep.error_bps)
                if rep.within_tolerance:
                    within += 1
            if keep_per_swap:
                per_swap.append(rep)

    report = CalibrationReport(
        config=cfg,
        n_total=n_total,
        n_evaluated=len(errors),
        per_swap=per_swap,
        skip_reasons=skips,
    )
    _finalize(report, errors, within)
    return report


def _reproduce_one(
    swap: SwapEvent,
    mint: Mint,
    recon: PoolReconstructor,
    cfg: CalibrationConfig,
    fee: Decimal,
    min_quote_reserve: Decimal,
) -> SwapReproduction:
    def skip(reason: str) -> SwapReproduction:
        return SwapReproduction(
            mint=mint,
            slot=swap.slot,
            side=swap.side,
            observed_price=None,
            predicted_price=None,
            error_bps=None,
            within_tolerance=False,
            skipped=True,
            skip_reason=reason,
        )

    observed = _observed_price(swap)
    if observed is None:
        return skip("no_observed_price")

    pre = recon.state_before_slot(swap.slot)
    if not pre.anchored:
        return skip("pool_unanchored")
    if pre.base_reserve <= 0 or pre.quote_reserve <= 0:
        return skip("pool_empty")
    if min_quote_reserve > 0 and pre.quote_reserve < min_quote_reserve:
        return skip("below_min_quote_reserve")

    try:
        if swap.side is Side.BUY:
            if swap.quote_amount <= 0:
                return skip("no_input_amount")
            curve = fill_buy(swap.quote_amount, pre.base_reserve, pre.quote_reserve, fee)
        else:
            if swap.base_amount <= 0:
                return skip("no_input_amount")
            curve = fill_sell(swap.base_amount, pre.base_reserve, pre.quote_reserve, fee)
    except (ValueError, ZeroDivisionError):
        return skip("curve_error")

    predicted = curve.executed_price
    error_bps = float(abs(predicted / observed - Decimal(1)) * _BPS)
    return SwapReproduction(
        mint=mint,
        slot=swap.slot,
        side=swap.side,
        observed_price=observed,
        predicted_price=predicted,
        error_bps=error_bps,
        within_tolerance=Decimal(str(error_bps)) <= cfg.tolerance_bps,
    )


def _finalize(report: CalibrationReport, errors: list[float], within: int) -> None:
    if not errors:
        return
    arr = np.asarray(errors, dtype=float)
    report.mean_error_bps = float(arr.mean())
    report.median_error_bps = float(np.median(arr))
    report.p90_error_bps = float(np.percentile(arr, 90))
    report.p99_error_bps = float(np.percentile(arr, 99))
    report.max_error_bps = float(arr.max())
    report.fraction_within_tolerance = within / len(errors)


# ---------------------------------------------------------------------------------------------
# Parquet loader — ready to point at the data agent's append-only log.
# ---------------------------------------------------------------------------------------------

# Maps the 04-data-spec representative column names onto the ``core.tape`` field names. Pass this
# (or your own) as ``column_map`` when the Parquet uses the data-spec names rather than the contract
# field names. Only keys that differ from the tape field name need to appear.
DATA_SPEC_COLUMN_MAP: dict[str, str] = {
    "token": "mint",
    "ts": "block_time",
    "base_amt": "base_amount",
    "quote_amt": "quote_amount",
    "tx_sig": "signature",
    "lp_wallet": "provider",
    "event": "action",  # liquidity add/remove
    "balance_delta": "holder_count_delta",
    "holder_count": "holder_count",
}

_KIND_TO_CTOR = ("swap", "liquidity", "holder", "rug")


def load_tape_parquet(
    path: str | Path,
    *,
    column_map: dict[str, str] | None = None,
    kind_column: str = "kind",
) -> list[TapeEvent]:
    """Load an append-only tape log (Parquet) into ``TapeEvent``s, ready for :func:`calibrate`.

    Expected schema: one row per event with a ``kind`` column in {swap, liquidity, holder, rug} and
    the corresponding ``core.tape`` fields (``mint, slot, block_time, signature`` always; swap adds
    ``signer, side, base_amount, quote_amount, price, *_reserve_*``; etc.). ``column_map`` renames
    source columns onto the contract field names (see :data:`DATA_SPEC_COLUMN_MAP`). pydantic coerces
    numeric/string amounts to ``Decimal`` and forbids unknown fields, so a schema drift fails loudly.

    Import of ``polars`` is deferred so the rest of ``sim`` has no hard columnar dependency at import.
    """
    import polars as pl

    from oct_trading_agent.core import (
        HolderChange,
        LiquidityEvent,
        RugEvent,
    )

    # Fields each event variant accepts, so columns that don't belong to it are dropped.
    swap_f = set(SwapEvent.model_fields)
    liq_f = set(LiquidityEvent.model_fields)
    holder_f = set(HolderChange.model_fields)
    rug_f = set(RugEvent.model_fields)

    def _pick(row: dict[str, Any], allowed: set[str]) -> dict[str, Any]:
        return {k: v for k, v in row.items() if k in allowed and k != "kind" and v is not None}

    frame = pl.read_parquet(str(path))
    rename = column_map or {}

    out: list[TapeEvent] = []
    for raw in frame.iter_rows(named=True):
        row = {rename.get(k, k): v for k, v in raw.items()}
        kind = row.get(kind_column)
        if kind == "swap":
            out.append(SwapEvent(**_pick(row, swap_f)))
        elif kind == "liquidity":
            out.append(LiquidityEvent(**_pick(row, liq_f)))
        elif kind == "holder":
            out.append(HolderChange(**_pick(row, holder_f)))
        elif kind == "rug":
            out.append(RugEvent(**_pick(row, rug_f)))
        else:
            raise ValueError(
                f"unknown tape event kind {kind!r} (expected one of {_KIND_TO_CTOR})"
            )
    return out
