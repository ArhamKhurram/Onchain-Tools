"""Tape events — the append-only firehose contract (02 §2 "Data pipeline").

These types are the raw, timestamped, causal record the Pinax new-pair firehose produces
(swaps, liquidity events, holder changes, rug/honeypot markers). They are the ONLY input
the feature store is allowed to read; features are never computed here (02 §6 rationale —
the data layer stays feature-free so causality is auditable at one boundary).

Design rules encoded in the types:

* **Timestamps are explicit and dual.** Solana's ordering primitive is the *slot*; wall-clock
  time is derived. We carry both — ``slot`` for deterministic ordering/replay, ``block_time``
  for human-facing windows — and never conflate them.
* **Impact/reserve fields are optional.** Reserves before/after a swap are frequently
  unavailable from a decoded swap stream; the simulator's AMM reconstruction (``sim/amm``)
  fills the gap. A ``None`` here means "not carried by this event", never "zero".
* **Amounts are strings-or-Decimal-safe.** On-chain amounts are large integers in base units;
  we model them as non-negative ``Decimal`` to avoid float drift, with ``*_decimals`` for scaling.

Wave-1 (data agent) owns turning decoded Substreams / REST rows into these; the field set here
is the contract that pipeline must satisfy.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import Field

from .base import Frozen
from .enums import Side

# A Solana mint address (base58). Kept as a plain str alias for now; validation is a
# Wave-1 concern (a regex/length check belongs with the ingest, not the contract shape).
Mint = str
Wallet = str

NonNegDecimal = Annotated[Decimal, Field(ge=0)]


class _TapeEventBase(Frozen):
    """Fields common to every tape event.

    ``slot`` is the canonical ordering key for replay; ``block_time`` is the derived
    wall-clock instant. ``signature`` (the tx signature) is optional but is the natural
    idempotency key for de-duping the append-only log.
    """

    mint: Mint
    slot: int = Field(ge=0, description="Solana slot — canonical ordering key for replay.")
    block_time: datetime = Field(description="Wall-clock instant derived from the slot.")
    signature: str | None = Field(
        default=None, description="Transaction signature; idempotency key for the log."
    )


class SwapEvent(_TapeEventBase):
    """A single executed swap against the token's pool.

    ``side`` is from the trader's perspective on the tracked token (BUY = acquiring it).
    ``base`` is the tracked token; ``quote`` is the paired asset (typically SOL/WSOL).
    Reserves before/after are the AMM pool state around the swap — OPTIONAL, because a
    decoded swap stream often omits them; ``sim/amm`` reconstructs them when absent.
    """

    kind: Literal["swap"] = "swap"

    signer: Wallet = Field(description="The wallet that signed the swap.")
    side: Side

    base_amount: NonNegDecimal = Field(description="Tracked-token amount moved (UI units).")
    quote_amount: NonNegDecimal = Field(description="Quote/SOL amount moved (UI units).")
    price: NonNegDecimal | None = Field(
        default=None, description="Execution price in quote per base; None if not carried."
    )

    # The venue the swap executed on — Pinax's ``protocol`` tag (``pumpfun_amm``, ``pumpfun``,
    # ``raydium_clmm``, ``orca_whirlpool``, …). OPTIONAL: a decoded swap stream may omit it, and a
    # ``None`` means "not carried", never "unknown venue". The simulator's venue→curve resolver
    # (``sim/curves``) dispatches on this to pick the right fill model; when it is absent the caller
    # must supply the venue out-of-band. Kept as a free string alias (not an enum) so a
    # newly-listed venue in the firehose never fails validation — the resolver decides support.
    protocol: str | None = Field(
        default=None, description="Execution venue (Pinax `protocol` tag); None if not carried."
    )

    base_reserve_before: NonNegDecimal | None = None
    quote_reserve_before: NonNegDecimal | None = None
    base_reserve_after: NonNegDecimal | None = None
    quote_reserve_after: NonNegDecimal | None = None


class LiquidityEvent(_TapeEventBase):
    """A liquidity add or remove on the pool.

    Liquidity removal by the creator is an early rug-flow signature (paper §3.2, Tier C);
    the feature store, not this layer, derives that signal.
    """

    kind: Literal["liquidity"] = "liquidity"

    action: Literal["add", "remove"]
    provider: Wallet | None = None
    base_amount: NonNegDecimal
    quote_amount: NonNegDecimal
    base_reserve_after: NonNegDecimal | None = None
    quote_reserve_after: NonNegDecimal | None = None


class HolderChange(_TapeEventBase):
    """A change in the holder set / holder count for the token.

    Deltas rather than absolute snapshots so the append-only log stays causal: a consumer
    reconstructs the holder count as-of any instant by summing deltas up to that slot.
    ``top_holder_share`` is optional (concentration is expensive to compute inline).
    """

    kind: Literal["holder"] = "holder"

    holder_count_delta: int = Field(description="Net change in holder count at this slot.")
    wallet: Wallet | None = Field(default=None, description="Wallet whose balance crossed zero.")
    top_holder_share: float | None = Field(
        default=None, ge=0.0, le=1.0, description="Top-holder share if carried; else None."
    )


class RugEvent(_TapeEventBase):
    """Absorbing-state marker: the token entered a terminal zero/honeypot state.

    Rugs/honeypots are **absorbing zero states** and avoidance is a first-class learned
    objective (02 §2, paper §6.2). Once a RugEvent is seen for a mint, no later swap on that
    mint is tradeable in the sim — the simulator treats it as terminal.
    """

    kind: Literal["rug"] = "rug"

    rug_kind: Literal["liquidity_pull", "honeypot", "mint_dump", "freeze", "other"] = "other"
    detail: str | None = None


# Discriminated union over the whole firehose. Downstream code accepts ``TapeEvent`` and
# narrows on ``.kind``; pydantic validates the right variant by the ``kind`` tag.
TapeEvent = Annotated[
    SwapEvent | LiquidityEvent | HolderChange | RugEvent,
    Field(discriminator="kind"),
]
