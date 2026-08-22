"""Fill-reproduction check: does modelling pump.fun's real fee stack shrink the residual?

Mirrors the self-consistency method of the first real calibration (PROGRESS 2026-08-22 (h)) and
the reference at ``scratchpad/calib_run1.py``, but drives the Wave-2 ``sim/curves`` fill models
instead of ad-hoc math:

  * pull ~5000 consecutive swaps for the busiest live ``pumpfun_amm`` pool (Pinax REST),
  * fit an initial reserve pair by self-consistency, propagate the sequence swap-by-swap,
  * measure ``|predicted_out / observed_out - 1|`` percentiles, in bps,
  * compare BEFORE (a single flat Uniswap-style LP fee — the old model) against AFTER
    (``PumpFunAmmCurve`` with pump's LP+protocol+creator stack: fee-on-top for buys, fee-out-of-output
    for sells, LP-only reserve retention).

The reserve search runs on floats (fast); the reported residual for each model is then produced by a
single pass through the ACTUAL Decimal curve object, so the headline number comes from the shipped
code, not a float shadow.

Run:  PINAX_API_KEY=... uv run python scripts/pumpfun_fee_repro.py
(The key is also read from backend/.env via oct_trading_agent.config, like the rest of the package.)
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal, getcontext

import numpy as np

from oct_trading_agent.config import get_pinax_credentials
from oct_trading_agent.core import Side
from oct_trading_agent.sim.amm.pool import PoolState
from oct_trading_agent.sim.curves import ConstantProductCurve, Curve, CurveInput, PumpFunAmmCurve
from oct_trading_agent.sim.curves.pumpfun import FeeSplit

getcontext().prec = 40

WSOL = "So11111111111111111111111111111111111111112"
BASE = "https://api.pinax.network"
SWAPS_PATH = "/v1/svm/swaps"
USER_AGENT = "oct-pumpfun-fee-repro/0.1"
PAGE_LIMIT = 500  # Pinax hard cap; >500 -> HTTP 403.
MAX_PAGES = 10  # up to ~5000 swaps.
MIN_SWAPS = 300  # a pool must have at least this many usable pumpfun_amm swaps to be calibratable.
MAX_DRIFT = 1.15  # ... and stay within this price range over the window. See _select_pool.
N_CANDIDATES = 8  # how many of the busiest pools to probe for a well-behaved one.

_API_KEY = get_pinax_credentials().api_key


def _dedup_sorted(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    """Drop page-overlap duplicates (same signature+instruction) and order the pool's swaps causally."""
    seen: set[tuple[object, object]] = set()
    uniq: list[dict[str, object]] = []
    for r in rows:
        key = (r.get("signature"), r.get("instruction_index"))
        if key in seen:
            continue
        seen.add(key)
        uniq.append(r)
    uniq.sort(key=lambda s: (s["block_num"], s["transaction_index"], s["instruction_index"]))
    return uniq


@dataclass(frozen=True)
class ParsedSwap:
    """One usable buy/sell in UI units. ``amount_in``/``observed_out`` are what the model predicts."""

    side: Side
    amount_in: float  # BUY: SOL in; SELL: token in
    observed_out: float  # BUY: token received; SELL: SOL received


def _api(path: str, **params: object) -> dict[str, object]:
    query = {k: v for k, v in params.items() if v is not None}
    url = f"{BASE}{path}?" + urllib.parse.urlencode(query)
    req = urllib.request.Request(
        url, headers={"X-Api-Key": _API_KEY, "User-Agent": USER_AGENT}
    )
    with urllib.request.urlopen(req, timeout=45) as resp:
        payload: dict[str, object] = json.load(resp)
    return payload


def _rank_pools_by_volume() -> list[str]:
    """Busiest ``pumpfun_amm`` pools in a recent multi-page sample, most-active first."""
    rows: list[dict[str, object]] = []
    for page in range(1, 5):  # ~2000 recent swaps
        data = _api(SWAPS_PATH, network="solana", limit=PAGE_LIMIT, page=page)["data"]
        assert isinstance(data, list)
        rows.extend(r for r in data if isinstance(r, dict))
        if len(data) < PAGE_LIMIT:
            break
    counts = Counter(s["amm_pool"] for s in rows if s.get("protocol") == "pumpfun_amm")
    if not counts:
        raise SystemExit("no pumpfun_amm swaps in the recent sample")
    return [str(pool) for pool, _ in counts.most_common(N_CANDIDATES)]


def _pull_pool_pumpfun_swaps(pool: str) -> list[ParsedSwap]:
    """All ``pumpfun_amm`` swaps for one pool, deduped, causally ordered, parsed to buy/sell.

    Filtering to ``protocol == pumpfun_amm`` is deliberate: a router row (jupiter_v6, …) tagged with
    this ``amm_pool`` carries *route-level* input/output amounts, not the amount that hit this pool,
    so it would corrupt reserve propagation. Direct ``pumpfun_amm`` rows carry pool-level amounts.
    """
    rows: list[dict[str, object]] = []
    for page in range(1, MAX_PAGES + 1):
        data = _api(
            SWAPS_PATH,
            network="solana",
            amm_pool=pool,
            protocol="pumpfun_amm",
            limit=PAGE_LIMIT,
            page=page,
        )["data"]
        assert isinstance(data, list)
        rows.extend(r for r in data if isinstance(r, dict))
        if len(data) < PAGE_LIMIT:
            break
    return _parse(_dedup_sorted(rows))


def _parse(rows: list[dict[str, object]]) -> list[ParsedSwap]:
    out: list[ParsedSwap] = []
    for s in rows:
        inm, outm = s.get("input_mint"), s.get("output_mint")
        iv, ov = float(s.get("input_value") or 0), float(s.get("output_value") or 0)
        if iv <= 0 or ov <= 0:
            continue
        if inm == WSOL and outm != WSOL:  # BUY token with SOL: in=SOL(iv), out=token(ov)
            out.append(ParsedSwap(Side.BUY, iv, ov))
        elif outm == WSOL and inm != WSOL:  # SELL token for SOL: in=token(iv), out=SOL(ov)
            out.append(ParsedSwap(Side.SELL, iv, ov))
    return out


def _price_drift(parsed: list[ParsedSwap]) -> float:
    """Max/min executed price over the window — a proxy for how far the reserves travelled.

    The single-initial-reserve self-consistency method is only valid where reserves stay ~stable
    (a deep, liquid pool): a large drift means volume we cannot see (LP add/remove, or router hops)
    moved the pool between the swaps we can, so the propagation — and any fee read off it — diverges.
    """
    prices = [
        p.amount_in / p.observed_out if p.side is Side.BUY else p.observed_out / p.amount_in
        for p in parsed
    ]
    return max(prices) / min(prices) if prices else float("inf")


def _select_pool() -> tuple[str, list[ParsedSwap]]:
    """Pick the busiest pool that is deep+stable enough for the self-consistency method to hold."""
    best: tuple[str, list[ParsedSwap]] | None = None
    for pool in _rank_pools_by_volume():
        try:
            parsed = _pull_pool_pumpfun_swaps(pool)
        except OSError:  # transient Pinax 5xx on one pool — skip it, keep scanning.
            continue
        drift = _price_drift(parsed)
        ok = len(parsed) >= MIN_SWAPS and drift <= MAX_DRIFT
        print(
            f"  candidate {pool[:10]}..  swaps={len(parsed):4d}  drift={drift:5.2f}x  "
            f"{'OK' if ok else 'skip'}"
        )
        if ok:
            best = (pool, parsed)
            break
    if best is None:
        raise SystemExit(
            f"no pumpfun_amm pool met the bar (>= {MIN_SWAPS} swaps, drift <= {MAX_DRIFT}x). "
            "Re-run — pool activity varies minute to minute."
        )
    return best


# --------------------------------------------------------------------------------------------
# Float propagation (fast reserve search). Mirrors each model's exact formulas.
# --------------------------------------------------------------------------------------------


def _predict_before(ins: np.ndarray, sides: np.ndarray, b0: float, q0: float, fee: float) -> np.ndarray:
    """Uniswap-V2 single-fee (the old model): fee on input, full input retained in the pool."""
    b, q = b0, q0
    pred = np.empty(len(ins))
    for i in range(len(ins)):
        if sides[i] == 1:  # buy: SOL in -> token out
            dq = ins[i] * (1.0 - fee)
            out = b * dq / (q + dq)
            pred[i] = out
            b -= out
            q += ins[i]
        else:  # sell: token in -> SOL out
            db = ins[i] * (1.0 - fee)
            out = q * db / (b + db)
            pred[i] = out
            b += ins[i]
            q -= out
        if b <= 0 or q <= 0:
            pred[i:] = np.nan
            break
    return pred


def _predict_after(
    ins: np.ndarray, sides: np.ndarray, b0: float, q0: float, lp: float, out_fee: float
) -> np.ndarray:
    """pump.fun stack: ``lp`` retained in pool, ``out_fee`` (protocol+creator) leaves. Fees on quote."""
    total = lp + out_fee
    b, q = b0, q0
    pred = np.empty(len(ins))
    for i in range(len(ins)):
        if sides[i] == 1:  # buy: fee sits on top of the SOL spent
            eff = ins[i] / (1.0 + total)
            out = b * eff / (q + eff)
            lp_fee = (ins[i] - eff) * (lp / total) if total > 0 else 0.0
            pred[i] = out
            b -= out
            q += eff + lp_fee
        else:  # sell: fee taken out of the gross SOL produced
            gross = q * ins[i] / (b + ins[i])
            total_fee = gross * total
            lp_fee = total_fee * (lp / total) if total > 0 else 0.0
            pred[i] = gross - total_fee
            b += ins[i]
            q += -gross + lp_fee
        if b <= 0 or q <= 0:
            pred[i:] = np.nan
            break
    return pred


def _fit_reserves(
    ins: np.ndarray,
    obs: np.ndarray,
    sides: np.ndarray,
    predict: object,
    mid0: float,
) -> tuple[float, float, float]:
    """Sweep the SOL-side depth (B0 = Q0/mid0), then locally refine. Returns (median_relerr, B0, Q0)."""
    best: tuple[float, float, float] | None = None
    grid = np.geomspace(max(ins.max() * 2, 1e-3), ins.sum() * 50 + 1, 40)
    for q0 in grid:
        b0 = q0 / mid0
        pred = predict(b0, q0)  # type: ignore[operator]
        if np.any(np.isnan(pred)):
            continue
        med = float(np.median(np.abs(pred / obs - 1.0)))
        if best is None or med < best[0]:
            best = (med, b0, q0)
    if best is None:
        raise SystemExit("reserve fit failed (pool drained under every depth guess)")
    med, b0, q0 = best
    for _ in range(40):
        improved = False
        for scale in (1.05, 0.95, 1.01, 0.99, 1.002, 0.998):
            q1 = q0 * scale
            pred = predict(q1 / mid0, q1)  # type: ignore[operator]
            if np.any(np.isnan(pred)):
                continue
            m = float(np.median(np.abs(pred / obs - 1.0)))
            if m < med:
                med, q0, b0 = m, q1, q1 / mid0
                improved = True
        if not improved:
            break
    return med, b0, q0


# --------------------------------------------------------------------------------------------
# Decimal verification: drive the ACTUAL curve object over the sequence and score the residual.
# --------------------------------------------------------------------------------------------


def _score_with_curve(
    parsed: list[ParsedSwap], curve: Curve, b0: float, q0: float
) -> np.ndarray:
    """Propagate through the real curve; return |pred/obs - 1| per swap (nan once a pool drains)."""
    base = Decimal(str(b0))
    quote = Decimal(str(q0))
    rel = np.full(len(parsed), np.nan)
    for i, sw in enumerate(parsed):
        if base <= 0 or quote <= 0:
            break
        state = PoolState(
            mint="pool",
            base_reserve=base,
            quote_reserve=quote,
            slot=i,
            block_time=datetime(2026, 1, 1, tzinfo=UTC),
            anchored=True,
        )
        try:
            fill = curve.fill(CurveInput(side=sw.side, amount_in=Decimal(str(sw.amount_in))), state)
        except (ValueError, ZeroDivisionError):
            break
        pred = fill.base_amount if sw.side is Side.BUY else fill.quote_amount
        rel[i] = abs(float(pred) / sw.observed_out - 1.0)
        base, quote = fill.base_reserve_after, fill.quote_reserve_after
    return rel


def _pct(a: np.ndarray, q: float) -> float:
    return float(np.nanpercentile(a, q) * 1e4)


def _report(tag: str, rel: np.ndarray) -> None:
    print(
        f"  {tag:<22} median={_pct(rel, 50):6.1f}bps  p75={_pct(rel, 75):6.1f}  "
        f"p90={_pct(rel, 90):6.1f}  p99={_pct(rel, 99):7.1f}  "
        f"within-50bps={float(np.nanmean(rel < 0.005)):.3f}"
    )


def _pump_split(total_bps: float) -> FeeSplit:
    """A pump-shaped split (LP 20 / protocol 5 / creator 5 proportions) scaled to ``total_bps``."""
    t = Decimal(str(total_bps))
    return FeeSplit(t * Decimal(20) / Decimal(30), t * Decimal(5) / Decimal(30), t * Decimal(5) / Decimal(30))


def main() -> None:
    print("selecting a deep, stable pumpfun_amm pool (self-consistency needs stable reserves)...")
    pool, parsed = _select_pool()
    print(f"\nchosen pool: {pool}  ({len(parsed)} usable pumpfun_amm swaps)")

    ins = np.array([p.amount_in for p in parsed])
    obs = np.array([p.observed_out for p in parsed])
    sides = np.array([1 if p.side is Side.BUY else -1 for p in parsed])
    mid0 = ins[0] / obs[0] if sides[0] == 1 else obs[0] / ins[0]  # ~ SOL per token at the start

    print("\n=== BEFORE — single flat Uniswap-style LP fee (the old constant-product model) ===")
    # (a) the repo default the sim actually used (Raydium-style 25 bps), fee fixed, reserves fit.
    _med25, b25, q25 = _fit_reserves(
        ins, obs, sides, lambda b, q: _predict_before(ins, sides, b, q, 25 / 1e4), mid0
    )
    rel25 = _score_with_curve(parsed, ConstantProductCurve(fee_bps=25), b25, q25)
    _report("flat 25bps (repo dflt)", rel25)
    # (b) the best single flat fee (what a naive fee-fit would land on).
    before_best: tuple[float, float, float, int] | None = None
    for fee_bps in (10, 15, 20, 25, 30, 40, 50):
        med, b0, q0 = _fit_reserves(
            ins, obs, sides, lambda b, q, f=fee_bps / 1e4: _predict_before(ins, sides, b, q, f), mid0
        )
        if before_best is None or med < before_best[0]:
            before_best = (med, b0, q0, fee_bps)
    assert before_best is not None
    _, bb, qb, fee_before = before_best
    rel_before = _score_with_curve(parsed, ConstantProductCurve(fee_bps=fee_before), bb, qb)
    _report(f"flat {fee_before}bps (best fit)", rel_before)

    print("\n=== AFTER — pump.fun fee stack (LP 20 / protocol 5 / creator 5 = 30 bps, from docs) ===")
    lp_d, out_d = 20 / 1e4, 10 / 1e4
    _med_d, b0_d, q0_d = _fit_reserves(
        ins, obs, sides, lambda b, q: _predict_after(ins, sides, b, q, lp_d, out_d), mid0
    )
    rel_docs = _score_with_curve(
        parsed, PumpFunAmmCurve(fee=FeeSplit(Decimal(20), Decimal(5), Decimal(5))), b0_d, q0_d
    )
    _report("pump 30bps (20/5/5)", rel_docs)

    print("\n=== AFTER — pump.fun mechanics, TOTAL fee free-fit (validates the tier against tape) ===")
    after_best: tuple[float, float, float, float] | None = None
    for total_bps in (20, 22, 24, 26, 28, 30, 32, 34, 36, 40, 45):
        lp = (total_bps * (20 / 30)) / 1e4
        out_fee = (total_bps * (10 / 30)) / 1e4
        med, b0, q0 = _fit_reserves(
            ins, obs, sides, lambda b, q, lp=lp, o=out_fee: _predict_after(ins, sides, b, q, lp, o), mid0
        )
        if after_best is None or med < after_best[0]:
            after_best = (med, b0, q0, total_bps)
    assert after_best is not None
    _, b0_a, q0_a, total_a = after_best
    rel_fit = _score_with_curve(parsed, PumpFunAmmCurve(fee=_pump_split(total_a)), b0_a, q0_a)
    print(f"  best-fit total fee = {total_a:.0f} bps  (published mature tier: 30 bps)")
    _report(f"pump fit {total_a:.0f}bps", rel_fit)


if __name__ == "__main__":
    main()
