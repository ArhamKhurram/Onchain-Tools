"""WS live-frame decoder tests against REAL captured solana@swaps frames (no socket)."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from oct_trading_agent.core.enums import Side
from oct_trading_agent.data.pinax_client.decode import (
    WSOL,
    decode_ws_frame,
    decode_ws_frames,
)

_BASE_DECIMALS = 6  # pump-style token; the decimals map is what scales raw WS amounts to UI units


def _first_wsol_event(frames: list[dict[str, Any]]) -> tuple[dict[str, Any], str]:
    """Return (event, tracked_mint) for the first WSOL-pair event across the frames."""
    for frame in frames:
        for event in frame["events"]:
            if event["input_mint"] == WSOL:
                return event, event["output_mint"]
            if event["output_mint"] == WSOL:
                return event, event["input_mint"]
    raise AssertionError("fixture has no WSOL-pair event")


def test_session_frame_yields_nothing(ws_swaps: dict[str, Any]) -> None:
    # The session control frame carries no events -> no tape events.
    assert decode_ws_frame(ws_swaps["session"], decimals={}) == []


def test_decodes_tracked_event_scaling_raw_amounts(ws_swaps: dict[str, Any]) -> None:
    frames = ws_swaps["frames"]
    event, tracked = _first_wsol_event(frames)
    frame = next(f for f in frames if event in f["events"])

    decimals = {tracked: _BASE_DECIMALS}
    events = decode_ws_frame(frame, decimals=decimals)
    assert any(e.mint == tracked for e in events)

    decoded = next(e for e in events if e.mint == tracked and e.signature == event["signature"])
    if event["input_mint"] == WSOL:
        assert decoded.side is Side.BUY
        assert decoded.quote_amount == Decimal(event["input_amount"]) / Decimal(10**9)
        assert decoded.base_amount == Decimal(event["output_amount"]) / Decimal(10**_BASE_DECIMALS)
    else:
        assert decoded.side is Side.SELL
        assert decoded.quote_amount == Decimal(event["output_amount"]) / Decimal(10**9)
        assert decoded.base_amount == Decimal(event["input_amount"]) / Decimal(10**_BASE_DECIMALS)
    assert decoded.price == decoded.quote_amount / decoded.base_amount
    assert decoded.base_reserve_before is None  # WS carries no reserves either


def test_untracked_mints_are_skipped(ws_swaps: dict[str, Any]) -> None:
    frames = ws_swaps["frames"]
    # No mints in the decimals map -> nothing is tracked -> no events.
    assert decode_ws_frames(frames, decimals={}) == []


def test_only_the_tracked_mint_is_emitted(ws_swaps: dict[str, Any]) -> None:
    frames = ws_swaps["frames"]
    _, tracked = _first_wsol_event(frames)
    events = decode_ws_frames(frames, decimals={tracked: _BASE_DECIMALS})
    assert events  # at least one
    assert {e.mint for e in events} == {tracked}
