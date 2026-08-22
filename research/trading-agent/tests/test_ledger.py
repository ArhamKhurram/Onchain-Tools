"""Paper ledger: cost-inclusive balance accounting, realized-only PnL, episode close."""

from __future__ import annotations

from decimal import Decimal

import pytest

from oct_trading_agent.core import (
    Fill,
    Intent,
    PositionState,
    SimStepResult,
    TerminalReason,
)
from oct_trading_agent.ledger import LedgerProtocol, PaperLedger
from tests.conftest import MINT, _t


def _buy_step() -> SimStepResult:
    fill = Fill(
        mint=MINT,
        intent=Intent.OPEN_LONG,
        success=True,
        executed_price=Decimal("0.0001"),
        base_amount=Decimal(10_000),
        quote_amount=Decimal(1),
        fee_quote=Decimal("0.001"),
    )
    pos = PositionState(mint=MINT, base_qty=Decimal(10_000), avg_entry_price=Decimal("0.0001001"))
    return SimStepResult(fill=fill, position=pos, realized_pnl_quote=Decimal(0))


def _close_step() -> SimStepResult:
    fill = Fill(
        mint=MINT,
        intent=Intent.CLOSE,
        success=True,
        executed_price=Decimal("0.0003"),
        base_amount=Decimal(10_000),
        quote_amount=Decimal(3),
        fee_quote=Decimal("0.001"),
    )
    pos = PositionState(mint=MINT, base_qty=Decimal(0), realized_pnl_quote=Decimal(2))
    return SimStepResult(
        fill=fill,
        position=pos,
        realized_pnl_quote=Decimal(2),
        terminal=True,
        terminal_reason=TerminalReason.FULL_EXIT,
    )


def test_conforms_to_protocol() -> None:
    assert isinstance(PaperLedger(), LedgerProtocol)


def test_buy_debits_quote_plus_gas() -> None:
    ledger = PaperLedger(initial_balance_quote=Decimal(100))
    entry = ledger.record(MINT, _buy_step(), _t(200))
    # 100 - (quote 1 + gas 0.001) = 98.999
    assert ledger.balance_quote == Decimal("98.999")
    assert entry.balance_after_quote == Decimal("98.999")
    assert entry.realized_pnl_quote == Decimal(0)


def test_sell_credits_quote_minus_gas_and_books_realized() -> None:
    ledger = PaperLedger(initial_balance_quote=Decimal(100))
    ledger.record(MINT, _buy_step(), _t(200))
    entry = ledger.record(MINT, _close_step(), _t(300))
    # 98.999 + (quote 3 - gas 0.001) = 101.998
    assert ledger.balance_quote == Decimal("101.998")
    assert entry.realized_pnl_quote == Decimal(2)


def test_realized_pnl_never_reads_mark_price() -> None:
    ledger = PaperLedger()
    # A step whose position carries a rich mark_price but zero realized PnL books zero.
    fill = Fill(mint=MINT, intent=Intent.HOLD, success=True)
    pos = PositionState(
        mint=MINT, base_qty=Decimal(10_000), mark_price=Decimal("999"), realized_pnl_quote=Decimal(0)
    )
    entry = ledger.record(MINT, SimStepResult(fill=fill, position=pos), _t(200))
    assert entry.realized_pnl_quote == Decimal(0)
    assert ledger.balance_quote == Decimal(0)  # a HOLD with zero gas moves nothing


def test_failed_tx_burns_gas_only() -> None:
    ledger = PaperLedger(initial_balance_quote=Decimal(10))
    from oct_trading_agent.core import FillFailureReason

    fill = Fill(
        mint=MINT,
        intent=Intent.OPEN_LONG,
        success=False,
        failure_reason=FillFailureReason.TX_FAILED,
        fee_quote=Decimal("0.0005"),
    )
    pos = PositionState(mint=MINT)
    ledger.record(MINT, SimStepResult(fill=fill, position=pos), _t(200))
    assert ledger.balance_quote == Decimal("9.9995")


def test_episode_accumulates_and_closes() -> None:
    ledger = PaperLedger(initial_balance_quote=Decimal(100))
    ledger.record(MINT, _buy_step(), _t(200))
    ledger.record(MINT, _close_step(), _t(300))
    episode = ledger.close_episode(MINT)
    assert len(episode.entries) == 2
    assert episode.terminal_reason is TerminalReason.FULL_EXIT
    assert episode.realized_pnl_quote == Decimal(2)
    assert episode.started_at == _t(200)
    assert episode.ended_at == _t(300)


def test_close_without_open_episode_raises() -> None:
    with pytest.raises(KeyError):
        PaperLedger().close_episode(MINT)


def test_new_episode_after_terminal() -> None:
    ledger = PaperLedger(initial_balance_quote=Decimal(100))
    ledger.record(MINT, _buy_step(), _t(200))
    ledger.record(MINT, _close_step(), _t(300))  # terminal
    # A record after the terminal step opens a fresh episode for the same mint.
    ledger.record(MINT, _buy_step(), _t(400))
    reopened = ledger.open_episode(MINT)
    assert reopened is not None
    assert len(reopened.entries) == 1
    assert reopened.started_at == _t(400)
