"""traces — the trade-replay data layer for the replay browser (agents AND real wallets).

The operator's ask: browse EVERY actor — each archive champion and each harvested census wallet —
and watch exactly what it did on a token's chart, trade by trade. That is potentially hundreds of
thousands of (actor, token) pairs over time, so pre-rendering one JSON per pair does not scale.
The layer is therefore three tiers, biggest substrate first:

1. **Trade-log substrate** (:mod:`.log`) — one compact, append-friendly parquet row per TRADE
   (never per hold): agent fills recorded live by :mod:`.record` during champion re-evals, and the
   census cohorts' real swaps derived straight from the captured dataset by :mod:`.wallets`. Each
   producing run writes its own segment file, so future training/eval runs append by importing
   :class:`~.log.TradeLogStore` — no trainer is ever modified. An actors index parquet
   (actor → kind, group, tokens touched, trades, realized PnL) is the browsing manifest.
2. **On-demand trace builder** (:mod:`.build`) — a pure function + CLI
   ``build_trace(actor_id, mint)`` that assembles one replay trace JSON at request time from the
   trade log plus the token's own market tape (price series from its busiest pool, downsampled to
   ≤500 points, honestly labeled). This is what a local replay-browser server calls per click.
3. **Curated JSON showcase** (:mod:`.agents` / :mod:`.wallets` ``--curated``) — a BOUNDED
   per-(actor, token) export of the same trace schema, for the self-contained viz artifact.

The trace JSON contract lives in :mod:`.schema` (documented in ``replay-trace-schema.md``) and is
shared verbatim by tiers 2 and 3. Everything except the torch-gated champion re-eval
(:mod:`.agents`) runs on the lean install.
"""

from .schema import (
    DOWNSAMPLE_METHOD,
    TRACE_SCHEMA_VERSION,
    PricePoint,
    PriceSeries,
    ReplayTrace,
    TraceStep,
    TradeRow,
    downsample_price,
    trace_from_json,
    trace_to_json,
)

__all__ = [
    "DOWNSAMPLE_METHOD",
    "TRACE_SCHEMA_VERSION",
    "PricePoint",
    "PriceSeries",
    "ReplayTrace",
    "TraceStep",
    "TradeRow",
    "downsample_price",
    "trace_from_json",
    "trace_to_json",
]
