"""Load a REAL pump.fun bonding-curve token's swap tape for the end-to-end proof (bounded).

Two sources, one output (:class:`TokenTape`):

* **Offline fixture** (:func:`load_bonding_curve_fixture`) — the repo's captured
  ``tests/fixtures/pumpfun_bonding_curve_swaps.json``: REAL pump.fun pre-migration swaps for ONE
  token, in causal order from its creation, pulled from Pinax ``/v1/svm/swaps`` in a single 500-row
  page. Deterministic and network-free, so the proof and CI reproduce exactly. Slots/timestamps are
  synthesized in causal order (the fixture carries side + amounts only); the *amounts* are the real
  captured curve-level values.

* **Live REST** (:func:`load_live_bonding_curve_tape`) — a bounded pull from Pinax (ONE token, ONE
  page, ``limit <= 500``, ``User-Agent`` + key from ``backend/.env`` via the repo's
  :class:`~oct_trading_agent.data.pinax_client.PinaxRestClient`). Gated on ``PINAX_API_KEY``; used by
  the proof runner when ``--live`` is requested, falling back to the fixture otherwise. Deliberately
  small — the PR is the primary deliverable, not open-ended data collection.

Both yield :class:`~oct_trading_agent.core.tape.SwapEvent`\\ s; the caller seeds the pump.fun virtual
reserves with :func:`~oct_trading_agent.agent.envs.prepare_bonding_curve_tape` before building the env.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

from oct_trading_agent.core import Mint, Side, SwapEvent

# The captured fixture pool (a real pump.fun bonding-curve token). Used as the opaque token id when
# loading offline (the fixture carries the pool, not the mint; the sim/featurestore treat it as an
# opaque key, so this is a faithful stand-in for the proof).
_FIXTURE_POOL_FALLBACK = "EHu5dVU4Jei9TwxN4bqe85AMs6XnViNxihEKi25jGV6w"
_FIXTURE_T0 = datetime(2026, 8, 22, 0, 0, 0, tzinfo=UTC)
WSOL = "So11111111111111111111111111111111111111112"


@dataclass(frozen=True)
class TokenTape:
    """One token's swap tape plus a human-readable source label for the proof report."""

    mint: Mint
    swaps: list[SwapEvent]
    source: str

    @property
    def n_swaps(self) -> int:
        return len(self.swaps)


def _fixture_path() -> Path:
    return (
        Path(__file__).resolve().parents[3]
        / "tests"
        / "fixtures"
        / "pumpfun_bonding_curve_swaps.json"
    )


def load_bonding_curve_fixture(path: Path | None = None) -> TokenTape:
    """Load the captured real bonding-curve swaps as a :class:`TokenTape` (offline, deterministic).

    Synthesizes a strictly-increasing slot and a 1-second-spaced ``block_time`` per swap (causal
    order is what the fixture guarantees); amounts are the real captured curve-level values. BUY:
    ``amount_in`` = SOL in (quote), ``observed_out`` = token out (base). SELL: ``amount_in`` = token
    in (base), ``observed_out`` = SOL out (quote).
    """
    fixture = json.loads((path or _fixture_path()).read_text(encoding="utf-8"))
    mint = str(fixture.get("pool") or _FIXTURE_POOL_FALLBACK)
    swaps: list[SwapEvent] = []
    for i, row in enumerate(fixture.get("swaps", [])):
        side = Side.BUY if str(row.get("side")) == "buy" else Side.SELL
        amount_in = Decimal(str(row["amount_in"]))
        observed_out = Decimal(str(row["observed_out"]))
        if side is Side.BUY:
            quote_amount, base_amount = amount_in, observed_out
        else:
            base_amount, quote_amount = amount_in, observed_out
        if base_amount <= 0 or quote_amount <= 0:
            continue
        swaps.append(
            SwapEvent(
                mint=mint,
                slot=1000 + i,
                block_time=_FIXTURE_T0 + timedelta(seconds=i),
                signature=f"fixture-{i}",
                signer=f"fixture-signer-{i % 32}",
                side=side,
                base_amount=base_amount,
                quote_amount=quote_amount,
                price=quote_amount / base_amount,
                protocol="pumpfun",
            )
        )
    return TokenTape(mint=mint, swaps=swaps, source=f"fixture:{_fixture_path().name}")


def load_live_bonding_curve_tape(
    *,
    amm_pool: str = _FIXTURE_POOL_FALLBACK,
    network: str = "solana",
    max_rows: int = 500,
    cache_dir: Path | None = None,
) -> TokenTape:
    """Bounded LIVE pull of one pump.fun token's swaps via Pinax REST (ONE page, ``limit <= 500``).

    Queries by ``amm_pool`` (returns both legs), infers the tracked mint as the non-WSOL leg of the
    first decodable row, and decodes to :class:`SwapEvent`\\ s. Requires ``PINAX_API_KEY`` (raises
    otherwise). Deliberately one page — small and bounded.
    """
    from oct_trading_agent.data.pinax_client.decode import decode_swap_row
    from oct_trading_agent.data.pinax_client.rest import PinaxRestClient

    limit = max(1, min(500, max_rows))
    client = PinaxRestClient(cache_dir=cache_dir)
    payload = client.get_swaps(network=network, amm_pool=amm_pool, limit=limit, page=1)
    rows = [r for r in (payload.get("data") or []) if isinstance(r, dict)]

    # Infer the tracked mint: the non-WSOL leg of the first row that has one.
    tracked: str | None = None
    for row in rows:
        for leg in (row.get("input_mint"), row.get("output_mint")):
            if isinstance(leg, str) and leg and leg != WSOL:
                tracked = leg
                break
        if tracked is not None:
            break
    if tracked is None:
        raise RuntimeError("no non-WSOL leg found in the live page; cannot identify the token")

    swaps: list[SwapEvent] = []
    for row in rows:
        event = decode_swap_row(row, tracked, quote_mint=WSOL)
        if event is not None:
            swaps.append(event.model_copy(update={"protocol": "pumpfun"}))
    swaps.sort(key=lambda s: (s.slot, s.block_time))
    return TokenTape(
        mint=tracked, swaps=swaps, source=f"live:pinax/{network}/pool={amm_pool[:8]}..."
    )


__all__ = [
    "TokenTape",
    "load_bonding_curve_fixture",
    "load_live_bonding_curve_tape",
]
