"""Wallet trade-log exporter — the census cohorts' REAL swaps become the replay substrate.

The census (:mod:`oct_trading_agent.data.census`) already knows every cohort wallet's captured,
WSOL-quoted, fill-collapsed trades — this exporter derives the replay trade log for the WHOLE
cohort (winners and losers alike; it is just rows), never a hand-picked top slice:

1. Scan the captured dataset once through the census' own normalizer
   (:func:`~oct_trading_agent.data.census.crawler.scan_swaps` — import-only, untouched) filtered to
   the cohort's addresses.
2. Walk each (wallet, token) pair's time-ordered trades through an INCREMENTAL FIFO with exactly
   the census engine's rules (:mod:`~oct_trading_agent.data.census.fifo`): sells match oldest lots
   first; proceeds with no cost basis (transfer/airdrop ins) are EXCLUDED from realized PnL. The
   per-trade ``realized_cum`` is that walk's running total, so the final value per pair equals
   ``fifo_pair_pnl().realized_pnl`` to the float (unit-tested).
3. Write one trade-log segment + actors-index segment per cohort
   (:class:`~.log.TradeLogStore`), and optionally the bounded CURATED per-(actor, token) JSON
   showcase for the top wallets (tier 3; ranked by the census' own cross-token realized PnL).

``bal_after`` stays ``None`` for wallets — a real wallet's balance is unknowable from one token's
tape, and this layer never fabricates a number (the trace schema omits it rather than zeroing it).

Run (lean install, no torch)::

    uv run python -m oct_trading_agent.traces.wallets \
        --cohorts data/wallet_census/winners.json data/wallet_census/losers.json \
        --dataset data/market_dataset_snap800 --root data/replay_traces --curated-top 10
"""

from __future__ import annotations

import argparse
import json
import time
from collections import deque
from pathlib import Path
from typing import Any

import polars as pl

from oct_trading_agent.data.census.crawler import scan_swaps

from .curate import curate_group
from .log import TradeLogStore, write_curated_index
from .schema import TradeRow

#: The census-stat keys carried into an actor's ``meta_json`` (the browsing card's substance).
_META_KEYS = (
    "tokens_touched", "total_realized", "median_realized", "profitable_tokens", "n_trades",
    "mean_hold_s", "consistency", "suspect", "one_token_wonder",
)


# ---------------------------------------------------------------------------
# Incremental FIFO — the census engine's rules, walked trade by trade
# ---------------------------------------------------------------------------


class IncrementalFifo:
    """FIFO lot book for ONE (wallet, token) pair, yielding the running realized PnL per trade.

    Same rules as :func:`~oct_trading_agent.data.census.fifo.fifo_pair_pnl` (which returns only the
    aggregate): a buy pushes a ``(base, unit_cost)`` lot; a sell consumes oldest lots first booking
    ``matched * (sell_price - lot_cost)``; sell base with NO lot to match is transfer-in proceeds —
    tallied as ``uncosted`` and NEVER booked as profit. The equivalence is unit-tested against the
    census function itself.
    """

    def __init__(self) -> None:
        self._lots: deque[tuple[float, float]] = deque()  # (base_remaining, unit_cost)
        self.realized = 0.0
        self.uncosted = 0.0

    def trade(self, *, is_buy: bool, base: float, quote: float) -> float:
        """Apply one trade; return the cumulative realized PnL AFTER it (quote units)."""
        if base <= 0.0 or quote <= 0.0:
            return self.realized
        if is_buy:
            self._lots.append((base, quote / base))
            return self.realized
        sell_price = quote / base
        remaining = base
        while remaining > 0.0 and self._lots:
            lot_base, lot_cost = self._lots[0]
            matched = min(remaining, lot_base)
            self.realized += matched * (sell_price - lot_cost)
            remaining -= matched
            if matched >= lot_base:
                self._lots.popleft()
            else:
                self._lots[0] = (lot_base - matched, lot_cost)
        if remaining > 0.0:
            self.uncosted += remaining * sell_price
        return self.realized


def wallet_trade_rows(trades: pl.DataFrame, *, group_id: str) -> list[TradeRow]:
    """Turn a cohort's collapsed trade frame into replay :class:`~.schema.TradeRow`\\ s.

    ``trades`` is :func:`scan_swaps` output collected for the cohort — columns ``wallet, mint,
    is_buy, base, quote, ts, signature``. Rows are ordered ``(wallet, mint, ts, signature)`` (the
    census' own ordering) and each (wallet, mint) pair carries its own FIFO walk and ``seq``.
    """
    df = trades.sort(["wallet", "mint", "ts", "signature"])
    rows: list[TradeRow] = []
    fifo = IncrementalFifo()
    seq = 0
    prev_pair: tuple[str, str] | None = None
    for rec in df.to_dicts():
        pair = (str(rec["wallet"]), str(rec["mint"]))
        if pair != prev_pair:
            fifo = IncrementalFifo()
            seq = 0
            prev_pair = pair
        base = float(rec["base"])
        quote = float(rec["quote"])
        if base <= 0.0 or quote <= 0.0:
            continue
        is_buy = bool(rec["is_buy"])
        realized_cum = fifo.trade(is_buy=is_buy, base=base, quote=quote)
        rows.append(
            TradeRow(
                actor_id=pair[0],
                actor_kind="wallet",
                group_id=group_id,
                mint=pair[1],
                t=int(rec["ts"]),
                seq=seq,
                side="buy" if is_buy else "sell",
                fill=True,
                base=base,
                quote=quote,
                price=quote / base,
                realized_cum=realized_cum,
            )
        )
        seq += 1
    return rows


# ---------------------------------------------------------------------------
# Cohort export
# ---------------------------------------------------------------------------


def _load_cohort(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(data, list), f"cohort file {path} is not a JSON list"
    return [w for w in data if isinstance(w, dict) and isinstance(w.get("address"), str)]


def _actor_index_rows(
    cohort: list[dict[str, Any]], rows: list[TradeRow], *, group_id: str
) -> list[dict[str, Any]]:
    """One actors-index row per cohort wallet: census stats + what the trade log actually holds."""
    touched: dict[str, set[str]] = {}
    counted: dict[str, int] = {}
    realized: dict[str, float] = {}
    for row in rows:
        touched.setdefault(row.actor_id, set()).add(row.mint)
        counted[row.actor_id] = counted.get(row.actor_id, 0) + 1
    # Realized total per wallet = sum over pairs of each pair's FINAL realized_cum (rows are in
    # pair order, so the last row of a pair carries its final value).
    last_by_pair: dict[tuple[str, str], float] = {}
    for row in rows:
        if row.realized_cum is not None:
            last_by_pair[(row.actor_id, row.mint)] = row.realized_cum
    for (wallet, _mint), value in last_by_pair.items():
        realized[wallet] = realized.get(wallet, 0.0) + value

    out: list[dict[str, Any]] = []
    for w in cohort:
        address = str(w["address"])
        census_raw = w.get("census")
        census: dict[str, Any] = census_raw if isinstance(census_raw, dict) else {}
        meta = {k: census.get(k) for k in _META_KEYS if k in census}
        meta["name"] = w.get("name")
        out.append(
            {
                "actor_id": address,
                "actor_kind": "wallet",
                "group_id": group_id,
                "tokens_touched": len(touched.get(address, set())),
                "n_trades": counted.get(address, 0),
                "realized_pnl_quote": realized.get(address),
                "meta_json": json.dumps(meta, sort_keys=True),
            }
        )
    return out


def export_cohort(
    store: TradeLogStore,
    cohort_file: Path,
    dataset_root: Path,
    *,
    group_id: str | None = None,
) -> tuple[str, list[TradeRow], list[dict[str, Any]]]:
    """Derive one cohort's FULL trade log + actors index and write both segments."""
    cohort = _load_cohort(cohort_file)
    gid = group_id or f"census-{cohort_file.stem}"
    addresses = [str(w["address"]) for w in cohort]
    trades = (
        scan_swaps(dataset_root)
        .filter(pl.col("wallet").is_in(addresses))
        .collect()
    )
    rows = wallet_trade_rows(trades, group_id=gid)
    actors = _actor_index_rows(cohort, rows, group_id=gid)
    store.write_segment(f"wallets-{gid}", rows)
    store.write_actors(f"wallets-{gid}", actors)
    return gid, rows, actors


# ---------------------------------------------------------------------------
# Curated showcase (tier 3, bounded)
# ---------------------------------------------------------------------------


def curate_wallets(
    store: TradeLogStore,
    dataset_root: Path,
    *,
    group_id: str,
    rows: list[TradeRow],
    actors: list[dict[str, Any]],
    top: int,
    max_price_points: int,
    max_tokens_per_actor: int = 24,
) -> dict[str, Any]:
    """Write per-(actor, token) trace JSONs for the ``top`` wallets by census realized PnL.

    Bounded twice: ``top`` wallets, and at most ``max_tokens_per_actor`` tokens each (their most
    consequential — a hyperactive bot wallet can touch 900 tokens; the rest stay reachable through
    the on-demand builder).
    """

    def _score(a: dict[str, Any]) -> float:
        meta = json.loads(str(a.get("meta_json") or "{}"))
        return float(meta.get("total_realized") or 0.0)

    chosen = sorted(actors, key=_score, reverse=True)[: max(0, top)]
    return curate_group(
        store, dataset_root, group_id=group_id, actor_kind="wallet",
        rows=rows, actors=chosen, max_price_points=max_price_points,
        max_tokens_per_actor=max_tokens_per_actor,
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:  # pragma: no cover - CLI/IO
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cohorts", type=str, nargs="+", required=True,
        help="census cohort JSON files (winners.json losers.json ...) — the WHOLE cohort is logged",
    )
    parser.add_argument("--dataset", type=str, required=True, help="captured MarketSwapDataset root")
    parser.add_argument("--root", type=str, default="data/replay_traces", help="trace-store root")
    parser.add_argument(
        "--curated-top", type=int, default=10,
        help="per cohort: how many top-realized wallets get the curated JSON showcase (0 = none)",
    )
    parser.add_argument(
        "--curated-max-tokens", type=int, default=24,
        help="per curated wallet: at most this many tokens (its most consequential pairs)",
    )
    parser.add_argument("--max-price-points", type=int, default=500)
    args = parser.parse_args()

    store = TradeLogStore(Path(args.root))
    dataset_root = Path(args.dataset)
    group_entries: list[dict[str, Any]] = []
    for cohort_path in args.cohorts:
        start = time.perf_counter()
        gid, rows, actors = export_cohort(store, Path(cohort_path), dataset_root)
        n_actors_traded = len({r.actor_id for r in rows})
        print(
            f"[wallets] {gid}: {len(rows)} trade rows across {n_actors_traded}/{len(actors)} wallets "
            f"({len({(r.actor_id, r.mint) for r in rows})} (wallet, token) pairs) "
            f"in {time.perf_counter() - start:.1f}s"
        )
        if args.curated_top > 0:
            entry = curate_wallets(
                store, dataset_root, group_id=gid, rows=rows, actors=actors,
                top=args.curated_top, max_price_points=args.max_price_points,
                max_tokens_per_actor=args.curated_max_tokens,
            )
            group_entries.append(entry)
            n_files = sum(len(a["tokens"]) for a in entry["actors"])
            print(f"[wallets] {gid}: curated {n_files} trace JSON(s) for top {len(entry['actors'])} wallets")
    if group_entries:
        index_path = write_curated_index(store.root, group_entries)
        print(f"[wallets] curated index -> {index_path}")


if __name__ == "__main__":  # pragma: no cover
    main()


__all__ = [
    "IncrementalFifo",
    "wallet_trade_rows",
    "export_cohort",
    "curate_wallets",
]
