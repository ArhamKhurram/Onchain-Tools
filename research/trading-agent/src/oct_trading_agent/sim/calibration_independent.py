"""Independent-reserve fill reproduction — the honest Phase-0 fidelity gate (03 §Phase 0).

Where :mod:`~oct_trading_agent.sim.calibration` reconstructs pre-swap depth by *folding the swap
sequence onto itself* (a self-consistency fit), this module anchors depth on **independent** data:
the pool's real on-chain reserves (:class:`~oct_trading_agent.data.pinax_client.reserves.PoolReserves`).
A fitted depth silently *absorbs* fee/model error — self-consistency flattered the fidelity number
to ~30 bps where independent reserves report the honest ~90 bps (PROGRESS 2026-08-23). This harness
is the honest number.

Methodology (per pool)::

    anchor at REAL reserves (block S, the post-state of the newest swap ≤ S)
      → walk the newest swaps backwards, reversing each with its OBSERVED user amounts
        to reconstruct that swap's pre-trade (base, quote) reserves
      → have the venue's ACTUAL registered Curve predict the fill from that pre-state
      → compare predicted output leg to the observed output leg → error in bps

Two properties make the number trustworthy:

* **Non-circular.** The reversal uses the trader's *observed* user amounts (what Pinax records),
  NOT the curve's fee-exact reserve deltas. Reconstructing pre-state from the swap's own fee-exact
  deltas and then predicting that same swap forward would reproduce it to ~0 bps *by construction*
  (the fee model would cancel itself) — a useless test. Naive-reversal-from-independent-reserves
  leaves the fee model exposed, so a wrong fee shows up as real error (exactly as it does on the
  buy side).
* **Roll-back drift is bounded by a short window.** Each naive reverse step ignores the
  protocol+creator fee that left the pool (~10 bps/step) and any un-modelled LP event, so error
  climbs monotonically with reconstruction distance (measured: pos0 ~30 bps → pos10 ~1480 bps).
  The default ``window`` is therefore the **freshest 1 swap** — zero roll-back past the anchor's own
  reversal — with a knob to widen it and watch the drift.

* **The anchor gate is what makes sells reproduce comparably to buys; the median alone is not enough.**
  The sell-side investigation (PROGRESS 2026-08-23) traced the ~17% "broken sells" NOT to the sell
  model (:meth:`PumpFunAmmCurve.fill` reproduces a self-consistent synthetic sell to ~0.03 bps, same
  as a buy) but to a subset of pump.fun-AMM pools whose raw ``owner=amm_pool`` vault balances are
  **not** their constant-product pricing reserves: every recent swap on such a pool — buys included,
  even a zero-impact 0.01-SOL trade — executes at a *systematic, size-independent* offset from the
  reserve-implied mid (measured 0–14% across live pools; a pool at +13% corrupted its buys AND sells
  identically). The original ~1700 bps was a sampling artifact — sells are **sparse** (n≈3–10 per run)
  and land disproportionately on those offset pools. Crucially, because sells are sparse the robust
  median does **not** rescue the aggregate the way it does for buys (large n): the fix is the
  pool-level **anchor gate** (``max_anchor_divergence_bps``, ON by default in the runner at 1000 bps),
  which drops the bad-vault pools. Measured decisively (window=3): a clean-anchor sell reproduces to
  **97 bps** (in line with buys ~76 bps), while the aggregate **sell median moves 3921 bps → 97 bps
  gate OFF → ON**. The pool-level anchor divergence is always surfaced per record; the pure
  ``reproduce_pool`` keeps the gate off so the primitive stays honest.

The core :func:`reproduce_pool` is pure: it takes an already-fetched :class:`PoolReserves` plus the
raw Pinax swap rows and returns per-swap reproductions, so the whole harness is unit-tested against
fixtures with no network. :func:`calibrate_independent` wires a :class:`ReservesClient` and a swap
fetcher for a live run; that path is network-gated and never touches the test suite.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Protocol

import numpy as np

from oct_trading_agent.core import Side
from oct_trading_agent.data.pinax_client.decode import WSOL
from oct_trading_agent.data.pinax_client.reserves import PoolReserves
from oct_trading_agent.sim.amm.pool import PoolState
from oct_trading_agent.sim.curves import (
    DEFAULT_REGISTRY,
    Curve,
    CurveRegistry,
    PumpFunAmmCurve,
)
from oct_trading_agent.sim.curves.pumpfun import PumpFunAmmFeeSchedule

_BPS = Decimal(10_000)

# pump.fun tokens have a fixed 1e9 total supply; market cap in SOL = mid_price(SOL/token) * supply.
# Used to resolve the mcap fee tier per pool (task: per-pool pump.fun fee tier).
PUMPFUN_TOTAL_SUPPLY_UI = Decimal(1_000_000_000)

# A synthetic block_time — the harness orders purely on (block_num, tx_index, ix_index); wall-clock
# is never read here, so a single sentinel keeps PoolState happy without pretending to a real time.
_SENTINEL_TIME = datetime(2020, 1, 1, tzinfo=UTC)


# ---------------------------------------------------------------------------------------------
# Result records
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class FillReproduction:
    """One swap's independent-reserve reproduction outcome (or why it was skipped)."""

    amm_pool: str
    protocol: str | None
    side: Side | None
    block_num: int
    #: 0 = freshest (least roll-back); larger = deeper reconstruction (more drift).
    rollback_pos: int
    observed_out: Decimal | None
    predicted_out: Decimal | None
    error_bps: float | None
    #: Pool-level anchor divergence: |median executed price over the pool's recent swaps / reserve
    #: mid − 1| in bps — the size-robust anchor-validity signal. A pool whose vault balances are NOT
    #: its constant-product pricing reserves (module docstring) shows a large value here regardless of
    #: any single trade's impact; ``None`` when it could not be computed.
    anchor_divergence_bps: float | None = None
    skipped: bool = False
    skip_reason: str | None = None


def _percentiles(values: Sequence[float]) -> dict[str, float | int]:
    if not values:
        return {"n": 0}
    arr = np.asarray(values, dtype=float)
    return {
        "n": int(arr.size),
        "median_bps": float(np.median(arr)),
        "p75_bps": float(np.percentile(arr, 75)),
        "p90_bps": float(np.percentile(arr, 90)),
        "max_bps": float(arr.max()),
    }


@dataclass(frozen=True)
class SideFidelity:
    """Buy- or sell-side error percentiles for one venue (bps)."""

    side: Side
    stats: dict[str, float | int]

    @property
    def n(self) -> int:
        return int(self.stats.get("n", 0))

    @property
    def median_bps(self) -> float | None:
        v = self.stats.get("median_bps")
        return float(v) if v is not None else None

    def render(self) -> str:
        if self.n == 0:
            return f"{self.side.value:4s}: no fills"
        s = self.stats
        return (
            f"{self.side.value:4s}: n={self.n:4d} median={s['median_bps']:7.1f}bps "
            f"p75={s['p75_bps']:7.1f}bps p90={s['p90_bps']:8.1f}bps"
        )


@dataclass(frozen=True)
class VenueFidelity:
    """Per-venue buy AND sell fidelity, plus the pools/fills that fed it."""

    protocol: str
    n_pools: int
    buy: SideFidelity
    sell: SideFidelity

    def render(self) -> str:
        return (
            f"{self.protocol:16s} (pools={self.n_pools})\n"
            f"    {self.buy.render()}\n"
            f"    {self.sell.render()}"
        )


@dataclass
class IndependentCalibrationReport:
    """Aggregate independent-reserve reproduction across venues."""

    window: int
    venues: list[VenueFidelity] = field(default_factory=list)
    per_swap: list[FillReproduction] = field(default_factory=list)
    unusable_pools: dict[str, str] = field(default_factory=dict)

    def venue(self, protocol: str) -> VenueFidelity | None:
        return next((v for v in self.venues if v.protocol == protocol), None)

    def render(self) -> str:
        lines = [
            f"=== INDEPENDENT-RESERVE FILL REPRODUCTION (window={self.window}, "
            "real reserves + real curve models) ==="
        ]
        for v in self.venues:
            lines.append(v.render())
        if not self.venues:
            lines.append("  (no venue produced usable fills)")
        return "\n".join(lines)


# ---------------------------------------------------------------------------------------------
# Pure core — reproduce one pool from an already-fetched PoolReserves + raw swap rows
# ---------------------------------------------------------------------------------------------


def _leg_amounts(row: Mapping[str, Any]) -> tuple[Side, Decimal, Decimal] | None:
    """(side, base_amount, quote_amount) in UI units for a WSOL-paired row, or None if not tracked.

    Mirrors :func:`decode_swap_row`: BUY = WSOL in / token out, SELL = token in / WSOL out.
    """
    inm, outm = row.get("input_mint"), row.get("output_mint")
    iv, ov = row.get("input_value"), row.get("output_value")
    if iv is None or ov is None:
        return None
    iv_d, ov_d = Decimal(str(iv)), Decimal(str(ov))
    if iv_d <= 0 or ov_d <= 0:
        return None
    if inm == WSOL and outm != WSOL:
        return Side.BUY, ov_d, iv_d  # base = tokens out, quote = SOL in
    if outm == WSOL and inm != WSOL:
        return Side.SELL, iv_d, ov_d  # base = tokens in, quote = SOL out
    return None


def _pool_anchor_offset_bps(
    rows: Sequence[Mapping[str, Any]], reserve_mid: Decimal, sample: int
) -> float | None:
    """|median(executed price over the newest ``sample`` swaps) / reserve_mid − 1| in bps, or None.

    The median over a mix of trade sizes and sides averages out per-trade price impact, leaving the
    *systematic* gap between the pool's traded price and its reserve-implied mid — the signal that the
    vault balances are not the constant-product pricing reserves. Size-robust by construction, unlike
    a single swap's executed-vs-mid divergence (which is dominated by that one trade's impact).
    """
    if reserve_mid <= 0 or sample <= 0:
        return None
    prices: list[float] = []
    for row in rows[-sample:]:
        legs = _leg_amounts(row)
        if legs is None:
            continue
        _side, base_amt, quote_amt = legs
        if base_amt > 0:
            prices.append(float(quote_amt / base_amt))
    if not prices:
        return None
    median_exec = float(np.median(np.asarray(prices, dtype=float)))
    return abs(median_exec / float(reserve_mid) - 1.0) * 1e4


def _reverse_reserves(
    side: Side, base_amt: Decimal, quote_amt: Decimal, post_base: Decimal, post_quote: Decimal
) -> tuple[Decimal, Decimal]:
    """Post-trade reserves → pre-trade reserves, using the swap's OBSERVED user amounts.

    Naive (fee-agnostic) reversal on purpose — see the module docstring. A BUY removed ``base_amt``
    tokens from the pool and added ``quote_amt`` SOL; a SELL did the reverse. Reversing gives the
    pre-trade depth without consulting the fee model, so the forward prediction that follows is a
    genuine test of that model rather than a self-fulfilling one.
    """
    if side is Side.BUY:
        return post_base + base_amt, post_quote - quote_amt
    return post_base - base_amt, post_quote + quote_amt


def reproduce_pool(
    reserves: PoolReserves,
    swap_rows: Iterable[Mapping[str, Any]],
    *,
    protocol: str,
    window: int = 1,
    curve: Curve | None = None,
    registry: CurveRegistry = DEFAULT_REGISTRY,
    max_anchor_divergence_bps: Decimal | None = None,
    validity_sample: int = 15,
) -> list[FillReproduction]:
    """Reproduce the newest ``window`` fills of one pool against its independent reserves.

    ``reserves`` must be complete (both legs > 0) with a ``snapshot_block``; ``swap_rows`` are raw
    Pinax ``/v1/svm/swaps`` rows for this pool. Only rows at/before the snapshot block are used (the
    reserves reflect exactly those), newest first. ``curve`` overrides the registry lookup (used to
    pass a per-pool fee-tier curve); otherwise the venue's default curve is resolved.

    ``max_anchor_divergence_bps`` (when set) is the pool-level anchor-validity gate: if the median
    executed price over the newest ``validity_sample`` swaps diverges from the reserve-implied mid by
    more than this, EVERY scored swap on the pool is skipped (``skip_reason='anchor_offset_pool'``) —
    the pool's vault balances are not its constant-product pricing reserves (see the module
    docstring). ``None`` disables the gate. Each scored record still carries its own
    ``anchor_divergence_bps`` (executed vs reconstructed pre-mid) as a diagnostic.
    """
    if not reserves.is_complete or reserves.snapshot_block is None:
        return [
            FillReproduction(
                amm_pool=reserves.amm_pool,
                protocol=protocol,
                side=None,
                block_num=reserves.snapshot_block or 0,
                rollback_pos=0,
                observed_out=None,
                predicted_out=None,
                error_bps=None,
                skipped=True,
                skip_reason="reserves_incomplete",
            )
        ]

    resolved = curve
    if resolved is None:
        resolution = registry.try_resolve(protocol)
        if not resolution.supported or resolution.curve is None:
            return [
                FillReproduction(
                    amm_pool=reserves.amm_pool,
                    protocol=protocol,
                    side=None,
                    block_num=reserves.snapshot_block,
                    rollback_pos=0,
                    observed_out=None,
                    predicted_out=None,
                    error_bps=None,
                    skipped=True,
                    skip_reason=f"venue_unsupported:{resolution.reason}",
                )
            ]
        resolved = resolution.curve

    snap = reserves.snapshot_block
    rows = [r for r in swap_rows if isinstance(r.get("block_num"), int) and r["block_num"] <= snap]
    rows.sort(
        key=lambda r: (
            r["block_num"],
            r.get("transaction_index", 0),
            r.get("instruction_index", 0),
        )
    )

    assert reserves.base_reserve is not None and reserves.quote_reserve is not None
    reserve_mid = reserves.quote_reserve / reserves.base_reserve

    # Pool-level anchor validity: the median executed price over the newest `validity_sample` swaps
    # vs the reserve-implied mid. Averaging over a mix of sizes/sides washes out per-trade impact, so
    # a large residual here means the reserve is NOT the pool's pricing reserve (module docstring),
    # not just that one big trade moved price. This is the size-robust gate — a per-swap exec-vs-mid
    # test wrongly drops legitimately large-impact fills (they diverge from mid yet reproduce fine).
    pool_offset_bps = _pool_anchor_offset_bps(rows, reserve_mid, validity_sample)
    pool_anchored_bad = (
        max_anchor_divergence_bps is not None
        and pool_offset_bps is not None
        and Decimal(str(pool_offset_bps)) > max_anchor_divergence_bps
    )

    rows = rows[-window:]

    running_base = reserves.base_reserve
    running_quote = reserves.quote_reserve

    out: list[FillReproduction] = []
    # newest → oldest: current running reserves are the POST-state of this swap.
    for pos, row in enumerate(reversed(rows)):
        block = int(row["block_num"])
        legs = _leg_amounts(row)
        if legs is None:
            out.append(
                FillReproduction(
                    amm_pool=reserves.amm_pool,
                    protocol=protocol,
                    side=None,
                    block_num=block,
                    rollback_pos=pos,
                    observed_out=None,
                    predicted_out=None,
                    error_bps=None,
                    skipped=True,
                    skip_reason="untracked_leg",
                )
            )
            continue
        side, base_amt, quote_amt = legs
        pre_base, pre_quote = _reverse_reserves(
            side, base_amt, quote_amt, running_base, running_quote
        )
        # Step the running state back to this swap's pre-state for the next (older) iteration.
        running_base, running_quote = pre_base, pre_quote
        if pre_base <= 0 or pre_quote <= 0:
            out.append(
                FillReproduction(
                    amm_pool=reserves.amm_pool,
                    protocol=protocol,
                    side=side,
                    block_num=block,
                    rollback_pos=pos,
                    observed_out=None,
                    predicted_out=None,
                    error_bps=None,
                    skipped=True,
                    skip_reason="reversed_reserve_nonpositive",
                )
            )
            continue

        if pool_anchored_bad:
            out.append(
                FillReproduction(
                    amm_pool=reserves.amm_pool,
                    protocol=protocol,
                    side=side,
                    block_num=block,
                    rollback_pos=pos,
                    observed_out=None,
                    predicted_out=None,
                    error_bps=None,
                    anchor_divergence_bps=pool_offset_bps,
                    skipped=True,
                    skip_reason="anchor_offset_pool",
                )
            )
            continue

        state = PoolState(
            mint=reserves.amm_pool,
            base_reserve=pre_base,
            quote_reserve=pre_quote,
            slot=block,
            block_time=_SENTINEL_TIME,
            anchored=True,
        )
        try:
            if side is Side.BUY:
                fill = resolved.fill_buy(quote_amt, state)
                predicted = fill.base_amount  # tokens out
                observed = base_amt
            else:
                fill = resolved.fill_sell(base_amt, state)
                predicted = fill.quote_amount  # SOL out (net of fee)
                observed = quote_amt
        except (ValueError, ZeroDivisionError, ArithmeticError) as exc:
            out.append(
                FillReproduction(
                    amm_pool=reserves.amm_pool,
                    protocol=protocol,
                    side=side,
                    block_num=block,
                    rollback_pos=pos,
                    observed_out=None,
                    predicted_out=None,
                    error_bps=None,
                    skipped=True,
                    skip_reason=f"curve_error:{type(exc).__name__}",
                )
            )
            continue

        error_bps = float(abs(predicted / observed - Decimal(1)) * _BPS) if observed > 0 else None
        out.append(
            FillReproduction(
                amm_pool=reserves.amm_pool,
                protocol=protocol,
                side=side,
                block_num=block,
                rollback_pos=pos,
                observed_out=observed,
                predicted_out=predicted,
                error_bps=error_bps,
                anchor_divergence_bps=pool_offset_bps,
                skipped=error_bps is None,
                skip_reason="zero_observed" if error_bps is None else None,
            )
        )
    return out


# ---------------------------------------------------------------------------------------------
# Fee-tier resolution (task: per-pool pump.fun fee tier)
# ---------------------------------------------------------------------------------------------


def pumpfun_market_cap_sol(reserves: PoolReserves) -> Decimal | None:
    """Estimate a pump.fun pool's market cap in SOL from its reserve-implied mid.

    mcap_SOL = mid_price(SOL/token) * total_supply. pump.fun tokens have a fixed 1e9 supply, so the
    reserve mid pins the mcap the fee schedule tiers on. ``None`` when the mid is unavailable.
    """
    mid = reserves.mid_price
    if mid is None:
        return None
    return mid * PUMPFUN_TOTAL_SUPPLY_UI


def resolve_pumpfun_curve(
    reserves: PoolReserves, *, schedule: PumpFunAmmFeeSchedule | None = None
) -> PumpFunAmmCurve:
    """A :class:`PumpFunAmmCurve` whose fee tier is resolved from the pool's market cap.

    Busy, high-mcap pools resolve to the mature 30 bps tier (the schedule default); younger/smaller
    pools resolve to a higher tier — closing the fee-tier component of the buy-side residual.
    """
    return PumpFunAmmCurve.for_market_cap_sol(
        pumpfun_market_cap_sol(reserves), schedule=schedule
    )


# ---------------------------------------------------------------------------------------------
# Live runner — wires a ReservesClient + a swap fetcher (network-gated; never unit-tested)
# ---------------------------------------------------------------------------------------------

#: Fetch raw Pinax swap rows for one pool (newest first). Injected so the live path stays testable.
SwapFetcher = Callable[[str], Sequence[Mapping[str, Any]]]


class ReservesSource(Protocol):
    """The one method the runner needs from a reserves provider — structural, so a fake qualifies.

    :class:`~oct_trading_agent.data.pinax_client.reserves.ReservesClient` satisfies this (its extra
    keyword-only args are all optional); a test supplies a stub with the same call shape and no
    network. The runner only ever calls it positionally as ``get_pool_reserves(pool)``.
    """

    def get_pool_reserves(self, amm_pool: str) -> PoolReserves: ...


@dataclass(frozen=True)
class IndependentCalibrationConfig:
    """Knobs for a live independent-reserve run."""

    window: int = 1
    #: Cap the pools scanned per venue (keeps a live run bounded — never an open-ended loop).
    max_pools_per_venue: int = 8
    #: Resolve pump.fun's fee tier per pool from market cap (vs the flat mature 30 bps).
    per_pool_pumpfun_tier: bool = True
    #: Pool-level anchor-validity gate. Drops a pool whose median executed price diverges from its
    #: reserve-implied mid by more than this (bps) — catches vaults whose ``owner=amm_pool`` balance is
    #: NOT the constant-product pricing reserve. **ON by default for the runner** at a conservative 10%
    #: (1000 bps): the live data showed the robust median fixes the BUY aggregate (large n) but NOT the
    #: SPARSE sell sample (n≈3–10, which lands disproportionately on offset pools) — gating those pools
    #: moves the sell median 3921 bps → 97 bps, comparable to buys (~76 bps). The pure ``reproduce_pool``
    #: keeps its own default off so the primitive stays honest; ``anchor_divergence_bps`` is always
    #: reported as a diagnostic regardless. A hard gate can, rarely, drop a pool mid a genuine large
    #: price move — accepted, since 1000 bps is well above normal fee+impact.
    max_anchor_divergence_bps: Decimal | None = Decimal(1000)
    #: How many of the newest swaps feed the pool-level median for the gate (size/side mix → robust).
    validity_sample: int = 15
    #: Venue→curve registry the runner resolves through (the process-wide default by default).
    registry: CurveRegistry = DEFAULT_REGISTRY


def _aggregate(
    per_swap: list[FillReproduction], pools_by_venue: Mapping[str, Sequence[str]]
) -> list[VenueFidelity]:
    by_venue_side: dict[tuple[str, Side], list[float]] = defaultdict(list)
    for rep in per_swap:
        if rep.skipped or rep.error_bps is None or rep.side is None or rep.protocol is None:
            continue
        by_venue_side[(rep.protocol, rep.side)].append(rep.error_bps)

    venues: list[VenueFidelity] = []
    for protocol, pools in pools_by_venue.items():
        buy = SideFidelity(Side.BUY, _percentiles(by_venue_side.get((protocol, Side.BUY), [])))
        sell = SideFidelity(Side.SELL, _percentiles(by_venue_side.get((protocol, Side.SELL), [])))
        if buy.n == 0 and sell.n == 0:
            continue
        venues.append(
            VenueFidelity(protocol=protocol, n_pools=len(pools), buy=buy, sell=sell)
        )
    return venues


def calibrate_independent(
    pools_by_venue: Mapping[str, Sequence[str]],
    reserves_client: ReservesSource,
    swap_fetcher: SwapFetcher,
    config: IndependentCalibrationConfig | None = None,
) -> IndependentCalibrationReport:
    """Run independent-reserve reproduction across venues and aggregate per-venue buy/sell fidelity.

    ``pools_by_venue`` maps a Pinax ``protocol`` to its candidate pools (typically the busiest from a
    recent sample). ``reserves_client`` fetches independent reserves; ``swap_fetcher`` returns raw
    swap rows for a pool. Both are injected, so a fake pair drives the whole aggregation offline in
    tests; the live wiring supplies a real :class:`ReservesClient` and a Pinax-backed fetcher.

    The scan is bounded by ``max_pools_per_venue`` — this never runs an open-ended pool loop.
    """
    cfg = config or IndependentCalibrationConfig()
    per_swap: list[FillReproduction] = []
    unusable: dict[str, str] = {}
    scanned_by_venue: dict[str, list[str]] = {}

    for protocol, pools in pools_by_venue.items():
        scanned: list[str] = []
        for pool in pools:
            if len(scanned) >= cfg.max_pools_per_venue:
                break
            reserves = reserves_client.get_pool_reserves(pool)
            if not reserves.is_complete or reserves.snapshot_block is None:
                unusable[pool] = "reserves_incomplete"
                continue
            rows = swap_fetcher(pool)
            curve: Curve | None = None
            if cfg.per_pool_pumpfun_tier and protocol == "pumpfun_amm":
                curve = resolve_pumpfun_curve(reserves)
            reps = reproduce_pool(
                reserves,
                rows,
                protocol=protocol,
                window=cfg.window,
                curve=curve,
                registry=cfg.registry,
                max_anchor_divergence_bps=cfg.max_anchor_divergence_bps,
                validity_sample=cfg.validity_sample,
            )
            if not reps or all(r.skipped for r in reps):
                reason = reps[0].skip_reason if reps else "no_swaps_at_or_before_snapshot"
                unusable.setdefault(pool, reason or "no_usable_fills")
            per_swap.extend(reps)
            scanned.append(pool)
        scanned_by_venue[protocol] = scanned

    return IndependentCalibrationReport(
        window=cfg.window,
        venues=_aggregate(per_swap, scanned_by_venue),
        per_swap=per_swap,
        unusable_pools=unusable,
    )


# ---------------------------------------------------------------------------------------------
# Live wiring — sample busy pools + a Pinax swap fetcher (network-gated; never unit-tested)
# ---------------------------------------------------------------------------------------------


def sample_pools_by_venue(
    rest: Any,
    *,
    venues: Sequence[str] = ("pumpfun_amm",),
    scan_pages: int = 3,
    pools_per_venue: int = 8,
) -> dict[str, list[str]]:  # pragma: no cover - live/manual
    """Busiest ``venues`` pools from a recent ``/v1/svm/swaps`` sample (newest-first pages)."""
    from collections import Counter

    counters: dict[str, Counter[str]] = {v: Counter() for v in venues}
    for page in range(1, scan_pages + 1):
        payload = rest.get_json(
            "/v1/svm/swaps", {"network": "solana", "limit": 500, "page": page}, use_cache=False
        )
        for row in payload.get("data") or []:
            venue = row.get("protocol")
            pool = row.get("amm_pool")
            if venue in counters and isinstance(pool, str):
                counters[venue][pool] += 1
    return {v: [p for p, _ in counters[v].most_common(pools_per_venue)] for v in venues}


def run_live_report(
    rest: Any | None = None,
    *,
    venues: Sequence[str] = ("pumpfun_amm",),
    config: IndependentCalibrationConfig | None = None,
) -> IndependentCalibrationReport:  # pragma: no cover - live/manual
    """End-to-end live independent-reserve calibration. Network-gated on ``PINAX_API_KEY``.

    Samples busy pools per venue, wires a :class:`ReservesClient` + a Pinax swap fetcher, and returns
    the aggregated per-venue buy/sell fidelity report. Bounded by ``max_pools_per_venue``; makes at
    most ``scan_pages`` + one swaps call per pool + one reserves call per pool.
    """
    from oct_trading_agent.data.pinax_client.reserves import ReservesClient
    from oct_trading_agent.data.pinax_client.rest import PinaxRestClient

    rest = rest or PinaxRestClient()
    reserves_client = ReservesClient(rest)
    pools_by_venue = sample_pools_by_venue(rest, venues=venues)

    def fetch(pool: str) -> list[dict[str, Any]]:
        payload = rest.get_json(
            "/v1/svm/swaps", {"network": "solana", "amm_pool": pool, "limit": 500}, use_cache=False
        )
        return [r for r in (payload.get("data") or []) if isinstance(r, dict)]

    return calibrate_independent(pools_by_venue, reserves_client, fetch, config)


def main() -> None:  # pragma: no cover - manual/live entry point
    report = run_live_report()
    print(report.render())
    flagged = sorted(
        {
            r.amm_pool: r.anchor_divergence_bps
            for r in report.per_swap
            if r.anchor_divergence_bps is not None and r.anchor_divergence_bps > 1000
        }.items()
    )
    if flagged:
        print("\nanchor-offset pools (vault ≠ pricing reserve; median-vs-mid > 1000 bps):")
        for pool, div in flagged:
            print(f"  {pool}  {div:.0f} bps")


if __name__ == "__main__":  # pragma: no cover
    main()


__all__ = [
    "FillReproduction",
    "SideFidelity",
    "VenueFidelity",
    "IndependentCalibrationReport",
    "IndependentCalibrationConfig",
    "SwapFetcher",
    "ReservesSource",
    "reproduce_pool",
    "calibrate_independent",
    "sample_pools_by_venue",
    "run_live_report",
    "pumpfun_market_cap_sol",
    "resolve_pumpfun_curve",
    "PUMPFUN_TOTAL_SUPPLY_UI",
]
