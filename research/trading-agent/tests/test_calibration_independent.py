"""Independent-reserve calibration harness — fixture/synthetic tests, no network.

The methodology (module docstring) is: anchor at REAL reserves → reverse each swap with its OBSERVED
user amounts → predict with the real registered curve → compare. These tests pin every load-bearing
property offline:

* naive reversal is EXACT for a full-retention constant-product venue → a self-consistent swap
  reproduces to ~0 bps (the pipeline is correct);
* it is fee-exposed for pump.fun's LP+protocol+creator stack → a small, non-zero residual (the honest
  behaviour that made the independent number ~90 bps where self-consistency flattered it to ~30);
* the anchor-validity gate drops a pool whose vaults are not its pricing reserves (the sell-side root
  cause), so a corrupted anchor is removed rather than scored;
* roll-back drift climbs with the reconstruction window (why the default is the freshest fill);
* the report carries buy AND sell percentiles per venue;
* the per-pool pump.fun fee tier tightens a low-mcap pool's error vs the flat mature tier.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from oct_trading_agent.core import Side
from oct_trading_agent.data.pinax_client.decode import WSOL
from oct_trading_agent.data.pinax_client.reserves import PoolReserves
from oct_trading_agent.sim.amm.pool import PoolState
from oct_trading_agent.sim.calibration_independent import (
    PUMPFUN_TOTAL_SUPPLY_UI,
    IndependentCalibrationConfig,
    calibrate_independent,
    pumpfun_market_cap_sol,
    reproduce_pool,
    resolve_pumpfun_curve,
)
from oct_trading_agent.sim.curves import (
    ConstantProductCurve,
    PumpFunAmmCurve,
)
from oct_trading_agent.sim.curves.pumpfun import PUMPFUN_AMM_STANDARD_FEE, FeeSplit

TOKEN = "Tok1111111111111111111111111111111111111111"
_T = datetime(2020, 1, 1, tzinfo=UTC)


# ---------------------------------------------------------------------------------------------
# Helpers: generate a swap row + its post-reserves from a pre-state and a curve
# ---------------------------------------------------------------------------------------------


def _state(base: Decimal, quote: Decimal) -> PoolState:
    return PoolState(mint="P", base_reserve=base, quote_reserve=quote, slot=1, block_time=_T, anchored=True)


def _gen_swap(
    curve: Any,
    pre_base: Decimal,
    pre_quote: Decimal,
    side: Side,
    amount: Decimal,
    *,
    block: int,
    tx: int = 0,
    ix: int = 0,
) -> tuple[dict[str, Any], Decimal, Decimal]:
    """Return (raw Pinax row, post_base, post_quote) for filling ``amount`` on ``curve``.

    ``amount`` is SOL for a BUY, tokens for a SELL. The row uses the same UI-unit conventions as a
    real ``/v1/svm/swaps`` row (``input_value``/``output_value``, WSOL orientation).
    """
    st = _state(pre_base, pre_quote)
    if side is Side.BUY:
        fill = curve.fill_buy(amount, st)
        row = {
            "block_num": block, "transaction_index": tx, "instruction_index": ix,
            "input_mint": WSOL, "output_mint": TOKEN,
            "input_value": str(amount), "output_value": str(fill.base_amount),
        }
    else:
        fill = curve.fill_sell(amount, st)
        row = {
            "block_num": block, "transaction_index": tx, "instruction_index": ix,
            "input_mint": TOKEN, "output_mint": WSOL,
            "input_value": str(amount), "output_value": str(fill.quote_amount),
        }
    return row, fill.base_reserve_after, fill.quote_reserve_after


def _reserves(base: Decimal, quote: Decimal, block: int) -> PoolReserves:
    return PoolReserves(
        amm_pool="P", base_mint=TOKEN, quote_mint=WSOL,
        base_reserve=base, quote_reserve=quote, snapshot_block=block,
    )


def _offset_reserves(name: str, base: Decimal, quote: Decimal, *, factor: str = "1.3") -> PoolReserves:
    """Reserves whose base leg is inflated by ``factor`` — a vault that is not the pricing reserve."""
    return PoolReserves(
        amm_pool=name, base_mint=TOKEN, quote_mint=WSOL,
        base_reserve=base * Decimal(factor), quote_reserve=quote, snapshot_block=200,
    )


# ---------------------------------------------------------------------------------------------
# Core mechanics
# ---------------------------------------------------------------------------------------------


def test_constant_product_self_consistent_reproduces_zero() -> None:
    # Full-retention CP: naive reversal is EXACT, so a self-consistent swap reproduces to ~0 bps.
    curve = ConstantProductCurve(fee_bps=25)
    for side, amount in ((Side.BUY, Decimal(2)), (Side.SELL, Decimal(3000))):
        row, pb, pq = _gen_swap(curve, Decimal(1_000_000), Decimal(100), side, amount, block=200)
        reps = reproduce_pool(_reserves(pb, pq, 200), [row], protocol="raydium_amm_v4", window=1)
        assert len(reps) == 1
        assert reps[0].side is side
        assert reps[0].error_bps is not None
        assert reps[0].error_bps < 1e-6, (side, reps[0].error_bps)


def test_pumpfun_naive_reversal_is_fee_exposed_small_residual() -> None:
    # pump.fun's protocol+creator legs leave the pool, so naive reversal is NOT exact — a small,
    # non-zero residual on BOTH sides. This is the honesty that unfitted reserves buy us.
    curve = PumpFunAmmCurve()  # mature 30 bps
    for side, amount in ((Side.BUY, Decimal(5)), (Side.SELL, Decimal(40_000_000))):
        row, pb, pq = _gen_swap(
            curve, Decimal(12_000_000_000), Decimal(1600), side, amount, block=200
        )
        reps = reproduce_pool(_reserves(pb, pq, 200), [row], protocol="pumpfun_amm", window=1)
        assert reps[0].error_bps is not None
        # Non-zero (fee-exposed) but tiny for a single fresh step (the protocol+creator share).
        assert 0.0 < reps[0].error_bps < 20.0, (side, reps[0].error_bps)


def test_buy_and_sell_symmetric_residual() -> None:
    # The residual is comparable buy vs sell — the sell path is NOT systematically broken (the
    # sell-side finding: fill_sell is correct; the live blow-up was a bad anchor, not the model).
    curve = PumpFunAmmCurve()
    row_b, pbb, pbq = _gen_swap(curve, Decimal(12_000_000_000), Decimal(1600), Side.BUY, Decimal(5), block=1)
    row_s, pbs, pqs = _gen_swap(curve, Decimal(12_000_000_000), Decimal(1600), Side.SELL, Decimal(40_000_000), block=1)
    buy = reproduce_pool(_reserves(pbb, pbq, 1), [row_b], protocol="pumpfun_amm", window=1)[0]
    sell = reproduce_pool(_reserves(pbs, pqs, 1), [row_s], protocol="pumpfun_amm", window=1)[0]
    assert buy.error_bps is not None and sell.error_bps is not None
    assert abs(buy.error_bps - sell.error_bps) < 5.0


# ---------------------------------------------------------------------------------------------
# Anchor-validity gate — the sell-side root-cause fix
# ---------------------------------------------------------------------------------------------


def test_anchor_gate_drops_offset_pool() -> None:
    # A pool whose vault base balance is inflated 30% above its pricing reserve: every swap trades
    # ~30% off the reserve-implied mid regardless of size, so the pool-level median-vs-mid gate fires
    # and drops the whole pool. Without the gate the swap is scored with a large error.
    curve = ConstantProductCurve(fee_bps=25)
    # Several small swaps so the pool-level median is dominated by the offset, not one trade's impact.
    rows: list[dict[str, Any]] = []
    base, quote = Decimal(1_000_000), Decimal(100)
    for i in range(4):
        row, base, quote = _gen_swap(curve, base, quote, Side.BUY, Decimal("0.05"), block=200 + i)
        rows.append(row)
    offset_reserves = _reserves(base * Decimal("1.3"), quote, 203)  # vault base 30% too high

    ungated = reproduce_pool(offset_reserves, rows, protocol="raydium_amm_v4", window=1)[0]
    assert ungated.error_bps is not None and ungated.error_bps > 1000
    assert ungated.anchor_divergence_bps is not None and ungated.anchor_divergence_bps > 2000

    gated = reproduce_pool(
        offset_reserves, rows, protocol="raydium_amm_v4", window=1,
        max_anchor_divergence_bps=Decimal(500),
    )[0]
    assert gated.skipped
    assert gated.skip_reason == "anchor_offset_pool"
    assert gated.error_bps is None


def test_gate_off_by_default_scores_offset_pool_but_flags_it() -> None:
    # With the gate OFF (the default), an offset pool is still SCORED — but its pool-level anchor
    # divergence is surfaced on the record so a reader can see the anchor is suspect.
    curve = ConstantProductCurve(fee_bps=25)
    rows: list[dict[str, Any]] = []
    base, quote = Decimal(1_000_000), Decimal(100)
    for i in range(4):
        row, base, quote = _gen_swap(curve, base, quote, Side.BUY, Decimal("0.05"), block=200 + i)
        rows.append(row)
    offset_reserves = _reserves(base * Decimal("1.3"), quote, 203)

    rep = reproduce_pool(offset_reserves, rows, protocol="raydium_amm_v4", window=1)[0]
    assert not rep.skipped  # gate off → scored
    assert rep.error_bps is not None and rep.error_bps > 1000  # bad anchor → large error
    assert rep.anchor_divergence_bps is not None and rep.anchor_divergence_bps > 2000  # flagged


def test_median_is_robust_to_a_minority_offset_pool() -> None:
    # The headline number is the MEDIAN, which resists the minority of offset pools without any gate:
    # four clean pools (~0 bps) + one 30%-offset pool → the venue buy median stays ~0.
    curve = ConstantProductCurve(fee_bps=25)
    reserves_by_pool: dict[str, PoolReserves] = {}
    rows_by_pool: dict[str, list[dict[str, Any]]] = {}
    for i in range(4):
        row, pb, pq = _gen_swap(curve, Decimal(1_000_000), Decimal(100), Side.BUY, Decimal(2), block=200)
        reserves_by_pool[f"clean{i}"] = _reserves(pb, pq, 200)
        rows_by_pool[f"clean{i}"] = [row]
    bad_row, bpb, bpq = _gen_swap(curve, Decimal(1_000_000), Decimal(100), Side.BUY, Decimal(2), block=200)
    reserves_by_pool["offset"] = PoolReserves(
        amm_pool="offset", base_mint=TOKEN, quote_mint=WSOL,
        base_reserve=bpb * Decimal("1.3"), quote_reserve=bpq, snapshot_block=200,
    )
    rows_by_pool["offset"] = [bad_row]

    report = calibrate_independent(
        {"raydium_amm_v4": list(reserves_by_pool)},
        _FakeReservesClient(reserves_by_pool),
        lambda pool: rows_by_pool[pool],
        IndependentCalibrationConfig(window=1, max_anchor_divergence_bps=None),
    )
    venue = report.venue("raydium_amm_v4")
    assert venue is not None and venue.buy.n == 5
    assert venue.buy.median_bps is not None and venue.buy.median_bps < 1e-6  # median unmoved
    assert venue.buy.stats["max_bps"] > 1000  # the offset pool shows only in the tail


def test_opt_in_gate_drops_the_offset_pool() -> None:
    # Turning the gate ON removes the offset pool entirely, so even the tail is clean.
    curve = ConstantProductCurve(fee_bps=25)
    reserves_by_pool: dict[str, PoolReserves] = {}
    rows_by_pool: dict[str, list[dict[str, Any]]] = {}
    for i in range(4):
        base, quote = Decimal(1_000_000), Decimal(100)
        rows: list[dict[str, Any]] = []
        for _ in range(4):
            r, base, quote = _gen_swap(curve, base, quote, Side.BUY, Decimal("0.05"), block=200)
            rows.append(r)
        reserves_by_pool[f"clean{i}"] = _reserves(base, quote, 200)
        rows_by_pool[f"clean{i}"] = rows
    base, quote = Decimal(1_000_000), Decimal(100)
    bad_rows: list[dict[str, Any]] = []
    for _ in range(4):
        r, base, quote = _gen_swap(curve, base, quote, Side.BUY, Decimal("0.05"), block=200)
        bad_rows.append(r)
    reserves_by_pool["offset"] = _offset_reserves("offset", base, quote)
    rows_by_pool["offset"] = bad_rows

    report = calibrate_independent(
        {"raydium_amm_v4": list(reserves_by_pool)},
        _FakeReservesClient(reserves_by_pool),
        lambda pool: rows_by_pool[pool],
        IndependentCalibrationConfig(window=1, max_anchor_divergence_bps=Decimal(500)),
    )
    venue = report.venue("raydium_amm_v4")
    assert venue is not None and venue.buy.n == 4  # offset pool dropped
    assert venue.buy.stats["max_bps"] < 1.0  # tail clean too
    assert any(r.skip_reason == "anchor_offset_pool" for r in report.per_swap)


def test_runner_gates_offset_pools_by_default() -> None:
    # The runner config gates bad-vault pools by DEFAULT (1000 bps). Sells are sparse, so the robust
    # median does not rescue them the way it does buys — the gate is what makes the sell aggregate
    # comparable (live: sell median 3921 bps -> 97 bps gate OFF -> ON). The pure `reproduce_pool`
    # keeps its own gate off so the primitive stays honest.
    assert IndependentCalibrationConfig().max_anchor_divergence_bps == Decimal(1000)

    curve = ConstantProductCurve(fee_bps=25)
    reserves_by_pool: dict[str, PoolReserves] = {}
    rows_by_pool: dict[str, list[dict[str, Any]]] = {}
    for i in range(3):
        base, quote = Decimal(1_000_000), Decimal(100)
        rows: list[dict[str, Any]] = []
        for _ in range(4):
            r, base, quote = _gen_swap(curve, base, quote, Side.BUY, Decimal("0.05"), block=200)
            rows.append(r)
        reserves_by_pool[f"clean{i}"] = _reserves(base, quote, 200)
        rows_by_pool[f"clean{i}"] = rows
    base, quote = Decimal(1_000_000), Decimal(100)
    bad_rows: list[dict[str, Any]] = []
    for _ in range(4):
        r, base, quote = _gen_swap(curve, base, quote, Side.BUY, Decimal("0.05"), block=200)
        bad_rows.append(r)
    reserves_by_pool["offset"] = _offset_reserves("offset", base, quote)
    rows_by_pool["offset"] = bad_rows

    # No explicit gate arg -> the default (1000 bps) must drop the offset pool.
    report = calibrate_independent(
        {"raydium_amm_v4": list(reserves_by_pool)},
        _FakeReservesClient(reserves_by_pool),
        lambda pool: rows_by_pool[pool],
        IndependentCalibrationConfig(window=1),
    )
    venue = report.venue("raydium_amm_v4")
    assert venue is not None and venue.buy.n == 3  # only the clean pools scored
    assert any(r.skip_reason == "anchor_offset_pool" for r in report.per_swap)


# ---------------------------------------------------------------------------------------------
# Roll-back drift + freshest-fill default
# ---------------------------------------------------------------------------------------------


def _pumpfun_sequence(n: int) -> tuple[PoolReserves, list[dict[str, Any]]]:
    """Chain ``n`` pump.fun sells forward from a pre-state; return final reserves + the rows."""
    curve = PumpFunAmmCurve()
    base, quote = Decimal(12_000_000_000), Decimal(1600)
    rows: list[dict[str, Any]] = []
    for i in range(n):
        row, base, quote = _gen_swap(curve, base, quote, Side.SELL, Decimal(30_000_000), block=100 + i)
        rows.append(row)
    return _reserves(base, quote, 100 + n - 1), rows


def test_rollback_drift_increases_with_window() -> None:
    reserves, rows = _pumpfun_sequence(8)
    reps = reproduce_pool(reserves, rows, protocol="pumpfun_amm", window=8)
    scored = [r for r in reps if r.error_bps is not None]
    assert len(scored) == 8
    by_pos = {r.rollback_pos: r.error_bps for r in scored}
    # Freshest (pos 0) is the cleanest; the deepest reconstruction is materially worse.
    assert by_pos[0] is not None and by_pos[7] is not None
    assert by_pos[7] > by_pos[0]
    assert by_pos[0] < 20.0  # freshest stays near the single-step fee residual


def test_window_one_scores_only_the_freshest() -> None:
    reserves, rows = _pumpfun_sequence(5)
    reps = reproduce_pool(reserves, rows, protocol="pumpfun_amm", window=1)
    assert len([r for r in reps if r.error_bps is not None]) == 1
    assert reps[0].rollback_pos == 0
    assert reps[0].block_num == rows[-1]["block_num"]


# ---------------------------------------------------------------------------------------------
# Skip paths
# ---------------------------------------------------------------------------------------------


def test_incomplete_reserves_skipped() -> None:
    bad = PoolReserves(amm_pool="P", base_mint=TOKEN, quote_mint=WSOL,
                       base_reserve=None, quote_reserve=Decimal(100), snapshot_block=1)
    reps = reproduce_pool(bad, [], protocol="raydium_amm_v4")
    assert reps[0].skipped and reps[0].skip_reason == "reserves_incomplete"


def test_unsupported_venue_skipped() -> None:
    row, pb, pq = _gen_swap(ConstantProductCurve(), Decimal(1_000_000), Decimal(100), Side.BUY, Decimal(2), block=5)
    reps = reproduce_pool(_reserves(pb, pq, 5), [row], protocol="jupiter_v6", window=1)
    assert reps[0].skipped and reps[0].skip_reason is not None
    assert reps[0].skip_reason.startswith("venue_unsupported")


def test_untracked_leg_skipped() -> None:
    # A token↔token row (neither leg WSOL) is not a tracked swap.
    row = {"block_num": 5, "transaction_index": 0, "instruction_index": 0,
           "input_mint": "AAA", "output_mint": "BBB", "input_value": "1", "output_value": "2"}
    reps = reproduce_pool(_reserves(Decimal(1_000_000), Decimal(100), 5), [row], protocol="raydium_amm_v4", window=1)
    assert reps[0].skipped and reps[0].skip_reason == "untracked_leg"


# ---------------------------------------------------------------------------------------------
# Per-pool pump.fun fee tier (task 3)
# ---------------------------------------------------------------------------------------------


def test_market_cap_and_tier_resolution() -> None:
    # High-mcap busy pool → mature 30 bps; a low-mcap pool → an elevated tier.
    hi = _reserves(Decimal(12_000_000_000), Decimal(1600), 1)  # mid ~1.3e-7 → mcap ~133 SOL...
    mc = pumpfun_market_cap_sol(hi)
    mid = hi.mid_price
    assert mc is not None and mid is not None and mc == mid * PUMPFUN_TOTAL_SUPPLY_UI
    # A pool with a high mid → high mcap → mature tier.
    big = _reserves(Decimal(1_000_000), Decimal(1000), 1)  # mid 1e-3 → mcap 1e6 SOL
    assert resolve_pumpfun_curve(big).fee.total_bps == PUMPFUN_AMM_STANDARD_FEE.total_bps
    # A tiny-mcap pool → elevated tier (> 30 bps).
    tiny = _reserves(Decimal(1_000_000_000), Decimal("0.0002"), 1)  # mid 2e-13 → mcap ~2e-4 SOL
    assert resolve_pumpfun_curve(tiny).fee.total_bps > PUMPFUN_AMM_STANDARD_FEE.total_bps


def test_per_pool_tier_tightens_low_mcap_buy() -> None:
    # A young low-mcap pool actually charges a HIGH tier. Pricing it with the flat mature 30 bps
    # mis-reproduces; the per-pool tier curve reproduces it far tighter.
    high_tier = FeeSplit(lp_bps=Decimal(20), protocol_bps=Decimal(5), creator_bps=Decimal(90))  # 115 bps
    true_curve = PumpFunAmmCurve(fee=high_tier)
    # Pre-state at a low mcap so the schedule resolves to a high tier.
    pre_base, pre_quote = Decimal(1_000_000_000), Decimal(3)  # mid 3e-9 → mcap 3 SOL → high tier
    row, pb, pq = _gen_swap(true_curve, pre_base, pre_quote, Side.BUY, Decimal("0.5"), block=200)
    reserves = _reserves(pb, pq, 200)

    flat = reproduce_pool(reserves, [row], protocol="pumpfun_amm", window=1)[0]  # default 30 bps
    tiered = reproduce_pool(
        reserves, [row], protocol="pumpfun_amm", window=1, curve=resolve_pumpfun_curve(reserves)
    )[0]
    assert flat.error_bps is not None and tiered.error_bps is not None
    assert tiered.error_bps < flat.error_bps
    assert tiered.error_bps < 20.0  # the correct tier reproduces to the single-step residual


# ---------------------------------------------------------------------------------------------
# Aggregation across pools (fake clients — the live runner path, offline)
# ---------------------------------------------------------------------------------------------


class _FakeReservesClient:
    def __init__(self, by_pool: dict[str, PoolReserves]) -> None:
        self._by_pool = by_pool

    def get_pool_reserves(self, amm_pool: str, **kwargs: Any) -> PoolReserves:
        return self._by_pool[amm_pool]


def test_report_carries_buy_and_sell_percentiles() -> None:
    curve = ConstantProductCurve(fee_bps=25)
    reserves_by_pool: dict[str, PoolReserves] = {}
    rows_by_pool: dict[str, list[dict[str, Any]]] = {}
    for i in range(3):
        pool = f"pool{i}"
        # Two-swap pool: buy then sell, chained so the sell's pre-state follows the buy.
        buy_row, post_b, post_q = _gen_swap(
            curve, Decimal(1_000_000), Decimal(100), Side.BUY, Decimal(2), block=200
        )
        sell_row, post_b2, post_q2 = _gen_swap(
            curve, post_b, post_q, Side.SELL, Decimal(3000), block=201
        )
        reserves_by_pool[pool] = PoolReserves(
            amm_pool=pool, base_mint=TOKEN, quote_mint=WSOL,
            base_reserve=post_b2, quote_reserve=post_q2, snapshot_block=201,
        )
        rows_by_pool[pool] = [buy_row, sell_row]

    client = _FakeReservesClient(reserves_by_pool)
    report = calibrate_independent(
        {"raydium_amm_v4": list(reserves_by_pool)},
        client,
        lambda pool: rows_by_pool[pool],
        IndependentCalibrationConfig(window=2, max_anchor_divergence_bps=None),
    )
    venue = report.venue("raydium_amm_v4")
    assert venue is not None
    assert venue.buy.n == 3 and venue.sell.n == 3
    # Full-retention CP reproduces exactly → both sides ~0 bps.
    assert venue.buy.median_bps is not None and venue.buy.median_bps < 1e-6
    assert venue.sell.median_bps is not None and venue.sell.median_bps < 1e-6
    assert "raydium_amm_v4" in report.render()


def test_max_pools_per_venue_bounds_the_scan() -> None:
    curve = ConstantProductCurve()
    reserves_by_pool: dict[str, PoolReserves] = {}
    for i in range(10):
        _, pb, pq = _gen_swap(curve, Decimal(1_000_000), Decimal(100), Side.BUY, Decimal(2), block=200)
        reserves_by_pool[f"p{i}"] = _reserves(pb, pq, 200)
    calls: list[str] = []

    def fetch(pool: str) -> list[dict[str, Any]]:
        calls.append(pool)
        return []

    calibrate_independent(
        {"raydium_amm_v4": list(reserves_by_pool)},
        _FakeReservesClient(reserves_by_pool),
        fetch,
        IndependentCalibrationConfig(max_pools_per_venue=3),
    )
    assert len(calls) == 3  # scan stopped at the cap
