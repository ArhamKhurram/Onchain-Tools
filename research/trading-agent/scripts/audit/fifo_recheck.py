"""Audit Round 1 — the census FIFO realized-PnL engine vs an independent recomputation.

The §07 audit-round ritual (07-improvement-loop.md §2), round 1: pick a few mid-size, non-suspect
wallets from the real snap800 census, rebuild their raw trades from the captured pool parquets
(READ-ONLY), and recompute per-(wallet, token) realized PnL by a DIFFERENT method than the engine,
then compare against the shipped ``census_pairs.parquet`` rows.

What is independent and what is shared, stated plainly:

* **Shared**: trade normalization (``scan_swaps`` — WSOL-leg selection, dedup, fill collapsing)
  and the sort order (``wallet, mint, ts, signature``). The unit under audit is the FIFO engine
  (``data/census/fifo.py``), so both methods must see the same trade sequence; auditing the
  normalizer is a separate round.
* **Independent**: everything after that. The recheck never builds lots. It runs a
  quantity-conservation walk (held inventory, matched vs over-sold base) plus plain quote sums,
  and derives realized PnL as **net quote flow** — total sell quote minus total buy quote — on
  pairs that are FULLY CLOSED (no residual inventory) and FULLY COSTED (no over-sold base). On
  such pairs FIFO's lot accounting must collapse to net flow exactly; any gap is a bug in one of
  the two methods. On all other pairs the structural fields (counts, totals, residual base,
  uncosted sell quote) are cross-checked instead.

Also counted: timestamp-tie ambiguity — adjacent same-``ts`` buy/sell rows within a pair, where
the sort order (and therefore FIFO matching and the net-flow walk alike) is not uniquely
determined by the data. Both methods see the same order here, so agreement is unaffected, but the
count bounds how much of the census rests on an arbitrary tie-break.

Writes a JSON summary under ``data/audit/`` (one of the two writable data dirs) and exits nonzero
on any disagreement beyond float tolerance.

Usage::

    python scripts/audit/fifo_recheck.py                       # auto-picks 3 wallets
    python scripts/audit/fifo_recheck.py --wallets A,B,C       # audit exactly these
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

# Ensure the package imports when run as a plain script from the repo root.
_REPO = Path(__file__).resolve().parents[2]
if str(_REPO / "src") not in sys.path:  # pragma: no cover - script bootstrap
    sys.path.insert(0, str(_REPO / "src"))

REL_TOL = 1e-9
ABS_TOL = 1e-6  # SOL / UI units; census is float64 large-N ranking, not a ledger


@dataclass(frozen=True)
class IndependentPairStats:
    """The recheck's view of one (wallet, token) pair — computed without lots."""

    n_buys: int
    n_sells: int
    buy_quote: float  # total quote spent buying (must equal engine quote_in)
    sell_quote: float  # total quote received selling, matched + uncosted
    matched_base: float  # base sold that had inventory behind it
    uncosted_base: float  # base sold with no inventory behind it (transfer/airdrop proceeds)
    uncosted_quote: float  # quote share of the uncosted base (must equal engine uncosted_sell_quote)
    residual_base: float  # inventory still held at end of data (must equal engine residual_base)
    fully_closed: bool  # residual ~ 0
    fully_costed: bool  # uncosted ~ 0
    net_flow_realized: float | None  # sell_quote - buy_quote, ONLY when fully closed + costed


def independent_pair_stats(
    is_buy: Sequence[bool], base: Sequence[float], quote: Sequence[float]
) -> IndependentPairStats:
    """Quantity-conservation walk over one pair's time-ordered trades. No lots, no unit costs."""
    held = 0.0
    matched = 0.0
    uncosted_base = 0.0
    uncosted_quote = 0.0
    buy_quote = 0.0
    sell_quote = 0.0
    base_bought = 0.0
    n_buys = 0
    n_sells = 0
    for flag, b, q in zip(is_buy, base, quote, strict=True):
        b = float(b)
        q = float(q)
        if b <= 0.0 or q <= 0.0:
            continue  # engine skips degenerate rows; mirror that so counts stay comparable
        if flag:
            n_buys += 1
            buy_quote += q
            base_bought += b
            held += b
        else:
            n_sells += 1
            sell_quote += q
            take = min(b, held)
            held -= take
            matched += take
            over = b - take
            if over > 0.0:
                uncosted_base += over
                uncosted_quote += over * (q / b)
    scale = max(base_bought, matched, 1.0)
    fully_closed = held <= ABS_TOL + REL_TOL * scale
    fully_costed = uncosted_base <= ABS_TOL + REL_TOL * scale
    return IndependentPairStats(
        n_buys=n_buys,
        n_sells=n_sells,
        buy_quote=buy_quote,
        sell_quote=sell_quote,
        matched_base=matched,
        uncosted_base=uncosted_base,
        uncosted_quote=uncosted_quote,
        residual_base=held,
        fully_closed=fully_closed,
        fully_costed=fully_costed,
        net_flow_realized=(sell_quote - buy_quote) if (fully_closed and fully_costed) else None,
    )


def close(a: float, b: float, *, rel: float = REL_TOL, abs_tol: float = ABS_TOL) -> bool:
    return math.isclose(a, b, rel_tol=rel, abs_tol=abs_tol)


def compare_pair(
    engine: dict[str, float], indep: IndependentPairStats
) -> list[str]:
    """All disagreements between the engine's row and the independent recheck (empty = agree)."""
    problems: list[str] = []
    if int(engine["n_buys"]) != indep.n_buys or int(engine["n_sells"]) != indep.n_sells:
        problems.append(
            f"trade counts differ: engine {int(engine['n_buys'])}B/{int(engine['n_sells'])}S "
            f"vs recheck {indep.n_buys}B/{indep.n_sells}S"
        )
    if not close(float(engine["quote_in"]), indep.buy_quote):
        problems.append(
            f"quote_in {engine['quote_in']!r} != recheck buy_quote {indep.buy_quote!r}"
        )
    if not close(float(engine["residual_base"]), indep.residual_base):
        problems.append(
            f"residual_base {engine['residual_base']!r} != recheck {indep.residual_base!r}"
        )
    if not close(float(engine["uncosted_sell_quote"]), indep.uncosted_quote):
        problems.append(
            f"uncosted_sell_quote {engine['uncosted_sell_quote']!r} != recheck {indep.uncosted_quote!r}"
        )
    # The headline check: on fully-closed, fully-costed pairs FIFO must equal net quote flow.
    if indep.net_flow_realized is not None:
        if not close(float(engine["realized_pnl"]), indep.net_flow_realized):
            problems.append(
                f"REALIZED PNL MISMATCH on closed pair: engine {engine['realized_pnl']!r} "
                f"vs net-flow {indep.net_flow_realized!r}"
            )
        if not close(float(engine["quote_out"]), indep.sell_quote):
            problems.append(
                f"quote_out {engine['quote_out']!r} != recheck sell_quote {indep.sell_quote!r}"
            )
    return problems


def pick_wallets(pairs_df: object, suspects: set[str], n: int) -> list[str]:
    """Deterministically pick mid-size, non-suspect wallets spanning the PnL range."""
    import polars as pl

    assert isinstance(pairs_df, pl.DataFrame)
    agg = (
        pairs_df.group_by("wallet")
        .agg(
            pl.col("n_trades").sum().alias("total_trades"),
            pl.len().alias("n_pairs"),
            pl.col("realized_pnl").sum().alias("total_realized"),
        )
        .filter(
            (pl.col("total_trades") >= 50)
            & (pl.col("total_trades") <= 400)
            & (pl.col("n_pairs") >= 5)
            & (pl.col("n_pairs") <= 30)
            & ~pl.col("wallet").is_in(sorted(suspects))
        )
        .sort("total_realized")
    )
    if agg.height < n:
        raise SystemExit(f"only {agg.height} candidate wallets match the mid-size filter")
    # Span the range: most negative, median, most positive — behaviourally diverse, still mid-size.
    idx = [0, agg.height // 2, agg.height - 1][:n]
    return [str(w) for w in agg.get_column("wallet").gather(idx).to_list()]


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", default="data/market_dataset_snap800")
    parser.add_argument("--census", default="data/wallet_census")
    parser.add_argument("--wallets", default=None, help="comma-separated wallet addresses (else auto-pick)")
    parser.add_argument("--n-wallets", type=int, default=3)
    parser.add_argument("--out", default="data/audit/round1_fifo_recheck.json")
    args = parser.parse_args(argv)

    import polars as pl

    from oct_trading_agent.data.census.crawler import scan_swaps

    census_dir = Path(args.census)
    pairs_df = pl.read_parquet(census_dir / "census_pairs.parquet")
    suspects: set[str] = set()
    suspects_path = census_dir / "suspects.json"
    if suspects_path.exists():
        suspects = {
            str(rec["address"]) for rec in json.loads(suspects_path.read_text(encoding="utf-8"))
        }

    if args.wallets:
        wallets = [w.strip() for w in args.wallets.split(",") if w.strip()]
    else:
        wallets = pick_wallets(pairs_df, suspects, args.n_wallets)
    print(f"[audit-1] wallets under audit: {wallets}")

    # Rebuild the raw trades for just these wallets from the captured pool parquets (read-only),
    # with the engine's own normalization + sort so the FIFO engine is the isolated variable.
    trades = (
        scan_swaps(Path(args.dataset))
        .filter(pl.col("wallet").is_in(wallets))
        .collect()
        .sort(["wallet", "mint", "ts", "signature"])
    )
    print(f"[audit-1] rebuilt {trades.height} collapsed trades for {len(wallets)} wallet(s)")

    engine_rows = {
        (str(r["wallet"]), str(r["mint"])): {
            k: r[k]
            for k in (
                "n_buys", "n_sells", "quote_in", "quote_out", "realized_pnl",
                "uncosted_sell_quote", "residual_base",
            )
        }
        for r in pairs_df.filter(pl.col("wallet").is_in(wallets)).to_dicts()
    }

    n_pairs = 0
    n_closed = 0
    n_ties = 0
    discrepancies: list[dict[str, object]] = []
    per_wallet: dict[str, dict[str, float | int]] = {
        w: {"pairs": 0, "closed_pairs": 0, "engine_realized": 0.0, "recheck_net_flow": 0.0}
        for w in wallets
    }
    seen: set[tuple[str, str]] = set()

    for (wallet, mint), group in trades.group_by(["wallet", "mint"], maintain_order=True):  # type: ignore[misc]
        wallet = str(wallet)
        mint = str(mint)
        seen.add((wallet, mint))
        n_pairs += 1
        per_wallet[wallet]["pairs"] = int(per_wallet[wallet]["pairs"]) + 1
        indep = independent_pair_stats(
            group.get_column("is_buy").to_list(),
            group.get_column("base").to_list(),
            group.get_column("quote").to_list(),
        )
        ts = group.get_column("ts").to_list()
        sides = group.get_column("is_buy").to_list()
        n_ties += sum(
            1 for i in range(1, len(ts)) if ts[i] == ts[i - 1] and sides[i] != sides[i - 1]
        )
        engine = engine_rows.get((wallet, mint))
        if engine is None:
            discrepancies.append(
                {"wallet": wallet, "mint": mint, "problems": ["pair missing from census_pairs"]}
            )
            continue
        problems = compare_pair({k: float(v) for k, v in engine.items()}, indep)
        if indep.net_flow_realized is not None:
            n_closed += 1
            per_wallet[wallet]["closed_pairs"] = int(per_wallet[wallet]["closed_pairs"]) + 1
            per_wallet[wallet]["engine_realized"] = (
                float(per_wallet[wallet]["engine_realized"]) + float(engine["realized_pnl"])
            )
            per_wallet[wallet]["recheck_net_flow"] = (
                float(per_wallet[wallet]["recheck_net_flow"]) + indep.net_flow_realized
            )
        if problems:
            discrepancies.append({"wallet": wallet, "mint": mint, "problems": problems})

    missing_in_rebuild = [
        {"wallet": w, "mint": m, "problems": ["pair in census_pairs but absent from rebuild"]}
        for (w, m) in engine_rows
        if (w, m) not in seen
    ]
    discrepancies.extend(missing_in_rebuild)

    print(f"[audit-1] pairs audited: {n_pairs} ({n_closed} fully closed+costed -> exact net-flow check)")
    print(f"[audit-1] timestamp-tie buy/sell adjacencies (order not data-determined): {n_ties}")
    for w in wallets:
        stats = per_wallet[w]
        print(
            f"  {w[:6]}..{w[-4:]}: {stats['pairs']} pairs, {stats['closed_pairs']} closed; "
            f"engine realized on closed {float(stats['engine_realized']):+.6f} SOL vs "
            f"net-flow {float(stats['recheck_net_flow']):+.6f} SOL"
        )
    if discrepancies:
        print(f"[audit-1] DISCREPANCIES: {len(discrepancies)}")
        for d in discrepancies[:20]:
            print(f"  {d['wallet']}/{d['mint']}: {d['problems']}")
    else:
        print("[audit-1] AGREEMENT: engine matches the independent recheck on every audited pair.")

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(
            {
                "round": 1,
                "subsystem": "data/census FIFO realized-PnL engine",
                "dataset": args.dataset,
                "wallets": wallets,
                "n_pairs": n_pairs,
                "n_closed_pairs": n_closed,
                "n_timestamp_tie_adjacencies": n_ties,
                "per_wallet": per_wallet,
                "discrepancies": discrepancies,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"[audit-1] summary -> {out_path}")
    return 1 if discrepancies else 0


if __name__ == "__main__":
    raise SystemExit(main())
