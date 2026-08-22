"""Real-tape validation of the effective-local-liquidity CLMM fill (``sim/curves/clmm.py``).

Question this answers: **where does the local-liquidity approximation hold, and where does it break?**
That map — not a single headline number — is the deliverable, because the model is honest about being
a local approximation (a CLMM's active liquidity ``L`` steps at every tick, and the tape does not
carry it).

Method (causal, walk-forward — no leakage):
  * pull all swaps for a busy live pool of each concentrated-liquidity protocol (Pinax REST),
  * for each swap ``i``, fit ``L`` from the ``window`` swaps STRICTLY BEFORE it
    (:class:`RollingLocalLiquidityEstimator`), anchor the current mid by propagating that window
    through the fitted ``L``, then predict swap ``i``'s output with the shipped
    :class:`ConcentratedLiquidityCurve`,
  * score ``|pred/obs − 1|`` and STRATIFY it by (a) the swap's realized price move (small in-range vs
    large) and (b) the fitting window's price drift (stable single range vs crossing ticks).

The fee tier per pool is chosen by a coarse pre-fit over the common CLMM tiers (1/4/5/16/25/30/65/100
bps). The reserve/L search runs on floats; the reported residual comes from driving the ACTUAL Decimal
curve object over the sequence, so the headline is the shipped code, not a float shadow.

It also writes a trimmed fixture (``tests/fixtures/clmm_swaps.json``) so ``tests/test_clmm.py`` can pin
a real-data check offline (no network in tests).

Run:  PINAX_API_KEY=... uv run python scripts/clmm_local_liquidity_repro.py
(The key is also read from backend/.env via oct_trading_agent.config, like the rest of the package.)
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from collections import Counter
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path

import numpy as np

from oct_trading_agent.config import get_pinax_credentials
from oct_trading_agent.core import Side
from oct_trading_agent.sim.amm.pool import PoolState
from oct_trading_agent.sim.curves import (
    ConcentratedLiquidityCurve,
    LocalSwapObservation,
    RollingLocalLiquidityEstimator,
)
from oct_trading_agent.sim.curves.base import CurveInput
from oct_trading_agent.sim.curves.clmm import _virtual_reserves

WSOL = "So11111111111111111111111111111111111111112"
BASE = "https://api.pinax.network"
SWAPS_PATH = "/v1/svm/swaps"
USER_AGENT = "oct-clmm-local-liquidity-repro/0.1"
PAGE_LIMIT = 500  # Pinax hard cap; >500 -> HTTP 403.
MAX_PAGES = 12
PROTOCOLS = ("orca_whirlpool", "raydium_clmm", "meteora_dlmm")
FEE_TIERS_BPS = (1, 4, 5, 16, 25, 30, 65, 100)
WINDOW = 50
MIN_SWAPS = 120
N_CANDIDATES = 12
RANK_PAGES = 6  # recent-swap pages sampled to rank busy pools
FEE_SELECT_STRIDE = 4  # subsample the walk-forward during the (expensive) fee sweep

_API_KEY = get_pinax_credentials().api_key
_FIXTURE = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "clmm_swaps.json"


@dataclass(frozen=True)
class ParsedSwap:
    side: Side
    amount_in: float
    observed_out: float


def _api(path: str, **params: object) -> dict[str, object]:
    query = {k: v for k, v in params.items() if v is not None}
    url = f"{BASE}{path}?" + urllib.parse.urlencode(query)
    req = urllib.request.Request(url, headers={"X-Api-Key": _API_KEY, "User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=45) as resp:
        payload: dict[str, object] = json.load(resp)
    return payload


def _dedup_sorted(rows: list[dict[str, object]]) -> list[dict[str, object]]:
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


def _rank_pools(protocol: str) -> list[str]:
    rows: list[dict[str, object]] = []
    for page in range(1, RANK_PAGES + 1):
        data = _api(SWAPS_PATH, network="solana", protocol=protocol, limit=PAGE_LIMIT, page=page)[
            "data"
        ]
        assert isinstance(data, list)
        rows.extend(r for r in data if isinstance(r, dict))
        if len(data) < PAGE_LIMIT:
            break
    counts = Counter(s["amm_pool"] for s in rows if s.get("protocol") == protocol)
    return [str(p) for p, _ in counts.most_common(N_CANDIDATES)]


def _pull_pool(protocol: str, pool: str) -> list[ParsedSwap]:
    rows: list[dict[str, object]] = []
    for page in range(1, MAX_PAGES + 1):
        data = _api(
            SWAPS_PATH,
            network="solana",
            amm_pool=pool,
            protocol=protocol,
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
        if inm == WSOL and outm != WSOL:  # BUY token with SOL
            out.append(ParsedSwap(Side.BUY, iv, ov))
        elif outm == WSOL and inm != WSOL:  # SELL token for SOL
            out.append(ParsedSwap(Side.SELL, iv, ov))
    return out


def _to_obs(parsed: list[ParsedSwap]) -> list[LocalSwapObservation]:
    return [
        LocalSwapObservation(side=p.side, amount_in=Decimal(str(p.amount_in)),
                             observed_out=Decimal(str(p.observed_out)))
        for p in parsed
    ]


def _mid_after_window(
    window: list[LocalSwapObservation], liquidity: Decimal, p0: Decimal, fee: Decimal
) -> Decimal:
    """Propagate ``window`` through the fitted ``L`` and return the mid just before the next swap."""
    x_v, y_v = _virtual_reserves(liquidity, p0)
    f = float(fee)
    xf, yf = float(x_v), float(y_v)
    for s in window:
        amt = float(s.amount_in)
        if s.side is Side.BUY:
            dq = amt * (1.0 - f)
            out = xf * dq / (yf + dq)
            xf -= out
            yf += dq
        else:
            db = amt * (1.0 - f)
            out = yf * db / (xf + db)
            xf += db
            yf -= out
        if xf <= 0 or yf <= 0:
            break
    return Decimal(str(yf / xf)) if xf > 0 else p0


def _walk_forward(
    parsed: list[ParsedSwap], fee_bps: int, window: int, stride: int = 1
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Causal walk-forward. Returns (rel_err, realized_move_frac, window_drift) per predicted swap."""
    from datetime import UTC, datetime

    obs = _to_obs(parsed)
    est = RollingLocalLiquidityEstimator(window=window, fee_bps=fee_bps)
    fee = est.fee_fraction
    rel: list[float] = []
    move: list[float] = []
    drift: list[float] = []
    for i in range(window, len(parsed), stride):
        past = obs[i - window : i]
        try:
            e = est.estimate(past)
        except ValueError:
            continue
        mid = _mid_after_window(past, e.effective_liquidity, e.reference_price, fee)
        curve = ConcentratedLiquidityCurve(effective_liquidity=e.effective_liquidity, fee_bps=fee_bps)
        state = PoolState(
            mint="pool", base_reserve=Decimal(1), quote_reserve=mid, slot=i,
            block_time=datetime(2026, 1, 1, tzinfo=UTC), anchored=True,
        )
        sw = parsed[i]
        try:
            fill = curve.fill(CurveInput(side=sw.side, amount_in=Decimal(str(sw.amount_in))), state)
        except (ValueError, ZeroDivisionError):
            continue
        pred = float(fill.base_amount if sw.side is Side.BUY else fill.quote_amount)
        rel.append(abs(pred / sw.observed_out - 1.0))
        move.append(float(fill.price_move_fraction))
        drift.append(float(e.price_drift))
    return np.array(rel), np.array(move), np.array(drift)


def _best_fee(parsed: list[ParsedSwap], window: int) -> tuple[int, float]:
    """Pick the CLMM fee tier that minimises median walk-forward error (subsampled for speed)."""
    best: tuple[int, float] | None = None
    for fee_bps in FEE_TIERS_BPS:
        rel, _, _ = _walk_forward(parsed, fee_bps, window, stride=FEE_SELECT_STRIDE)
        if rel.size == 0:
            continue
        med = float(np.median(rel))
        if best is None or med < best[1]:
            best = (fee_bps, med)
    return best if best is not None else (30, float("nan"))


def _pcts(a: np.ndarray) -> str:
    if a.size == 0:
        return "no samples"
    q = np.percentile(a, [50, 75, 90, 99]) * 1e4
    return f"median={q[0]:7.1f}bps p75={q[1]:7.1f} p90={q[2]:7.1f} p99={q[3]:8.1f}  n={a.size}"


def _report_pool(
    protocol: str, pool: str, parsed: list[ParsedSwap], fee_bps: int
) -> dict[str, object]:
    rel, move, drift = _walk_forward(parsed, fee_bps, WINDOW)
    print(f"\n{protocol}  pool={pool[:14]}..  swaps={len(parsed)}  best-fit fee={fee_bps}bps")
    print(f"  ALL swaps            {_pcts(rel)}")
    # Stratify: where the model is IN its valid range (small realized move) vs OUT (large move).
    in_range = rel[move <= 0.02]
    out_range = rel[move > 0.02]
    print(f"  in-range  (<=2% move){_pcts(in_range)}")
    print(f"  out-range ( >2% move){_pcts(out_range)}")
    # Stratify by fitting-window drift: stable single range vs window that spanned tick crossings.
    stable = rel[drift <= 1.05]
    crossing = rel[drift > 1.20]
    print(f"  stable window (<=5%) {_pcts(stable)}")
    print(f"  crossing win  (>20%) {_pcts(crossing)}")
    return {
        "protocol": protocol,
        "pool": pool,
        "fee_bps": fee_bps,
        "n": len(parsed),
        "median_bps_all": float(np.median(rel) * 1e4) if rel.size else None,
        "median_bps_in_range": float(np.median(in_range) * 1e4) if in_range.size else None,
        "median_bps_out_range": float(np.median(out_range) * 1e4) if out_range.size else None,
    }


def _write_fixture(fixtures: dict[str, object]) -> None:
    _FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    _FIXTURE.write_text(json.dumps(fixtures, indent=2), encoding="utf-8")
    print(f"\nwrote fixture: {_FIXTURE}")


def main() -> None:
    summary: list[dict[str, object]] = []
    fixture: dict[str, object] = {"_note": "real Pinax CLMM swaps for offline tests; see scripts/clmm_local_liquidity_repro.py"}
    for protocol in PROTOCOLS:
        print(f"\n=== {protocol}: ranking busy pools ===")
        chosen: tuple[str, list[ParsedSwap]] | None = None
        for pool in _rank_pools(protocol):
            try:
                parsed = _pull_pool(protocol, pool)
            except OSError:
                continue
            print(f"  candidate {pool[:12]}..  usable swaps={len(parsed)}")
            if len(parsed) >= MIN_SWAPS:
                chosen = (pool, parsed)
                break
        if chosen is None:
            print(f"  no {protocol} pool met the bar (>= {MIN_SWAPS} swaps) — skipping")
            continue
        pool, parsed = chosen
        fee_bps, _ = _best_fee(parsed, WINDOW)
        summary.append(_report_pool(protocol, pool, parsed, fee_bps))
        # Trim to a compact fixture (first 220 swaps) for offline tests.
        fixture[protocol] = {
            "pool": pool,
            "fee_bps": fee_bps,
            "swaps": [
                {"side": p.side.value, "amount_in": p.amount_in, "observed_out": p.observed_out}
                for p in parsed[:220]
            ],
        }

    print("\n=== SUMMARY (median |pred/obs-1|) ===")
    for row in summary:
        print(
            f"  {row['protocol']:<16} all={row['median_bps_all']!s:>8}bps "
            f"in-range={row['median_bps_in_range']!s:>8}bps out-range={row['median_bps_out_range']!s:>8}bps"
        )
    if len(fixture) > 1:
        _write_fixture(fixture)


if __name__ == "__main__":
    main()
