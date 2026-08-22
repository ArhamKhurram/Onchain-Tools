"""Decode Pinax swap rows into :class:`~oct_trading_agent.core.tape.SwapEvent`.

Two shapes, **one output type**:

* **REST** ``/v1/svm/swaps`` rows (:func:`decode_swap_row`) — pinned against real captured rows in
  ``tests/fixtures/pinax_swaps_page.json``. A REST row carries server-scaled UI amounts
  (``input_value``/``output_value``, floats) *and* per-token ``decimals``.
* **Live WS** ``solana@swaps`` frames (:func:`decode_ws_frame`) — pinned against real captured
  frames in ``tests/fixtures/pinax_ws_swaps.json``. A WS *event* carries **only raw base-unit**
  ``input_amount``/``output_amount`` (strings), no UI ``*_value`` and no decimals — so the WS
  decoder must be given a ``decimals`` map to scale raw units to the UI-unit contract.

Representative REST row::

    {"block_num": 436113080, "timestamp": 1785398148, "signature": "3uazi...priL",
     "signer": "2FDF...RxJF", "input_mint": "So111...1112", "input_value": 1.5,
     "output_mint": "38uo...uhq", "output_value": 1234.5, ...}

Representative WS frame::

    {"network":"solana","table":"swaps","block_num":440941667,"timestamp_seconds":1787408924,
     "events":[{"input_mint":"...","input_amount":"456505607","output_mint":"So111...1112",
                "output_amount":"133760228","signature":"...","user":"...","signers":[...]}]}

Side is from the trader's perspective on the tracked token: spending the quote (WSOL) to receive
it is a BUY; sending it to receive quote is a SELL. Any non-``tracked``↔``quote`` row/event decodes
to ``None``/is skipped.

**Fields either path can populate:** ``mint, slot, block_time, signature, signer, side,
base_amount, quote_amount, price``. **Reserve fields are always ``None``** — neither a REST swap
nor a WS swap carries pool reserves; ``sim/amm`` reconstructs them (``core.tape``: ``None`` means
"not carried", never zero).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from oct_trading_agent.core import Mint, SwapEvent
from oct_trading_agent.core.enums import Side

# The canonical wrapped-SOL mint — the quote leg of virtually every new-pair pool (config.js).
WSOL = "So11111111111111111111111111111111111111112"
# WSOL is a 9-decimal SPL mint. Used to scale raw WS amounts on the quote leg.
WSOL_DECIMALS = 9


def _to_decimal(value: object) -> Decimal | None:
    """Coerce a JSON number/string to ``Decimal`` via its text form (no float drift). ``None``-safe."""
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):  # guard: bool is an int subclass
        return None
    if isinstance(value, (int, float, str)):
        try:
            return Decimal(str(value))
        except (ValueError, ArithmeticError):
            return None
    return None


def _first_str(*values: object) -> str | None:
    for value in values:
        if isinstance(value, str) and value:
            return value
    return None


def _signer_of(row: Mapping[str, Any]) -> str | None:
    """Best signer for a row/event: scalar ``signer``, else ``signers[0]``, else ``user``/``fee_payer``."""
    signers = row.get("signers")
    signers_head = signers[0] if isinstance(signers, list) and signers else None
    return _first_str(row.get("signer"), signers_head, row.get("user"), row.get("fee_payer"))


def _build_swap_event(
    *,
    tracked_mint: Mint,
    slot: int,
    block_time: datetime,
    signature: str | None,
    signer: str,
    side: Side,
    base_amount: Decimal,
    quote_amount: Decimal,
) -> SwapEvent:
    """Assemble a :class:`SwapEvent` from already-scaled UI amounts. Reserves are always ``None``."""
    return SwapEvent(
        mint=tracked_mint,
        slot=slot,
        block_time=block_time,
        signature=signature,
        signer=signer,
        side=side,
        base_amount=base_amount,
        quote_amount=quote_amount,
        price=quote_amount / base_amount,  # quote per base (SOL per token)
        base_reserve_before=None,
        quote_reserve_before=None,
        base_reserve_after=None,
        quote_reserve_after=None,
    )


def decode_swap_row(
    row: Mapping[str, Any],
    tracked_mint: Mint,
    *,
    quote_mint: str = WSOL,
) -> SwapEvent | None:
    """Decode one REST ``/v1/svm/swaps`` row into a :class:`SwapEvent`, or ``None`` if it is not a
    ``tracked_mint``↔``quote_mint`` swap with non-degenerate amounts.

    Uses the server-provided UI amounts (``input_value``/``output_value``) directly.
    """
    input_mint = row.get("input_mint")
    output_mint = row.get("output_mint")

    if input_mint == quote_mint and output_mint == tracked_mint:
        side = Side.BUY
        quote_amount = _to_decimal(row.get("input_value"))
        base_amount = _to_decimal(row.get("output_value"))
    elif input_mint == tracked_mint and output_mint == quote_mint:
        side = Side.SELL
        quote_amount = _to_decimal(row.get("output_value"))
        base_amount = _to_decimal(row.get("input_value"))
    else:
        return None  # token→token route or a pair we do not track

    if base_amount is None or quote_amount is None or base_amount <= 0 or quote_amount <= 0:
        return None

    slot = row.get("block_num")
    timestamp = row.get("timestamp")
    if not isinstance(slot, int) or not isinstance(timestamp, (int, float)):
        return None
    signer = _signer_of(row)
    if signer is None:
        return None

    return _build_swap_event(
        tracked_mint=tracked_mint,
        slot=slot,
        block_time=datetime.fromtimestamp(int(timestamp), tz=UTC),
        signature=_first_str(row.get("signature")),
        signer=signer,
        side=side,
        base_amount=base_amount,
        quote_amount=quote_amount,
    )


def _scale_raw(amount: object, decimals: int) -> Decimal | None:
    """Scale a raw base-unit amount (string/int) to UI units by ``10**decimals``."""
    raw = _to_decimal(amount)
    if raw is None or raw < 0:
        return None
    return raw / (Decimal(10) ** decimals)


def decode_ws_swap_event(
    event: Mapping[str, Any],
    *,
    slot: int,
    block_time: datetime,
    tracked_mint: Mint,
    base_decimals: int,
    quote_mint: str = WSOL,
    quote_decimals: int = WSOL_DECIMALS,
) -> SwapEvent | None:
    """Decode a single live-WS ``solana@swaps`` event (raw base-unit amounts) into a
    :class:`SwapEvent`, or ``None`` if it is not a ``tracked_mint``↔``quote_mint`` swap.

    ``slot``/``block_time`` come from the enclosing frame; ``base_decimals`` scales the tracked
    token's raw amount to UI units (``quote_decimals`` defaults to WSOL's 9).
    """
    input_mint = event.get("input_mint")
    output_mint = event.get("output_mint")

    if input_mint == quote_mint and output_mint == tracked_mint:
        side = Side.BUY
        quote_amount = _scale_raw(event.get("input_amount"), quote_decimals)
        base_amount = _scale_raw(event.get("output_amount"), base_decimals)
    elif input_mint == tracked_mint and output_mint == quote_mint:
        side = Side.SELL
        quote_amount = _scale_raw(event.get("output_amount"), quote_decimals)
        base_amount = _scale_raw(event.get("input_amount"), base_decimals)
    else:
        return None

    if base_amount is None or quote_amount is None or base_amount <= 0 or quote_amount <= 0:
        return None
    signer = _signer_of(event)
    if signer is None:
        return None

    return _build_swap_event(
        tracked_mint=tracked_mint,
        slot=slot,
        block_time=block_time,
        signature=_first_str(event.get("signature")),
        signer=signer,
        side=side,
        base_amount=base_amount,
        quote_amount=quote_amount,
    )


def decode_ws_frame(
    frame: Mapping[str, Any],
    *,
    decimals: Mapping[Mint, int],
    quote_mint: str = WSOL,
) -> list[SwapEvent]:
    """Decode a live-WS block frame into every tracked :class:`SwapEvent` it contains.

    ``decimals`` is the ``mint -> token-decimals`` map for the tokens being tailed; an event is
    decoded only when its non-quote leg is a key in ``decimals`` (i.e. a tracked token). Control
    frames (the ``session`` handshake, or any frame without an ``events`` list) yield ``[]``.
    ``quote_mint``'s decimals default to WSOL's 9 but may be overridden via ``decimals``.
    """
    events = frame.get("events")
    if not isinstance(events, list):
        return []
    slot = frame.get("block_num")
    ts = frame.get("timestamp_seconds")
    if not isinstance(slot, int) or not isinstance(ts, (int, float)):
        return []
    block_time = datetime.fromtimestamp(int(ts), tz=UTC)
    quote_decimals = decimals.get(quote_mint, WSOL_DECIMALS)

    out: list[SwapEvent] = []
    for event in events:
        if not isinstance(event, Mapping):
            continue
        input_mint = event.get("input_mint")
        output_mint = event.get("output_mint")
        # Identify the tracked (non-quote) leg and look up its decimals.
        if input_mint == quote_mint:
            tracked = output_mint
        elif output_mint == quote_mint:
            tracked = input_mint
        else:
            continue  # not a quote pair — token→token route
        if not isinstance(tracked, str) or tracked not in decimals:
            continue
        decoded = decode_ws_swap_event(
            event,
            slot=slot,
            block_time=block_time,
            tracked_mint=tracked,
            base_decimals=decimals[tracked],
            quote_mint=quote_mint,
            quote_decimals=quote_decimals,
        )
        if decoded is not None:
            out.append(decoded)
    return out


def decode_ws_frames(
    frames: Iterable[Mapping[str, Any]],
    *,
    decimals: Mapping[Mint, int],
    quote_mint: str = WSOL,
) -> list[SwapEvent]:
    """Decode a sequence of WS frames, concatenating every tracked :class:`SwapEvent`."""
    out: list[SwapEvent] = []
    for frame in frames:
        out.extend(decode_ws_frame(frame, decimals=decimals, quote_mint=quote_mint))
    return out


__all__ = [
    "decode_swap_row",
    "decode_ws_swap_event",
    "decode_ws_frame",
    "decode_ws_frames",
    "WSOL",
    "WSOL_DECIMALS",
]
