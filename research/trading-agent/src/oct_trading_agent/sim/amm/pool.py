"""Pool-state reconstruction — carry/rebuild constant-product reserves as-of any slot.

The tape (``core.tape``) carries reserves only *sometimes* (``SwapEvent.*_reserve_*``,
``LiquidityEvent.*_reserve_after``). When present they are ground truth; when absent the reserves
are reconstructed by **folding the amount deltas** of prior events onto an absolute anchor:

* A swap ``BUY`` removes base and adds quote (trader acquires base): ``R_b -= base``, ``R_q += quote``.
* A swap ``SELL`` adds base and removes quote: ``R_b += base``, ``R_q -= quote``.
* A liquidity ``add`` / ``remove`` adjusts both sides by its amounts.
* Any event that *carries* reserves **snaps** the running state to them (ground-truth correction).

A single swap in isolation is under-determined (the same in/out is consistent with any pool depth),
so absolute reserves need an **anchor**: the first event that carries reserves, or the pool-creation
liquidity ``add``. A new-pair firehose sees that creation event, so an anchor normally exists. Until
one does, the state is ``anchored=False`` and the fill model must refuse to trade (explicit
missingness — never invent a depth), consistent with the repo's no-imputation rule.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from oct_trading_agent.core import (
    LiquidityEvent,
    Mint,
    Side,
    SwapEvent,
    TapeEvent,
)


@dataclass(frozen=True)
class PoolState:
    """Constant-product pool reserves as-of a point in the tape.

    ``anchored`` is False before any absolute reserve anchor has been seen — the deltas are known
    but the absolute depth is not, so the state is not tradeable.
    """

    mint: Mint
    base_reserve: Decimal
    quote_reserve: Decimal
    slot: int
    block_time: datetime
    anchored: bool

    @property
    def tradeable(self) -> bool:
        return self.anchored and self.base_reserve > 0 and self.quote_reserve > 0

    @property
    def mid_price(self) -> Decimal | None:
        if self.base_reserve <= 0:
            return None
        return self.quote_reserve / self.base_reserve


def _swap_deltas(ev: SwapEvent) -> tuple[Decimal, Decimal]:
    """(delta_base_reserve, delta_quote_reserve) a swap applies to the pool."""
    if ev.side is Side.BUY:
        return -ev.base_amount, ev.quote_amount
    return ev.base_amount, -ev.quote_amount


def _liquidity_deltas(ev: LiquidityEvent) -> tuple[Decimal, Decimal]:
    sign = Decimal(1) if ev.action == "add" else Decimal(-1)
    return sign * ev.base_amount, sign * ev.quote_amount


class PoolReconstructor:
    """Folds one mint's tape into a running :class:`PoolState`, queryable as-of any slot.

    Construct with the full tape for one mint (extra mints are ignored). ``state_as_of`` replays
    every event with ``slot <= as_of_slot`` (equivalently ``block_time <= as_of``) — never a future
    event — so the reconstruction is causal by construction.
    """

    def __init__(self, tape: list[TapeEvent], mint: Mint) -> None:
        self.mint = mint
        # Only swaps/liquidity move reserves; sort by slot (canonical replay order), tx-sig tiebreak.
        self._events: list[SwapEvent | LiquidityEvent] = sorted(
            (
                e
                for e in tape
                if e.mint == mint and isinstance(e, SwapEvent | LiquidityEvent)
            ),
            key=lambda e: (e.slot, e.signature or ""),
        )

    def _carried_reserves(
        self, ev: SwapEvent | LiquidityEvent
    ) -> tuple[Decimal, Decimal] | None:
        """Ground-truth reserves carried by an event, preferring *after*-state. None if absent."""
        if ev.base_reserve_after is not None and ev.quote_reserve_after is not None:
            return ev.base_reserve_after, ev.quote_reserve_after
        if (
            isinstance(ev, SwapEvent)
            and ev.base_reserve_before is not None
            and ev.quote_reserve_before is not None
        ):
            # A *before* snapshot anchors the pre-event state; apply the event's own delta to it.
            db, dq = _swap_deltas(ev)
            return ev.base_reserve_before + db, ev.quote_reserve_before + dq
        return None

    def state_as_of(self, as_of: datetime, as_of_slot: int | None = None) -> PoolState:
        """Reserves after every event at/ before ``as_of`` (and ``as_of_slot`` if given).

        Both bounds are inclusive; ``as_of_slot`` (when provided) is the authoritative ordering
        bound and ``as_of`` gates on wall-clock — an event must satisfy both to be included.
        """
        base = Decimal(0)
        quote = Decimal(0)
        anchored = False
        last_slot = 0
        last_time = as_of

        for ev in self._events:
            if ev.block_time > as_of:
                break
            if as_of_slot is not None and ev.slot > as_of_slot:
                break

            carried = self._carried_reserves(ev)
            if carried is not None:
                # Ground truth: snap to the carried post-event reserves.
                base, quote = carried
                anchored = True
            elif anchored:
                # Fold the event's delta onto the running (already-anchored) state.
                db, dq = (
                    _swap_deltas(ev)
                    if isinstance(ev, SwapEvent)
                    else _liquidity_deltas(ev)
                )
                base += db
                quote += dq
            elif isinstance(ev, LiquidityEvent) and ev.action == "add":
                # Pool-creation / first add with no carried reserves: it anchors absolute depth.
                base, quote = ev.base_amount, ev.quote_amount
                anchored = True
            # else: unanchored swap with no carried reserves -> cannot fold absolute depth; skip.

            last_slot = ev.slot
            last_time = ev.block_time

        return PoolState(
            mint=self.mint,
            base_reserve=base,
            quote_reserve=quote,
            slot=last_slot,
            block_time=last_time,
            anchored=anchored,
        )

    def state_before_slot(self, slot: int) -> PoolState:
        """Reserves reconstructed from every event STRICTLY before ``slot``.

        This is the state the calibration harness needs: the pool as-of the instant *before* a
        held-out swap executed, so the sim can predict that swap's fill from pre-swap depth.
        """
        base = Decimal(0)
        quote = Decimal(0)
        anchored = False
        last_slot = 0
        last_time: datetime | None = None

        for ev in self._events:
            if ev.slot >= slot:
                break
            carried = self._carried_reserves(ev)
            if carried is not None:
                base, quote = carried
                anchored = True
            elif anchored:
                db, dq = (
                    _swap_deltas(ev)
                    if isinstance(ev, SwapEvent)
                    else _liquidity_deltas(ev)
                )
                base += db
                quote += dq
            elif isinstance(ev, LiquidityEvent) and ev.action == "add":
                base, quote = ev.base_amount, ev.quote_amount
                anchored = True
            last_slot = ev.slot
            last_time = ev.block_time

        return PoolState(
            mint=self.mint,
            base_reserve=base,
            quote_reserve=quote,
            slot=last_slot,
            block_time=last_time if last_time is not None else datetime.min,
            anchored=anchored,
        )
