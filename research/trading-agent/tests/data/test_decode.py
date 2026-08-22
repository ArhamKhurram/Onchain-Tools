"""Decoder tests against REAL captured Pinax REST swap rows (no network)."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from oct_trading_agent.core.enums import Side
from oct_trading_agent.data.pinax_client.decode import WSOL, decode_swap_row


def test_decodes_real_rows_into_swapevents(swaps_page: dict[str, Any]) -> None:
    base = swaps_page["base_mint"]
    rows = swaps_page["data"]
    decoded = [decode_swap_row(r, base) for r in rows]
    events = [e for e in decoded if e is not None]

    # Every base<->WSOL row in the fixture decodes.
    assert len(events) == len(rows)

    for ev, row in zip(events, rows, strict=True):
        assert ev.mint == base
        assert ev.slot == row["block_num"]
        assert ev.block_time == datetime.fromtimestamp(int(row["timestamp"]), tz=UTC)
        assert ev.signature == row["signature"]
        assert ev.base_amount > 0 and ev.quote_amount > 0
        assert ev.price == ev.quote_amount / ev.base_amount
        # Reserves are never carried by a REST swap — None, not zero.
        assert ev.base_reserve_before is None
        assert ev.quote_reserve_after is None


def test_side_is_from_trader_perspective(swaps_page: dict[str, Any]) -> None:
    base = swaps_page["base_mint"]
    for row in swaps_page["data"]:
        ev = decode_swap_row(row, base)
        assert ev is not None
        if row["input_mint"] == WSOL:  # spent SOL to get the token
            assert ev.side is Side.BUY
        else:  # sent the token to get SOL
            assert ev.side is Side.SELL


def test_buy_amount_mapping(swaps_page: dict[str, Any]) -> None:
    base = swaps_page["base_mint"]
    buy_row = next(r for r in swaps_page["data"] if r["input_mint"] == WSOL)
    ev = decode_swap_row(buy_row, base)
    assert ev is not None
    assert ev.side is Side.BUY
    assert ev.quote_amount == Decimal(str(buy_row["input_value"]))
    assert ev.base_amount == Decimal(str(buy_row["output_value"]))


def test_non_pair_row_returns_none() -> None:
    row = {
        "block_num": 1,
        "timestamp": 1785398148,
        "signer": "w",
        "input_mint": "OtherMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "input_value": 1.0,
        "output_mint": "OtherMintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        "output_value": 2.0,
    }
    assert decode_swap_row(row, "TrackedMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx") is None


def test_degenerate_amount_returns_none() -> None:
    row = {
        "block_num": 1,
        "timestamp": 1785398148,
        "signer": "w",
        "input_mint": WSOL,
        "input_value": 0,
        "output_mint": "TrackedMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "output_value": 100.0,
    }
    assert decode_swap_row(row, "TrackedMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx") is None
