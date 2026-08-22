"""pinax_client/ — the Pinax new-pair firehose client (02 §2 "Data pipeline").

Three ingest paths, one output type (:class:`~oct_trading_agent.core.tape.SwapEvent`):

* **REST** (:mod:`.rest`, :mod:`.backfill`) — the **primary** path for historical backfill:
  throttled, disk-cached, retrying, paginated. Decodes with :func:`.decode.decode_swap_row`.
* **Live WS** (:mod:`.ws`) — the **live tail**: ``wss://ws.pinax.network/ws/solana@swaps``,
  decoding with :func:`.decode.decode_ws_frame`. Optional ``ws`` extra.
* **Substreams gRPC** (:mod:`.substreams`) — deferred, optional ``firehose`` extra. Not needed for
  the Phase-0 gate.

Live use of any path is **gated on the Pinax credentials** in ``backend/.env``: REST/Substreams
use the raw ``PINAX_API_KEY``; WS uses the ``PINAX_API_TOKEN`` JWT (config.py). Every unit test
runs against fixtures — nothing here touches the network.
"""

from __future__ import annotations

from .backfill import (
    BackfillSummary,
    PinaxRestTapeSource,
    backfill_swaps,
    iter_swap_events,
)
from .decode import (
    WSOL,
    WSOL_DECIMALS,
    decode_swap_row,
    decode_ws_frame,
    decode_ws_frames,
    decode_ws_swap_event,
)
from .reserves import (
    PoolMeta,
    PoolReserves,
    ReservesClient,
)
from .rest import DEFAULT_PAGE_LIMIT, PAGE_LIMIT_MAX, PinaxRestClient
from .substreams import stream_substreams_swaps, substreams_available
from .transport import (
    HttpResponse,
    HttpTransport,
    HttpxTransport,
    UrllibTransport,
)
from .ws import DEFAULT_WS_STREAM, PINAX_WS_BASE, PinaxWebSocketClient

__all__ = [
    # REST
    "PinaxRestClient",
    "DEFAULT_PAGE_LIMIT",
    "PAGE_LIMIT_MAX",
    # decode
    "decode_swap_row",
    "decode_ws_swap_event",
    "decode_ws_frame",
    "decode_ws_frames",
    "WSOL",
    "WSOL_DECIMALS",
    # backfill
    "backfill_swaps",
    "iter_swap_events",
    "BackfillSummary",
    "PinaxRestTapeSource",
    # reserves (independent depth anchors)
    "ReservesClient",
    "PoolMeta",
    "PoolReserves",
    # WS live tail
    "PinaxWebSocketClient",
    "PINAX_WS_BASE",
    "DEFAULT_WS_STREAM",
    # substreams (deferred, optional)
    "substreams_available",
    "stream_substreams_swaps",
    # transport
    "HttpTransport",
    "HttpResponse",
    "UrllibTransport",
    "HttpxTransport",
]
