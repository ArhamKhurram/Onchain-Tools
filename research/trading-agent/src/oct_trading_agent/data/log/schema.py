"""Columnar schema + (event ⇄ row) codec for the append-only tape log.

One flat, nullable-union row shape covers all four :data:`~oct_trading_agent.core.tape.TapeEvent`
variants, tagged by ``kind``. Design choices that matter:

* **Decimals are stored as strings.** On-chain amounts are exact ``Decimal``\\ s (``core.tape``
  models them precisely to avoid float drift); round-tripping them through Parquet as text preserves
  every digit. They are re-parsed to ``Decimal`` on read. ``None`` stays ``None`` (never 0).
* **``event_id`` is the idempotency key.** It is the tx ``signature`` when present, else a
  ``syn:``-prefixed hash of the event's canonical JSON — so events that genuinely lack a signature
  (holder/rug deltas) still dedupe deterministically.
* **``date`` is the partition column**, derived from ``block_time`` (UTC ``YYYY-MM-DD``) — the log
  is time-partitioned per 04-data-spec §4.
* **``slot`` is the ordering key** for replay; the reader sorts by ``(slot, event_id)``.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import polars as pl

from oct_trading_agent.core import (
    HolderChange,
    LiquidityEvent,
    Mint,
    RugEvent,
    SwapEvent,
    TapeEvent,
)
from oct_trading_agent.core.enums import Side

# Column order is stable so Parquet files stay schema-compatible across appends.
POLARS_SCHEMA: dict[str, pl.DataType] = {
    "event_id": pl.String(),
    "kind": pl.String(),
    "mint": pl.String(),
    "slot": pl.Int64(),
    "block_time": pl.Datetime("us", "UTC"),
    "signature": pl.String(),
    # swap / shared amount fields (liquidity reuses base_amount/quote_amount/base_reserve_after/…)
    "signer": pl.String(),
    "side": pl.String(),
    "base_amount": pl.String(),
    "quote_amount": pl.String(),
    "price": pl.String(),
    "base_reserve_before": pl.String(),
    "quote_reserve_before": pl.String(),
    "base_reserve_after": pl.String(),
    "quote_reserve_after": pl.String(),
    # liquidity
    "action": pl.String(),
    "provider": pl.String(),
    # holder
    "holder_count_delta": pl.Int64(),
    "wallet": pl.String(),
    "top_holder_share": pl.Float64(),
    # rug
    "rug_kind": pl.String(),
    "detail": pl.String(),
    # partition
    "date": pl.String(),
}


def _d(value: Decimal | None) -> str | None:
    return None if value is None else str(value)


def _pd(value: object) -> Decimal | None:
    return None if value is None else Decimal(str(value))


def _pd_req(value: object) -> Decimal:
    """Parse a REQUIRED Decimal field; a stored ``None`` here means a corrupt row."""
    if value is None:
        raise ValueError("required Decimal column was null in the tape log")
    return Decimal(str(value))


def event_id(event: TapeEvent) -> str:
    """Idempotency key: the tx signature, else a stable hash of the event's canonical JSON."""
    if event.signature:
        return event.signature
    digest = hashlib.sha256(event.model_dump_json().encode("utf-8")).hexdigest()
    return f"syn:{digest[:40]}"


def _partition_date(block_time: datetime) -> str:
    return block_time.astimezone(UTC).date().isoformat()


def tape_event_to_row(event: TapeEvent) -> dict[str, Any]:
    """Flatten any :data:`TapeEvent` into a single row dict matching :data:`POLARS_SCHEMA`."""
    row: dict[str, Any] = dict.fromkeys(POLARS_SCHEMA)
    row["event_id"] = event_id(event)
    row["kind"] = event.kind
    row["mint"] = event.mint
    row["slot"] = event.slot
    row["block_time"] = event.block_time
    row["signature"] = event.signature
    row["date"] = _partition_date(event.block_time)

    if isinstance(event, SwapEvent):
        row["signer"] = event.signer
        row["side"] = event.side.value
        row["base_amount"] = _d(event.base_amount)
        row["quote_amount"] = _d(event.quote_amount)
        row["price"] = _d(event.price)
        row["base_reserve_before"] = _d(event.base_reserve_before)
        row["quote_reserve_before"] = _d(event.quote_reserve_before)
        row["base_reserve_after"] = _d(event.base_reserve_after)
        row["quote_reserve_after"] = _d(event.quote_reserve_after)
    elif isinstance(event, LiquidityEvent):
        row["action"] = event.action
        row["provider"] = event.provider
        row["base_amount"] = _d(event.base_amount)
        row["quote_amount"] = _d(event.quote_amount)
        row["base_reserve_after"] = _d(event.base_reserve_after)
        row["quote_reserve_after"] = _d(event.quote_reserve_after)
    elif isinstance(event, HolderChange):
        row["holder_count_delta"] = event.holder_count_delta
        row["wallet"] = event.wallet
        row["top_holder_share"] = event.top_holder_share
    elif isinstance(event, RugEvent):
        row["rug_kind"] = event.rug_kind
        row["detail"] = event.detail
    return row


def _block_time(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    raise TypeError(f"block_time must be datetime, got {type(value)!r}")


def row_to_tape_event(row: Mapping[str, Any]) -> TapeEvent:
    """Reconstruct the exact :data:`TapeEvent` variant from a stored row."""
    kind = row["kind"]
    mint: Mint = row["mint"]
    common = {
        "mint": mint,
        "slot": row["slot"],
        "block_time": _block_time(row["block_time"]),
        "signature": row["signature"],
    }
    if kind == "swap":
        return SwapEvent(
            **common,
            signer=row["signer"],
            side=Side(row["side"]),
            base_amount=_pd_req(row["base_amount"]),
            quote_amount=_pd_req(row["quote_amount"]),
            price=_pd(row["price"]),
            base_reserve_before=_pd(row["base_reserve_before"]),
            quote_reserve_before=_pd(row["quote_reserve_before"]),
            base_reserve_after=_pd(row["base_reserve_after"]),
            quote_reserve_after=_pd(row["quote_reserve_after"]),
        )
    if kind == "liquidity":
        return LiquidityEvent(
            **common,
            action=row["action"],
            provider=row["provider"],
            base_amount=_pd_req(row["base_amount"]),
            quote_amount=_pd_req(row["quote_amount"]),
            base_reserve_after=_pd(row["base_reserve_after"]),
            quote_reserve_after=_pd(row["quote_reserve_after"]),
        )
    if kind == "holder":
        return HolderChange(
            **common,
            holder_count_delta=row["holder_count_delta"],
            wallet=row["wallet"],
            top_holder_share=row["top_holder_share"],
        )
    if kind == "rug":
        return RugEvent(**common, rug_kind=row["rug_kind"], detail=row["detail"])
    raise ValueError(f"unknown tape event kind: {kind!r}")


__all__ = [
    "POLARS_SCHEMA",
    "event_id",
    "tape_event_to_row",
    "row_to_tape_event",
]
