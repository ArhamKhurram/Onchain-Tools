"""Rug absorbing states: causal as-of terminality and earliest-rug indexing."""

from __future__ import annotations

from oct_trading_agent.core import TapeEvent
from oct_trading_agent.sim.rug.absorbing import RugTracker
from tests.conftest import MINT, RugFactory, SwapFactory, _t


def test_no_rug_is_never_terminal(make_swap: SwapFactory) -> None:
    tape: list[TapeEvent] = [make_swap(100)]
    tracker = RugTracker(tape)
    assert tracker.rug_marker(MINT) is None
    assert not tracker.is_rugged_as_of(MINT, _t(1000))


def test_rug_is_terminal_at_and_after_its_slot(make_rug: RugFactory) -> None:
    tape: list[TapeEvent] = [make_rug(300)]
    tracker = RugTracker(tape)
    assert not tracker.is_rugged_as_of(MINT, _t(299))
    assert tracker.is_rugged_as_of(MINT, _t(300))  # inclusive of the rug instant
    assert tracker.is_rugged_as_of(MINT, _t(500))


def test_rug_by_slot_bound(make_rug: RugFactory) -> None:
    tracker = RugTracker([make_rug(300)])
    assert not tracker.is_rugged_as_of(MINT, _t(9999), as_of_slot=299)
    assert tracker.is_rugged_as_of(MINT, _t(9999), as_of_slot=300)


def test_earliest_rug_wins(make_rug: RugFactory) -> None:
    tape: list[TapeEvent] = [make_rug(500), make_rug(300), make_rug(700)]
    marker = RugTracker(tape).rug_marker(MINT)
    assert marker is not None
    assert marker.slot == 300
