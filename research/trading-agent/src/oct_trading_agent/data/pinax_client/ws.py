"""Pinax live WebSocket firehose — the **live tail** counterpart to the REST backfill.

Split of responsibilities (02 §2): **REST ``/v1/svm/swaps`` backfills history; this WS stream tails
live.** Both decode into the *same* :class:`~oct_trading_agent.core.tape.SwapEvent` and land in the
*same* append-only Parquet log.

* Endpoint: ``wss://ws.pinax.network/ws/<network>@<table>?token=<JWT>`` (default
  ``solana@swaps``). The ``<network>@<table>`` stream name is a parameter so the same client
  generalizes to Pinax's other decoded streams later (``solana@spl_transfer``,
  ``bsc@erc20_transfers``, ``robinhood@erc20_transfers``, ``mainnet@swaps``, …) — **not built for
  Phase 0**, which stays scoped to ``solana@swaps``.
* Auth: the ``token`` query param is the **JWT** in ``backend/.env`` as ``PINAX_API_TOKEN`` — NOT
  the raw REST api key. (Raw ``PINAX_API_KEY`` is the REST ``X-Api-Key`` and the Substreams gRPC
  bearer; the WS JWT is a different credential.) Read at runtime from
  :func:`oct_trading_agent.config.get_pinax_api_token`; never logged or hardcoded.

Wire shape (verified live 2026-08-22, captured to ``tests/fixtures/pinax_ws_swaps.json``): the
socket first sends a ``{"type":"session",...}`` control frame, then block frames
``{"network","table","block_num","timestamp_seconds","events":[...]}``. Each *event* carries **raw
base-unit** ``input_amount``/``output_amount`` strings only — no UI ``*_value``, no decimals — so a
``decimals`` map (``mint -> token-decimals``) is required to scale to the UI-unit contract. Frame
decoding is the pure :func:`~.decode.decode_ws_frame`; this module only owns the socket loop.

Optional dependency: ``websockets`` (install the ``ws`` extra). Imported lazily so the package
imports cleanly without it. **No test opens a socket** — the decode path is covered via the fixture.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable, Mapping

from oct_trading_agent.config import get_pinax_api_token
from oct_trading_agent.core import Mint, SwapEvent

from .decode import WSOL, decode_ws_frame

PINAX_WS_BASE = "wss://ws.pinax.network/ws"
DEFAULT_WS_STREAM = "solana@swaps"


class PinaxWebSocketClient:
    """Live-tail decoded swaps from the Pinax WS firehose into :class:`SwapEvent`\\ s.

    Parameters
    ----------
    stream:
        The ``<network>@<table>`` stream name. Defaults to ``solana@swaps`` (Phase-0 scope).
    base_url:
        WS base; defaults to the proven ``wss://ws.pinax.network/ws``.
    token_provider:
        Callable returning the JWT. Defaults to reading it from config at connect time (so the
        token is never captured at construction).
    """

    def __init__(
        self,
        *,
        stream: str = DEFAULT_WS_STREAM,
        base_url: str = PINAX_WS_BASE,
        token_provider: Callable[[], str] | None = None,
    ) -> None:
        self._stream = stream
        self._base_url = base_url.rstrip("/")
        self._token_provider = token_provider or get_pinax_api_token

    def _url(self) -> str:
        # Token is placed in the query per the endpoint contract; the URL is never logged.
        return f"{self._base_url}/{self._stream}?token={self._token_provider()}"

    async def stream_frames(
        self,
    ) -> AsyncIterator[dict[str, object]]:  # pragma: no cover - live socket loop, manual only
        """Connect and yield each raw parsed block frame (``dict``), control frames included.

        The frame-level tail: it carries the per-event ``protocol`` (venue) and ``amm_pool`` that the
        decoded :meth:`stream_swap_events` view drops, and it needs no ``decimals`` map up front — so
        a consumer that DISCOVERS new mints as they launch (the live-capture service) can tail every
        token and classify it from the frame, rather than pre-declaring a watchlist. Non-object and
        non-JSON messages are dropped; the ``session`` handshake is passed through unchanged (it has
        no ``events`` list, so frame decoders treat it as empty).

        Requires the ``ws`` extra (``websockets``); raises ``RuntimeError`` with install guidance if
        it is missing.
        """
        try:
            import websockets
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                "PinaxWebSocketClient requires the 'ws' extra: pip install 'oct-trading-agent[ws]'"
            ) from exc

        async with websockets.connect(self._url(), max_size=None) as socket:
            async for raw in socket:
                frame = _parse_frame(raw)
                if frame is not None:
                    yield frame

    async def stream_swap_events(
        self,
        decimals: Mapping[Mint, int],
        *,
        quote_mint: str = WSOL,
    ) -> AsyncIterator[SwapEvent]:  # pragma: no cover - live socket loop, exercised manually only
        """Connect and yield decoded :class:`SwapEvent`\\ s for tokens present in ``decimals``.

        ``decimals`` is the ``mint -> token-decimals`` map for the watchlist being tailed; events
        whose non-quote leg is not a key are skipped (the firehose carries every token). Control
        frames (``session``) decode to nothing and are ignored. Thin decoded view over
        :meth:`stream_frames` (the socket loop lives there, once).

        Requires the ``ws`` extra (``websockets``); raises ``RuntimeError`` with install guidance if
        it is missing.
        """
        async for frame in self.stream_frames():
            for event in decode_ws_frame(frame, decimals=decimals, quote_mint=quote_mint):
                yield event


def _parse_frame(raw: object) -> dict[str, object] | None:
    """Parse one raw WS message into a frame dict, or ``None`` if it is not a JSON object."""
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", "replace")
    if not isinstance(raw, str):
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return dict(parsed) if isinstance(parsed, dict) else None


__all__ = ["PinaxWebSocketClient", "PINAX_WS_BASE", "DEFAULT_WS_STREAM"]
