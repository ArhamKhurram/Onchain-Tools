"""Append-only log: round-trip fidelity, idempotency, slot ordering, partition selection."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from oct_trading_agent.core import (
    HolderChange,
    LiquidityEvent,
    RugEvent,
    SwapEvent,
    TapeEvent,
)
from oct_trading_agent.core.enums import Side
from oct_trading_agent.data.log import TapeLogReader, TapeLogWriter
from oct_trading_agent.data.pinax_client.decode import decode_swap_row

MINT = "TrackedMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"


def _dt(day: int, hour: int = 0) -> datetime:
    return datetime(2026, 8, day, hour, 0, 0, tzinfo=UTC)


def _sample_events() -> list[TapeEvent]:
    return [
        SwapEvent(
            mint=MINT, slot=100, block_time=_dt(1, 1), signature="sigA", signer="w1",
            side=Side.BUY, base_amount=Decimal("1000000"), quote_amount=Decimal("1.5"),
            price=Decimal("0.0000015"),
        ),
        SwapEvent(
            mint=MINT, slot=90, block_time=_dt(1, 0), signature="sigB", signer="w2",
            side=Side.SELL, base_amount=Decimal("500000.123456789"),
            quote_amount=Decimal("0.9"), price=Decimal("0.0000018"),
        ),
        LiquidityEvent(
            mint=MINT, slot=110, block_time=_dt(1, 2), signature="sigC", action="remove",
            provider="lp1", base_amount=Decimal("10"), quote_amount=Decimal("20"),
        ),
        HolderChange(
            mint=MINT, slot=120, block_time=_dt(1, 3), holder_count_delta=-3,
            wallet="w3", top_holder_share=0.42,
        ),
        RugEvent(
            mint=MINT, slot=130, block_time=_dt(1, 4), rug_kind="liquidity_pull",
            detail="creator pulled LP",
        ),
    ]


def test_roundtrip_all_event_kinds_in_slot_order(tmp_path: Path) -> None:
    events = _sample_events()
    writer = TapeLogWriter(tmp_path)
    written = writer.append(events)
    assert written == len(events)

    reader = TapeLogReader(tmp_path)
    replayed = list(reader.replay(MINT))

    # Replayed in ascending slot order regardless of append order.
    assert [e.slot for e in replayed] == [90, 100, 110, 120, 130]
    # Exact model equality (Decimals, None reserves, timestamps preserved).
    by_slot = {e.slot: e for e in events}
    for got in replayed:
        assert got == by_slot[got.slot]


def test_none_reserves_survive_as_none(tmp_path: Path) -> None:
    writer = TapeLogWriter(tmp_path)
    writer.append(_sample_events())
    reader = TapeLogReader(tmp_path)
    swap = next(e for e in reader.replay(MINT) if isinstance(e, SwapEvent))
    assert swap.base_reserve_before is None
    assert swap.quote_reserve_after is None


def test_idempotent_on_signature(tmp_path: Path) -> None:
    events = _sample_events()
    writer = TapeLogWriter(tmp_path)
    assert writer.append(events) == len(events)
    # Re-appending the same events writes nothing new.
    assert writer.append(events) == 0
    reader = TapeLogReader(tmp_path)
    assert len(list(reader.replay(MINT))) == len(events)


def test_time_range_and_partition_selection(tmp_path: Path) -> None:
    events = [
        SwapEvent(
            mint=MINT, slot=10, block_time=_dt(1, 0), signature="d1", signer="w",
            side=Side.BUY, base_amount=Decimal("1"), quote_amount=Decimal("1"),
        ),
        SwapEvent(
            mint=MINT, slot=20, block_time=_dt(2, 0), signature="d2", signer="w",
            side=Side.BUY, base_amount=Decimal("1"), quote_amount=Decimal("1"),
        ),
        SwapEvent(
            mint=MINT, slot=30, block_time=_dt(3, 0), signature="d3", signer="w",
            side=Side.BUY, base_amount=Decimal("1"), quote_amount=Decimal("1"),
        ),
    ]
    writer = TapeLogWriter(tmp_path)
    writer.append(events)
    # Two date partitions created.
    assert {p.name for p in tmp_path.glob("date=*")} == {"date=2026-08-01", "date=2026-08-02", "date=2026-08-03"}

    reader = TapeLogReader(tmp_path)
    # [Aug 2, Aug 3) -> only slot 20 (end is exclusive).
    windowed = list(reader.replay(MINT, start=_dt(2, 0), end=_dt(3, 0)))
    assert [e.slot for e in windowed] == [20]


def test_other_mint_not_returned(tmp_path: Path) -> None:
    writer = TapeLogWriter(tmp_path)
    writer.append(_sample_events())
    reader = TapeLogReader(tmp_path)
    assert list(reader.replay("SomeOtherMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")) == []


def test_real_rest_row_roundtrips_through_log(tmp_path: Path, swaps_page: dict[str, Any]) -> None:
    base = swaps_page["base_mint"]
    events = [e for r in swaps_page["data"] if (e := decode_swap_row(r, base)) is not None]
    writer = TapeLogWriter(tmp_path)
    writer.append(events)
    reader = TapeLogReader(tmp_path)
    replayed = list(reader.replay(base))
    assert len(replayed) == len(events)
    assert sorted(e.slot for e in replayed) == sorted(e.slot for e in events)
