"""Offline extractor: turn a bounded sample of the live-capture probe's per-pool parquets into a
JSON array of REAL fresh-token launches for the Desk Console "RECORDED FIREHOSE" feed.

Reads ``data/live_capture_probe/pools/<amm_pool>.parquet`` (MarketSwapDataset raw-row schema:
amm_pool, protocol, signature, block_num, timestamp, input_mint, output_mint, input_value,
output_value, ...). Per token it emits ONLY real, load-bearing facts:

    mint (full + short display form), amm_pool, birth (first-swap unix ts), first price
    (SOL per token from the first swap's quote/base legs), venue/protocol, swap count.

Sorted by birth time. Bounded to a lively sample (default 48 mints, min 8 swaps each) so the
inlined literal stays small — NOT all 322 pools.

Run with the repo venv:  .venv\\Scripts\\python.exe scripts\\extract_market_ticks.py
"""

from __future__ import annotations

import json
from pathlib import Path

import polars as pl

WSOL = "So11111111111111111111111111111111111111112"
ROOT = Path(__file__).resolve().parent.parent
POOLS = ROOT / "data" / "live_capture_probe" / "pools"

MAX_MINTS = 48   # bounded sample for a lively feed (not all 322)
MIN_SWAPS = 8    # skip near-empty pools so every feed line has substance


def short_mint(mint: str) -> str:
    """Pump.fun-style short display id, e.g. 'BJBD…pump'. Full string kept in `mint`."""
    if len(mint) <= 9:
        return mint
    return f"{mint[:4]}…{mint[-4:]}"


def tracked_mint(df: pl.DataFrame) -> str | None:
    for leg in (df["input_mint"].to_list(), df["output_mint"].to_list()):
        for m in leg:
            if isinstance(m, str) and m and m != WSOL:
                return m
    return None


def first_price(row: dict) -> float | None:
    """SOL per token from the first swap. WSOL leg is the quote, the other the base (token)."""
    im, om = row["input_mint"], row["output_mint"]
    iv, ov = row["input_value"], row["output_value"]
    if im == WSOL and om != WSOL:      # BUY: spend WSOL (quote) -> receive token (base)
        quote, base = iv, ov
    elif om == WSOL and im != WSOL:    # SELL: send token (base) -> receive WSOL (quote)
        quote, base = ov, iv
    else:
        return None
    if not base or base <= 0 or not quote or quote <= 0:
        return None
    return float(quote) / float(base)


def main() -> int:
    records = []
    for path in sorted(POOLS.glob("*.parquet")):
        df = pl.read_parquet(path)
        if df.height < MIN_SWAPS:
            continue
        df = df.sort(["block_num", "transaction_index", "instruction_index"])
        mint = tracked_mint(df)
        if mint is None:
            continue
        # majority protocol (venue)
        proto = (
            df["protocol"].drop_nulls().value_counts(sort=True)["protocol"][0]
            if df["protocol"].drop_nulls().len()
            else None
        )
        if not proto:
            continue
        rows = df.to_dicts()
        first = rows[0]
        birth = int(first["timestamp"])
        price = first_price(first)
        records.append(
            {
                "mint": mint,
                "short": short_mint(mint),
                "pool": first["amm_pool"],
                "birth": birth,
                "venue": proto,
                "swaps": df.height,
                "first_price": price,
            }
        )

    records.sort(key=lambda r: r["birth"])
    records = _spread(records, MAX_MINTS)
    print(json.dumps(records, indent=2))
    print(f"\n# {len(records)} tokens emitted (min_swaps={MIN_SWAPS})", flush=True)
    return 0


def _spread(records: list[dict], k: int) -> list[dict]:
    """Evenly sample ``k`` records across the birth-sorted list, so the feed clock spans the whole
    ~3-minute capture window rather than only the opening-second burst. Chronological order kept.
    Every chosen record is still a real, unmodified captured token."""
    n = len(records)
    if n <= k:
        return records
    idx = sorted({round(i * (n - 1) / (k - 1)) for i in range(k)})
    return [records[i] for i in idx]


if __name__ == "__main__":
    raise SystemExit(main())
