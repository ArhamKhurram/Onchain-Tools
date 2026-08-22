"""Shared tape-event builders for the sim/ledger tests, exposed as factory fixtures."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from oct_trading_agent.core import (
    LiquidityEvent,
    RugEvent,
    Side,
    SwapEvent,
)

MINT = "So11111111111111111111111111111111111111112"
T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)


def _t(seconds: int) -> datetime:
    return T0 + timedelta(seconds=seconds)


SwapFactory = Callable[..., SwapEvent]
LiqFactory = Callable[..., LiquidityEvent]
RugFactory = Callable[..., RugEvent]


@pytest.fixture
def make_swap() -> SwapFactory:
    def _make(
        slot: int,
        side: Side = Side.BUY,
        base_amount: str | Decimal = "1000",
        quote_amount: str | Decimal = "1",
        price: str | Decimal | None = None,
        *,
        mint: str = MINT,
        base_reserve_after: str | Decimal | None = None,
        quote_reserve_after: str | Decimal | None = None,
        base_reserve_before: str | Decimal | None = None,
        quote_reserve_before: str | Decimal | None = None,
        signature: str | None = None,
    ) -> SwapEvent:
        return SwapEvent(
            mint=mint,
            slot=slot,
            block_time=_t(slot),
            signature=signature or f"sig-{slot}",
            signer="Wa11etWa11etWa11etWa11etWa11etWa11etWa11",
            side=side,
            base_amount=Decimal(str(base_amount)),
            quote_amount=Decimal(str(quote_amount)),
            price=None if price is None else Decimal(str(price)),
            base_reserve_after=None if base_reserve_after is None else Decimal(str(base_reserve_after)),
            quote_reserve_after=None
            if quote_reserve_after is None
            else Decimal(str(quote_reserve_after)),
            base_reserve_before=None
            if base_reserve_before is None
            else Decimal(str(base_reserve_before)),
            quote_reserve_before=None
            if quote_reserve_before is None
            else Decimal(str(quote_reserve_before)),
        )

    return _make


@pytest.fixture
def make_liquidity() -> LiqFactory:
    def _make(
        slot: int,
        action: str = "add",
        base_amount: str | Decimal = "1000000",
        quote_amount: str | Decimal = "100",
        *,
        mint: str = MINT,
        base_reserve_after: str | Decimal | None = None,
        quote_reserve_after: str | Decimal | None = None,
    ) -> LiquidityEvent:
        return LiquidityEvent(
            mint=mint,
            slot=slot,
            block_time=_t(slot),
            signature=f"lp-{slot}",
            action=action,  # type: ignore[arg-type]
            base_amount=Decimal(str(base_amount)),
            quote_amount=Decimal(str(quote_amount)),
            base_reserve_after=None if base_reserve_after is None else Decimal(str(base_reserve_after)),
            quote_reserve_after=None
            if quote_reserve_after is None
            else Decimal(str(quote_reserve_after)),
        )

    return _make


@pytest.fixture
def make_rug() -> RugFactory:
    def _make(slot: int, *, mint: str = MINT, rug_kind: str = "liquidity_pull") -> RugEvent:
        return RugEvent(
            mint=mint,
            slot=slot,
            block_time=_t(slot),
            signature=f"rug-{slot}",
            rug_kind=rug_kind,  # type: ignore[arg-type]
        )

    return _make


@pytest.fixture
def at() -> Callable[[int], datetime]:
    """Wall-clock at ``slot`` seconds past T0 — the block_time the builders use."""
    return _t
