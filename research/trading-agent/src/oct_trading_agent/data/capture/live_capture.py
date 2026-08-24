"""Live first-swaps capture — spot brand-new ``pumpfun`` bonding-curve tokens and cache their swaps.

Pipeline::

    PinaxWebSocketClient.stream_frames()   # frame-level live tail (protocol + amm_pool survive)
        -> LiveCaptureEngine.ingest_frame  # per-event: classify mint, build raw row, buffer
        -> MarketSwapDataset.append_rows    # idempotent, venue-tagged, resumable on-disk cache

Why the FRAME tail and not the decoded :meth:`stream_swap_events` view? Discovery cannot pre-declare a
watchlist (the whole point is finding mints we have never seen), and the dataset is **venue-preserving**
— it partitions by ``amm_pool`` and keeps ``protocol``, both of which the decoded ``SwapEvent`` drops.
The frame carries them; the engine reads them straight off each event.

New-token detection heuristic (:class:`MintTracker`) — stated with its limits, not oversold:

* A mint is treated as a **fresh bonding-curve token** the first time we see it *and* that first swap is
  on the ``pumpfun`` bonding curve (``protocol == "pumpfun"``). On the bonding curve a token is
  **pre-migration by definition** — that is the honest, load-bearing signal, independent of the token's
  true age.
* A mint whose FIRST observed swap is already on an AMM (``pumpfun_amm`` / raydium / meteora / orca /
  jupiter router / …) is classified **not-fresh / unknown-age** and is NOT captured: it either already
  migrated or we simply connected mid-life and missed its bonding window.
* **Limit we cannot engineer away:** connecting mid-life means a mint's true first-ever swap may predate
  our socket. So "fresh" means *"observed pre-migration on the bonding curve"*, NOT *"launched this
  second"*. We never claim to know a mint's birth; a token seen only on the bonding curve is somewhere
  in its pre-migration window, but WHERE (minute 1 vs minute 30) is unknown.
* Once a mint is tracked, ALL its later swaps are captured — including the first AMM swap
  (:attr:`MintPhase.MIGRATION`) and everything after — so a token's bonding window is recorded through
  to and including migration when it happens during the session.

Amount scaling. A WS event carries only RAW base-unit ``input_amount``/``output_amount`` (strings) and
NO decimals, but :class:`~oct_trading_agent.data.dataset.MarketSwapDataset` stores UI-unit values. The
quote leg is WSOL (9 decimals, known). The base leg's decimals are supplied via
:attr:`LiveCaptureConfig.base_decimals`, **default 6** — pump.fun mints the bonding-curve token with 6
decimals by protocol, so 6 is right for the ``pumpfun`` corpus this service exists to build. A token
that is not 6-decimal would have its stored ``base`` mis-scaled by a power of ten (price off by 10^k),
but internally consistent per token; override ``--base-decimals`` if tailing a non-pumpfun venue.

Dedup limit. A WS event carries no ``transaction_index`` / ``instruction_index`` (those are REST-only),
so both default to ``0`` and the dataset dedups on the tx ``signature`` alone. Two swap instructions
sharing one signature would collapse to one stored row — negligible for single-swap pump.fun buys/sells,
noted for honesty.

The engine (:class:`LiveCaptureEngine`) is a pure, synchronous state machine driven one frame at a time,
so it is unit-tested with synthetic frames and never opens a socket. :func:`run_capture` is the thin
async wrapper that drives it from the live firehose with the bound/stop conditions; ``main`` is the CLI.
"""

from __future__ import annotations

import argparse
import asyncio
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from enum import StrEnum
from pathlib import Path
from typing import Any

from oct_trading_agent.data.dataset import MarketSwapDataset
from oct_trading_agent.data.pinax_client.decode import WSOL, WSOL_DECIMALS
from oct_trading_agent.data.pinax_client.ws import DEFAULT_WS_STREAM, PinaxWebSocketClient

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

# The pump.fun PRE-migration bonding-curve venue tag — the one venue on which a token is, by definition,
# not yet migrated. Kept in sync with the sim curve registry and agent/train_data.py.
BONDING_PROTOCOL = "pumpfun"


class MintPhase(StrEnum):
    """How :class:`MintTracker` classifies one observed swap on a mint."""

    NEW_FRESH = "new_fresh"  # first-ever sight, ON the bonding curve -> start tracking (capture)
    NOT_FRESH = "not_fresh"  # first-ever sight, already on an AMM -> unknown-age, do NOT capture
    TRACKED = "tracked"  # known fresh mint, still on the bonding curve (capture)
    MIGRATION = "migration"  # known fresh mint's FIRST non-bonding swap (capture + record)
    POST_MIGRATION = "post_migration"  # known fresh mint, already migrated (capture)
    SKIP = "skip"  # known not-fresh mint -> ignore


# The phases whose swaps we persist. NOT_FRESH / SKIP are dropped (they are not pre-migration corpus).
_CAPTURE_PHASES: frozenset[MintPhase] = frozenset(
    {MintPhase.NEW_FRESH, MintPhase.TRACKED, MintPhase.MIGRATION, MintPhase.POST_MIGRATION}
)


@dataclass
class _MintState:
    tracked: bool
    migrated: bool
    first_protocol: str


class MintTracker:
    """Per-mint state machine that flags a newly-seen mint as a fresh bonding-curve token.

    Honest by construction: a mint is fresh only if the FIRST swap we observe for it is on the
    ``pumpfun`` bonding curve. See the module docstring for what "fresh" does and does not claim.
    """

    def __init__(self, *, bonding_protocol: str = BONDING_PROTOCOL) -> None:
        self._bonding = bonding_protocol
        self._states: dict[str, _MintState] = {}
        self.fresh_mints: set[str] = set()
        self.migrated_mints: set[str] = set()

    def observe(self, mint: str, protocol: str) -> MintPhase:
        """Record one swap ``(mint, protocol)`` and return its :class:`MintPhase`."""
        state = self._states.get(mint)
        if state is None:
            fresh = protocol == self._bonding
            self._states[mint] = _MintState(
                tracked=fresh, migrated=False, first_protocol=protocol
            )
            if fresh:
                self.fresh_mints.add(mint)
                return MintPhase.NEW_FRESH
            return MintPhase.NOT_FRESH
        if not state.tracked:
            return MintPhase.SKIP
        if protocol == self._bonding:
            return MintPhase.TRACKED
        # A tracked (fresh) mint trading off the bonding curve for the first time = migration.
        if not state.migrated:
            state.migrated = True
            self.migrated_mints.add(mint)
            return MintPhase.MIGRATION
        return MintPhase.POST_MIGRATION

    def is_tracked(self, mint: str) -> bool:
        state = self._states.get(mint)
        return state is not None and state.tracked


def _scale_amount(amount: object, decimals: int) -> Decimal | None:
    """Scale a raw base-unit amount (str/int) to UI units by ``10**decimals``; ``None`` if unusable."""
    if isinstance(amount, bool) or amount is None:
        return None
    if not isinstance(amount, (int, str)):
        return None
    try:
        raw = Decimal(str(amount))
    except (InvalidOperation, ValueError):
        return None
    if raw < 0:
        return None
    return raw / (Decimal(10) ** decimals)


def ws_event_to_raw_row(
    event: Mapping[str, Any],
    *,
    block_num: int,
    timestamp: int,
    base_decimals: int,
    quote_mint: str = WSOL,
    quote_decimals: int = WSOL_DECIMALS,
) -> dict[str, Any] | None:
    """Project one live-WS ``solana@swaps`` event onto a raw :data:`RAW_ROW_SCHEMA` dataset row.

    Scales the raw base-unit amounts to UI ``input_value``/``output_value`` (quote leg by
    ``quote_decimals``, tracked leg by ``base_decimals``) and carries ``protocol`` + ``amm_pool``
    through. Returns ``None`` for a non-``quote_mint`` pair or unscalable amounts. The dataset's
    :func:`normalise_raw_row` is the final admissibility gate (positivity, signer, WSOL leg).
    """
    in_mint = event.get("input_mint")
    out_mint = event.get("output_mint")
    if not (isinstance(in_mint, str) and isinstance(out_mint, str)):
        return None
    if in_mint == quote_mint and out_mint != quote_mint:
        in_dec, out_dec = quote_decimals, base_decimals
    elif out_mint == quote_mint and in_mint != quote_mint:
        in_dec, out_dec = base_decimals, quote_decimals
    else:
        return None  # token->token route or degenerate self-pair
    in_val = _scale_amount(event.get("input_amount"), in_dec)
    out_val = _scale_amount(event.get("output_amount"), out_dec)
    if in_val is None or out_val is None:
        return None
    return {
        "amm_pool": event.get("amm_pool"),
        "protocol": event.get("protocol"),
        "signature": event.get("signature"),
        # Signer keys passed through verbatim; normalise_raw_row resolves signer/signers/user/fee_payer.
        "signer": event.get("signer"),
        "signers": event.get("signers"),
        "user": event.get("user"),
        "fee_payer": event.get("fee_payer"),
        "block_num": block_num,
        "timestamp": timestamp,
        "transaction_index": 0,  # WS carries neither index; dataset dedups on signature (see docstring)
        "instruction_index": 0,
        "input_mint": in_mint,
        "output_mint": out_mint,
        "input_value": float(in_val),
        "output_value": float(out_val),
    }


@dataclass(frozen=True)
class LiveCaptureConfig:
    """Tunables + stop conditions for a capture run."""

    base_decimals: int = 6  # pump.fun mints are 6-decimal by protocol (see module docstring)
    quote_mint: str = WSOL
    quote_decimals: int = WSOL_DECIMALS
    flush_every: int = 200  # rows buffered before an idempotent dataset append
    max_tokens: int | None = None  # stop after this many DISTINCT fresh tokens discovered
    max_swaps: int | None = None  # stop after this many swaps captured
    bonding_protocol: str = BONDING_PROTOCOL


@dataclass
class CaptureStats:
    """Running counters for a capture session (safe to print — no credentials)."""

    frames_seen: int = 0
    events_seen: int = 0
    fresh_tokens: int = 0
    swaps_captured: int = 0
    rows_written: int = 0  # NEW rows after the dataset's identity dedup (<= swaps_captured on re-runs)
    migrations: int = 0

    def render(self) -> str:
        return (
            f"frames={self.frames_seen} events={self.events_seen} "
            f"fresh_tokens={self.fresh_tokens} swaps_captured={self.swaps_captured} "
            f"rows_written={self.rows_written} migrations={self.migrations}"
        )


class LiveCaptureEngine:
    """Pure, synchronous capture core: feed it frames, it discovers tokens and buffers dataset rows.

    Buffering keeps the dataset append batched (append reads+writes a pool's Parquet each call), and is
    flushed on :meth:`flush` — called on the ``flush_every`` threshold, at end-of-run, and on shutdown.
    """

    def __init__(
        self, dataset: MarketSwapDataset, config: LiveCaptureConfig | None = None
    ) -> None:
        self._dataset = dataset
        self._config = config or LiveCaptureConfig()
        self._tracker = MintTracker(bonding_protocol=self._config.bonding_protocol)
        self._buffer: list[dict[str, Any]] = []
        self.stats = CaptureStats()

    @property
    def tracker(self) -> MintTracker:
        return self._tracker

    @property
    def pending(self) -> int:
        return len(self._buffer)

    def ingest_frame(self, frame: Mapping[str, Any]) -> None:
        """Process one live block frame: classify each WSOL-pair event and buffer captured rows."""
        events = frame.get("events")
        if not isinstance(events, list):
            return  # session/control frame or malformed
        block_num = frame.get("block_num")
        ts = frame.get("timestamp_seconds")
        if not isinstance(block_num, int) or not isinstance(ts, (int, float)):
            return
        self.stats.frames_seen += 1
        for event in events:
            if isinstance(event, Mapping):
                self.stats.events_seen += 1
                self._ingest_event(event, block_num=block_num, timestamp=int(ts))

    def _ingest_event(
        self, event: Mapping[str, Any], *, block_num: int, timestamp: int
    ) -> None:
        quote = self._config.quote_mint
        in_mint = event.get("input_mint")
        out_mint = event.get("output_mint")
        if in_mint == quote and isinstance(out_mint, str):
            mint = out_mint
        elif out_mint == quote and isinstance(in_mint, str):
            mint = in_mint
        else:
            return  # not a quote pair — token->token route
        protocol = event.get("protocol")
        if not isinstance(protocol, str) or not protocol:
            return

        phase = self._tracker.observe(mint, protocol)
        if phase is MintPhase.NEW_FRESH:
            self.stats.fresh_tokens += 1
        elif phase is MintPhase.MIGRATION:
            self.stats.migrations += 1
        if phase not in _CAPTURE_PHASES:
            return

        row = ws_event_to_raw_row(
            event,
            block_num=block_num,
            timestamp=timestamp,
            base_decimals=self._config.base_decimals,
            quote_mint=quote,
            quote_decimals=self._config.quote_decimals,
        )
        if row is None:
            return
        self._buffer.append(row)
        self.stats.swaps_captured += 1
        if len(self._buffer) >= self._config.flush_every:
            self.flush()

    def flush(self) -> int:
        """Append the buffer to the dataset (idempotent) and clear it. Returns NEW-row count."""
        if not self._buffer:
            return 0
        gained = self._dataset.append_rows(self._buffer)
        self.stats.rows_written += gained
        self._buffer.clear()
        return gained

    def should_stop(self) -> bool:
        """True once a count-based stop condition (max_tokens / max_swaps) is met."""
        cfg = self._config
        if cfg.max_tokens is not None and self.stats.fresh_tokens >= cfg.max_tokens:
            return True
        return cfg.max_swaps is not None and self.stats.swaps_captured >= cfg.max_swaps


async def run_capture(
    engine: LiveCaptureEngine,
    client: PinaxWebSocketClient,
    *,
    max_minutes: float | None = None,
    on_progress: Callable[[CaptureStats], None] | None = None,
) -> CaptureStats:  # pragma: no cover - live socket loop, exercised via the bounded manual run
    """Drive ``engine`` from ``client``'s live frame tail until a bound is hit; always flushes on exit.

    Stops on the engine's count conditions (``max_tokens`` / ``max_swaps``), on ``max_minutes`` wall
    clock, or on cancellation (SIGINT). The ``finally`` flush guarantees partial state is persisted on
    every exit path, including Ctrl-C. Never logs the credential or the connect URL.
    """

    async def _pump() -> None:
        async for frame in client.stream_frames():
            engine.ingest_frame(frame)
            if on_progress is not None:
                on_progress(engine.stats)
            if engine.should_stop():
                break

    try:
        if max_minutes is not None:
            try:
                async with asyncio.timeout(max_minutes * 60):
                    await _pump()
            except TimeoutError:
                pass
        else:
            await _pump()
    finally:
        engine.flush()
    return engine.stats


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Live-capture fresh pump.fun bonding-curve tokens' swaps into a MarketSwapDataset.",
    )
    parser.add_argument("--dataset", required=True, help="MarketSwapDataset root dir (append/resume)")
    parser.add_argument("--max-tokens", type=int, default=None, help="stop after N distinct fresh tokens")
    parser.add_argument("--max-minutes", type=float, default=None, help="stop after this many minutes")
    parser.add_argument("--max-swaps", type=int, default=None, help="stop after N swaps captured")
    parser.add_argument("--base-decimals", type=int, default=6, help="tracked-token decimals (pumpfun=6)")
    parser.add_argument("--flush-every", type=int, default=200, help="rows buffered before a flush")
    parser.add_argument("--stream", default=DEFAULT_WS_STREAM, help="Pinax <network>@<table> stream")
    parser.add_argument("--progress-every", type=int, default=50, help="print a progress line every N frames")
    return parser


def main(argv: list[str] | None = None) -> int:  # pragma: no cover - CLI wiring / live network
    args = _build_arg_parser().parse_args(argv)
    if args.max_tokens is None and args.max_minutes is None and args.max_swaps is None:
        print("[capture] refusing to run unbounded — pass --max-tokens / --max-minutes / --max-swaps")
        return 2

    dataset = MarketSwapDataset(Path(args.dataset))
    config = LiveCaptureConfig(
        base_decimals=args.base_decimals,
        flush_every=args.flush_every,
        max_tokens=args.max_tokens,
        max_swaps=args.max_swaps,
    )
    engine = LiveCaptureEngine(dataset, config)
    client = PinaxWebSocketClient(stream=args.stream)

    interval = max(1, args.progress_every)

    def _progress(stats: CaptureStats) -> None:
        if stats.frames_seen % interval == 0:
            print(f"[capture] {stats.render()}", flush=True)

    bounds = [
        f"max_tokens={args.max_tokens}" if args.max_tokens is not None else None,
        f"max_minutes={args.max_minutes}" if args.max_minutes is not None else None,
        f"max_swaps={args.max_swaps}" if args.max_swaps is not None else None,
    ]
    print(
        f"[capture] connecting to Pinax {args.stream} firehose "
        f"(bounds: {', '.join(b for b in bounds if b)}) ...",
        flush=True,
    )

    try:
        asyncio.run(run_capture(engine, client, max_minutes=args.max_minutes, on_progress=_progress))
    except KeyboardInterrupt:
        # run_capture's finally already flushed the buffer before the interrupt propagated.
        print("\n[capture] interrupted — partial state flushed.", flush=True)
    except RuntimeError as exc:
        # Missing 'ws' extra, or missing/expired PINAX_API_TOKEN. The message never carries the token.
        print(f"[capture] could not start live capture: {exc}", flush=True)
        return 1

    manifest = dataset.load_manifest()
    print("\n" + "=" * 88)
    print(f"[capture] DONE — {engine.stats.render()}")
    print(
        f"[capture] dataset now: {manifest.n_pools} pools, {manifest.total_rows} rows, "
        f"protocols={manifest.protocols}"
    )
    fresh = sorted(engine.tracker.fresh_mints)
    print(f"[capture] fresh bonding-curve mints discovered: {len(fresh)}")
    if engine.tracker.migrated_mints:
        print(f"[capture] migrated mid-capture: {len(engine.tracker.migrated_mints)}")
    print("=" * 88)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
