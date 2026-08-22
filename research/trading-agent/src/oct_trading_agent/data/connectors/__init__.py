"""connectors/ — the source-agnostic ingest seam.

Every ingest path (Pinax REST backfill, Pinax Substreams gRPC firehose, and — in Phase D/E —
social/chatter connectors) produces the *same* thing: an ordered stream of
:data:`oct_trading_agent.core.tape.TapeEvent`\\ s for a ``(mint, time-range)``. :class:`TapeSource`
is that one interface, so the append-only log (:mod:`oct_trading_agent.data.log`) and the backfill
driver never care which source produced an event.

Phase-0 scope: the on-chain firehose only (:mod:`oct_trading_agent.data.pinax_client` implements
:class:`TapeSource`). The Phase-D social/narrative connectors and the Phase-E Discord/TG chatter
connectors (04-data-spec.md §1.4–1.5) are **not built here yet** — they are untrusted external
content and must be ingested as sandboxed *data, never instructions* (paper §9.7). They will land
as additional :class:`TapeSource` implementations without changing the log or feature-store
contracts.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime
from typing import Protocol, runtime_checkable

from oct_trading_agent.core import Mint, TapeEvent


@runtime_checkable
class TapeSource(Protocol):
    """A source of raw tape events for a token over a time window.

    Implementations MUST yield events that decode into :data:`~oct_trading_agent.core.tape.TapeEvent`
    and MUST NOT compute any feature (the leakage firewall — src/README.md). Ordering is by
    ``slot`` where the source can guarantee it; the append-only log re-sorts on read regardless,
    so a source that can only page newest-first (as the Pinax REST API does) is still correct.
    """

    def stream_events(
        self, mint: Mint, start: datetime, end: datetime
    ) -> Iterator[TapeEvent]:
        """Yield every tape event for ``mint`` with ``start <= block_time < end``."""
        ...


__all__ = ["TapeSource"]
