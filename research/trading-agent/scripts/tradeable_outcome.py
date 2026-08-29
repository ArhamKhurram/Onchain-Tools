"""Does the co-occurrence edge survive trading costs? (09 §8.2 — first cut)

PROGRESS 2026-08-29 cleared §8.1: the smart-wallet co-occurrence signal is real under a
point-in-time roster. But its outcome measure is still ``token p99 peak / first price`` — "did it
run", not "could you have traded it". §8.2 demands a fee-net forward return from a *tradeable* entry.

THIS IS THE FIRST CUT, AND IT IS DELIBERATELY NOT THE FULL SIM. It measures return off the observed
trade-price path — which already embeds each real trade's LP fee and realized slippage — then
charges an explicit round-trip cost on top. What it does NOT do is re-price the entry/exit against
reconstructed pool depth for OCT's own order size (that is ``sim/replay`` + ``execution/model``, the
rigorous version §8.2 ultimately wants). So read every number here as an OPTIMISTIC bound on a
small-size taker: real fills at size would be worse, never better. If the edge dies even here, it
dies for real; if it survives, the full sim is the confirmation, not the discovery.

Entry is tradeable, not hindsight: you act when the signal has FORMED, i.e. at the price the moment
the early-buyer window closes (queue position = EARLY_WINDOW x token_trades). You cannot buy earlier
than the accumulation you are reacting to.

Three exit policies bracket reality:
  * ``ceiling``  — sell at the max price in the forward window. Perfect timing; the optimistic bound.
  * ``hold_end`` — sell at the last price in the window. Buy-and-forget; the pessimistic bound.
  * ``tp_sl``    — first touch of +TP or -SL, else hold_end. A rule you could actually run unattended.

Round-trip cost = 2 x TAKER_FEE_BPS (both legs) + ROUND_TRIP_SLIP_BPS (a haircut standing in for the
size-dependent slippage the observed mid-price path omits). Defaults are pump.fun-ish and
conservative; every one is a CLI knob because they are trading-judgment calls, not facts.

Usage:
    uv run python scripts/tradeable_outcome.py
    uv run python scripts/tradeable_outcome.py --taker-fee-bps 100 --slip-bps 300 --tp 2.0 --sl 0.5
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import polars as pl

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from oct_trading_agent.data.census.crawler import scan_swaps  # noqa: E402

# Reuse the exact period-B / roster / early-buyer construction the §8.1 check already validated.
from pit_roster_check import (  # noqa: E402
    EARLY_WINDOW,
    MIN_EARLY_BUYERS,
    MIN_TOKEN_TRADES,
    BANDS,
    first_buys,
    smart_roster,
    early_buyers,
)


def token_price_paths(trades: pl.DataFrame, boundary_ts: int) -> dict[str, list[float]]:
    """Per period-B token: its ordered priced-trade path (queue order). Entry/exit read off this."""
    priced = (
        trades.filter((pl.col("base") > 0))
        .with_columns((pl.col("quote") / pl.col("base")).alias("price"))
        .sort(["mint", "ts"])
    )
    tok_first = priced.group_by("mint").agg(pl.col("ts").min().alias("first_ts"), pl.len().alias("n"))
    keep = tok_first.filter(
        (pl.col("first_ts") > boundary_ts) & (pl.col("n") >= MIN_TOKEN_TRADES)
    ).select("mint")
    priced = priced.join(keep, on="mint", how="inner")
    paths: dict[str, list[float]] = {}
    for mint, sub in priced.group_by("mint", maintain_order=True):
        paths[mint[0] if isinstance(mint, tuple) else mint] = sub["price"].to_list()
    return paths


def net_returns(path: list[float], entry_idx: int, sl: float, trail: float, rt_cost: float):
    """Net returns off `path` from `entry_idx`, each minus round-trip cost. Four exit policies:

    ceiling  — sell at the forward max (perfect timing; optimistic bound, uncapped upside).
    hold_end — sell at the last price (buy-and-forget; pessimistic bound, uncapped upside).
    stop     — hold until price first touches -SL, else hold_end. UPSIDE UNCAPPED (unlike a TP rule).
    trail    — sell when price falls `trail` from its running max since entry, else hold_end. This is
               the right-tail-preserving rule: it rides a runner and only exits on a real reversal.
    """
    entry = path[entry_idx]
    fwd = path[entry_idx + 1 :]
    if entry <= 0 or not fwd:
        return None
    ceiling = max(fwd) / entry - 1.0
    hold_end = fwd[-1] / entry - 1.0

    stop = hold_end
    for p in fwd:
        if p / entry - 1.0 <= sl - 1.0:
            stop = sl - 1.0
            break

    trail_ret = hold_end
    run_max = entry
    for p in fwd:
        run_max = max(run_max, p)
        if p <= run_max * trail:           # fell `trail` (e.g. 0.5 => -50%) off the peak-so-far
            trail_ret = p / entry - 1.0
            break

    return tuple(x - rt_cost for x in (ceiling, hold_end, stop, trail_ret))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dataset", type=Path, default=REPO / "data" / "market_dataset_large")
    ap.add_argument("--taker-fee-bps", type=float, default=100.0, help="per-leg taker/LP fee (pump.fun ~100)")
    ap.add_argument("--slip-bps", type=float, default=300.0, help="round-trip slippage haircut the mid-path omits")
    ap.add_argument("--sl", type=float, default=0.5, help="hard stop multiple (0.5 = -50%)")
    ap.add_argument("--trail", type=float, default=0.5, help="trailing stop: exit on fall of this off the running max")
    args = ap.parse_args()

    rt_cost = (2 * args.taker_fee_bps + args.slip_bps) / 10_000.0
    print(f"[outcome] round-trip cost = {rt_cost:.3%} (2x{args.taker_fee_bps}bps fee + {args.slip_bps}bps slip); "
          f"sl={args.sl}x trail={args.trail}", flush=True)

    trades = scan_swaps(args.dataset).collect()
    pairs = first_buys(trades)
    boundary_ts = int(pairs["first_buy_ts"].median())
    roster = smart_roster(trades.filter(pl.col("ts") <= boundary_ts),
                          pairs.filter(pl.col("first_buy_ts") <= boundary_ts))
    print(f"[outcome] PIT roster: {len(roster)} wallets; boundary T={boundary_ts}", flush=True)

    paths = token_price_paths(trades, boundary_ts)
    eb = early_buyers(trades, pl.DataFrame({"mint": list(paths.keys())})
                      .join(trades.group_by("mint").agg(pl.len().alias("token_trades")), on="mint"))
    counts = eb.group_by("mint").agg(pl.len().alias("early_buyers"))
    smart = eb.join(roster, on="wallet", how="inner").group_by("mint").agg(pl.len().alias("smart_count"))
    scored = (
        counts.filter(pl.col("early_buyers") >= MIN_EARLY_BUYERS)
        .join(smart, on="mint", how="left")
        .with_columns(pl.col("smart_count").fill_null(0))
    )

    # Per token: entry at the trade where the early window closes, then net returns.
    rows = []
    for r in scored.iter_rows(named=True):
        path = paths.get(r["mint"])
        if not path:
            continue
        entry_idx = min(int(EARLY_WINDOW * len(path)), len(path) - 2)
        if entry_idx < 0:
            continue
        res = net_returns(path, entry_idx, args.sl, args.trail, rt_cost)
        if res is None:
            continue
        rows.append({"smart_count": r["smart_count"],
                     "ceiling": res[0], "hold": res[1], "stop": res[2], "trail": res[3]})
    df = pl.DataFrame(rows)
    print(f"[outcome] tokens with a tradeable entry+exit: {len(df)}\n", flush=True)

    # MEAN return is the right statistic — a right-tail memecoin signal is judged on EV, not the
    # (always-negative) median. win% is the trailing-stop win rate. Both trail columns keep the
    # right tail uncapped, so a runner the signal predicted actually pays.
    print(f"{'smart':<7}{'tokens':>7}{'EV trail':>11}{'win% trail':>12}"
          f"{'EV stop':>10}{'EV hold':>10}{'med trail':>11}", flush=True)
    print("-" * 71, flush=True)
    for lo, hi, label in BANDS:
        seg = df.filter((pl.col("smart_count") >= lo) & (pl.col("smart_count") <= hi))
        if len(seg) == 0:
            continue
        print(f"{label:<7}{len(seg):>7}{seg['trail'].mean():>11.1%}{(seg['trail'] > 0).mean():>12.1%}"
              f"{seg['stop'].mean():>10.1%}{seg['hold'].mean():>10.1%}{seg['trail'].median():>11.1%}",
              flush=True)
    print("\n(EV = mean net return, the statistic a right-tail strategy lives or dies on; "
          "median stays negative by design — that's Rule 18, not a failure.)", flush=True)

    # Is any band's EV distinguishable from zero, or is a tail-driven mean on ~120 tokens just noise?
    # Bootstrap the trail EV per band. A CI straddling zero means "not even a candidate", which
    # decides whether the full depth-priced sim is worth building.
    import random
    rng = random.Random(0)  # Math.random is banned in workflows, fine in a plain script; fixed seed
    print(f"\n{'smart':<7}{'tokens':>7}{'trail EV':>10}{'  90% bootstrap CI':>22}{'  P(EV>0)':>10}", flush=True)
    print("-" * 56, flush=True)
    for lo, hi, label in BANDS:
        vals = df.filter((pl.col("smart_count") >= lo) & (pl.col("smart_count") <= hi))["trail"].to_list()
        if len(vals) < 20:
            continue
        means = []
        for _ in range(2000):
            s = [vals[rng.randrange(len(vals))] for _ in range(len(vals))]
            means.append(sum(s) / len(s))
        means.sort()
        lo_ci, hi_ci = means[100], means[1900]  # 5th / 95th pct
        p_pos = sum(1 for m in means if m > 0) / len(means)
        print(f"{label:<7}{len(vals):>7}{sum(vals)/len(vals):>10.1%}"
              f"   [{lo_ci:>6.1%}, {hi_ci:>6.1%}]{p_pos:>10.1%}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
