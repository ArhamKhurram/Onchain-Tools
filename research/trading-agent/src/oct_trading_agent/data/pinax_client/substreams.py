"""Optional Substreams gRPC path for the Pinax firehose (behind the ``firehose`` extra).

**REST is the primary path** for historical backfill and the live WS stream is the primary live
tail (see :mod:`.rest` / :mod:`.ws`). Substreams is a third, heavier option kept behind the
optional ``firehose`` extra (``grpcio``/``protobuf``) for a future high-throughput firehose; it is
**not required for the Phase-0 gate**, which the REST tape satisfies on its own (03 §Phase 0).

Proven facts (config.py, verified against the working JS client):

* Endpoint: ``solana.substreams.pinax.network:443``.
* Auth: bearer = the **raw** ``PINAX_API_KEY`` (NOT the WS JWT, and NOT an account JWT — Substreams
  rejects the JWT with "invalid api key", verified 2026-08-04).
* Package: ``dex-swaps-v0.5.2.spkg`` (pinax-network/substreams-svm) — same ``swaps`` data as REST
  ``/v1/svm/swaps``, so its rows decode with the same field mapping as the REST decoder.

This module intentionally ships as a documented capability check plus a guarded entry point rather
than a full generated-protobuf client: wiring the substreams protocol is a sizeable task with no
Phase-0 payoff over REST+WS, so it is deferred. :func:`substreams_available` lets callers branch,
and :func:`stream_substreams_swaps` raises a clear, actionable error until the path is implemented.
"""

from __future__ import annotations

from oct_trading_agent.config import (
    PINAX_SUBSTREAMS_ENDPOINT,
    PINAX_SWAPS_SPKG,
)


def substreams_available() -> bool:
    """True iff the ``firehose`` extra (``grpcio``) is importable in this environment."""
    try:
        import grpc  # noqa: F401
    except ModuleNotFoundError:
        return False
    return True


def stream_substreams_swaps() -> None:
    """Entry point for the Substreams swap firehose. **Deferred** — see the module docstring.

    Raises ``NotImplementedError`` with the endpoint/package/bearer facts already resolved, so
    picking this up later is a matter of wiring the substreams protobuf client, not rediscovery.
    """
    if not substreams_available():
        raise RuntimeError(
            "Substreams path requires the 'firehose' extra: pip install 'oct-trading-agent[firehose]'"
        )
    raise NotImplementedError(
        "Substreams gRPC path is deferred (REST backfill + WS tail are the Phase-0 paths). "
        f"Endpoint={PINAX_SUBSTREAMS_ENDPOINT}, package={PINAX_SWAPS_SPKG}, "
        "bearer=raw PINAX_API_KEY. Decode rows with decode_swap_row (same schema as REST /v1/svm/swaps)."
    )


__all__ = ["substreams_available", "stream_substreams_swaps"]
