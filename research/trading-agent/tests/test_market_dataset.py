"""MarketSwapDataset tests — idempotent append, venue-preserving decode, resumable manifest.

Network-free: rows are handed in directly (the shape a ``PinaxRestClient`` would return), so the whole
accumulator is exercised offline.
"""

from __future__ import annotations

from pathlib import Path

from oct_trading_agent.data.dataset import (
    MarketSwapDataset,
    normalise_raw_row,
)
from oct_trading_agent.data.pinax_client.decode import WSOL

TOKEN = "TokenDatasetMint0000000000000000000000000000"
POOL = "PoolDatasetAmm00000000000000000000000000000"


def _row(
    i: int, *, side: str = "buy", pool: str = POOL, protocol: str = "pumpfun_amm"
) -> dict[str, object]:
    """A raw Pinax swap row (WSOL-quoted). BUY = WSOL in / token out."""
    if side == "buy":
        in_mint, out_mint, in_val, out_val = WSOL, TOKEN, 0.05, 1200.0 + i
    else:
        in_mint, out_mint, in_val, out_val = TOKEN, WSOL, 1000.0 + i, 0.04
    return {
        "amm_pool": pool,
        "protocol": protocol,
        "signature": f"sig{i}",
        "signer": f"wallet{i % 5}",
        "block_num": 1000 + i,
        "timestamp": 1785398148 + i,
        "transaction_index": 0,
        "instruction_index": 0,
        "input_mint": in_mint,
        "output_mint": out_mint,
        "input_value": in_val,
        "output_value": out_val,
    }


def _rows(n: int, **kw: object) -> list[dict[str, object]]:
    return [_row(i, side="buy" if i % 2 == 0 else "sell", **kw) for i in range(n)]  # type: ignore[arg-type]


def test_normalise_rejects_non_wsol_and_missing_fields() -> None:
    assert normalise_raw_row({"amm_pool": POOL, "protocol": "x"}) is None  # missing legs
    tok_tok = _row(0)
    tok_tok["input_mint"] = "OtherMintNotWsol0000000000000000000000000000"
    assert normalise_raw_row(tok_tok) is None  # no WSOL leg
    good = normalise_raw_row(_row(0))
    assert good is not None and good["protocol"] == "pumpfun_amm"


def test_append_is_idempotent_on_signature(tmp_path: Path) -> None:
    ds = MarketSwapDataset(tmp_path)
    rows = _rows(30)
    first = ds.append_rows(rows, pages_pulled=1)
    assert first == 30
    # Re-appending the SAME rows adds nothing (dedup on swap identity).
    second = ds.append_rows(rows, pages_pulled=1)
    assert second == 0
    manifest = ds.load_manifest()
    assert manifest.pool_row_counts[POOL] == 30
    assert manifest.total_rows == 30
    assert manifest.pages_pulled == 2  # cursor advanced both times (resumability)


def test_append_accumulates_new_rows_across_sessions(tmp_path: Path) -> None:
    ds = MarketSwapDataset(tmp_path)
    ds.append_rows(_rows(20))
    # A fresh dataset object over the same root sees the persisted state (cross-session resume).
    ds2 = MarketSwapDataset(tmp_path)
    gained = ds2.append_rows([_row(i, side="buy") for i in range(20, 35)])
    assert gained == 15
    assert ds2.load_manifest().pool_row_counts[POOL] == 35


def test_load_token_tapes_preserves_protocol(tmp_path: Path) -> None:
    ds = MarketSwapDataset(tmp_path)
    ds.append_rows(_rows(40, protocol="orca_whirlpool"))
    tapes = ds.load_token_tapes(min_swaps=24)
    assert len(tapes) == 1
    tape = tapes[0]
    assert tape.mint == TOKEN
    assert all(s.protocol == "orca_whirlpool" for s in tape.swaps)
    assert len(tape.swaps) == 40


def test_load_token_tapes_filters_min_swaps_and_protocol(tmp_path: Path) -> None:
    ds = MarketSwapDataset(tmp_path)
    ds.append_rows(_rows(40, pool="poolA", protocol="pumpfun_amm"))
    ds.append_rows(_rows(10, pool="poolB", protocol="pumpfun_amm"))  # too few
    ds.append_rows(_rows(40, pool="poolC", protocol="raydium_clmm"))
    # min_swaps drops poolB; protocol filter keeps only pumpfun_amm (poolA).
    tapes = ds.load_token_tapes(min_swaps=24, protocols=["pumpfun_amm"])
    assert len(tapes) == 1
    assert tapes[0].swaps[0].protocol == "pumpfun_amm"


def test_load_token_tapes_caps_at_max_tokens(tmp_path: Path) -> None:
    ds = MarketSwapDataset(tmp_path)
    for k in range(5):
        ds.append_rows(_rows(30, pool=f"pool{k}"))
    assert len(ds.load_token_tapes(min_swaps=24, max_tokens=3)) == 3
    assert len(ds.load_token_tapes(min_swaps=24)) == 5
