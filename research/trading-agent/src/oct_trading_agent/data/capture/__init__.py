"""capture/ — LIVE first-swaps capture for brand-new pump.fun bonding-curve tokens.

The problem this exists to solve (see PROGRESS + 04-data-spec): a pump.fun token is only tradeable
by the agent during its **pre-migration bonding-curve window** — the token's first minutes. That data
exists **only live**: any historical REST pull of a KNOWN mint returns the post-migration after-picture
(measured: an operator-submitted token showed 4000 swaps but ``bonding_swaps: 0``). So the missing
capability is a live tail that watches the Pinax firehose, spots a mint the moment it trades on the
``pumpfun`` bonding curve, and accumulates its early swaps into the on-disk
:class:`~oct_trading_agent.data.dataset.MarketSwapDataset` — building a corpus of FRESH pre-migration
tokens (and, later, enabling a real-time decision on a just-launched CA).

Transport is reused, not rebuilt: :meth:`~oct_trading_agent.data.pinax_client.ws.PinaxWebSocketClient.stream_frames`
is the input (frame-level, so ``protocol``/``amm_pool`` survive and no watchlist is needed up front);
:class:`~oct_trading_agent.data.dataset.MarketSwapDataset` is the write target (idempotent, venue-tagged,
resumable). The pure engine (:class:`LiveCaptureEngine`) is unit-tested with synthetic frames — no socket.
"""

from __future__ import annotations

from .live_capture import (
    BONDING_PROTOCOL,
    CaptureStats,
    LiveCaptureConfig,
    LiveCaptureEngine,
    MintPhase,
    MintTracker,
    run_capture,
    ws_event_to_raw_row,
)

__all__ = [
    "BONDING_PROTOCOL",
    "CaptureStats",
    "LiveCaptureConfig",
    "LiveCaptureEngine",
    "MintPhase",
    "MintTracker",
    "run_capture",
    "ws_event_to_raw_row",
]
