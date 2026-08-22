"""data/ — ingest → append-only, replayable tape log (02 §2 "Data pipeline").

This is the **first** layer of the leakage firewall (``data → featurestore → sim → agent →
eval``). Its single job is to turn raw on-chain sources into the timestamped, causal
``core.tape`` events and persist them to a durable, **replayable append-only log** — and nothing
else. **Features are NEVER computed here** (src/README.md hard rule): the data layer stays
feature-free so causality is auditable at exactly one boundary, the feature store.

Subpackages
-----------
* :mod:`~oct_trading_agent.data.pinax_client` — the Pinax new-pair firehose client. A polite,
  disk-cached, throttled REST client (primary path for historical backfill) that decodes rows
  into :mod:`oct_trading_agent.core.tape` events, plus an optional Substreams gRPC path behind
  the ``firehose`` extra. Mirrors the proven JS reference client (config.py docstring).
* :mod:`~oct_trading_agent.data.log` — the append-only, columnar (Parquet/polars),
  time-partitioned tape log: idempotent on tx ``signature``, ordered by ``slot``, and a reader
  that replays a ``(token, time-range)`` slice back as ``TapeEvent``\\ s in slot order.
* :mod:`~oct_trading_agent.data.labeling` — the trader-labeling pipeline: reconstruct a
  labeled wallet's **full** win-and-loss history into demonstration trajectories (Phase-1
  imitation input). Built against a documented FIXTURE schema; the real labeled-wallet DB is a
  Phase-1 dependency, wired by swapping the fixture loader (03 §Phase 0).
* :mod:`~oct_trading_agent.data.connectors` — the source-agnostic ``TapeSource`` seam every
  ingest path implements, plus notes on the Phase-D/E social/chatter connectors (not built in
  Phase 0).

Live backfill is **gated on ``PINAX_API_KEY``** being set (``backend/.env`` or process env; see
:mod:`oct_trading_agent.config`). Every module in this package is unit-tested **entirely against
fixtures** — no test touches the network.
"""

from __future__ import annotations

from .connectors import TapeSource
from .labeling import (
    DemonstrationStep,
    DemonstrationTrajectory,
    LabeledTrade,
    LabeledWallet,
    build_trajectories,
    load_labeled_wallets,
)
from .log import TapeLogReader, TapeLogWriter
from .pinax_client import (
    PinaxRestClient,
    backfill_swaps,
    decode_swap_row,
)

__all__ = [
    # connectors
    "TapeSource",
    # pinax_client
    "PinaxRestClient",
    "decode_swap_row",
    "backfill_swaps",
    # log
    "TapeLogWriter",
    "TapeLogReader",
    # labeling
    "LabeledWallet",
    "LabeledTrade",
    "DemonstrationStep",
    "DemonstrationTrajectory",
    "load_labeled_wallets",
    "build_trajectories",
]
