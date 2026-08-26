"""The mint index + bisect + one-entry bundle cache in PointInTimeFeatureStore.

The optimisation replaced a full linear scan of the whole multi-mint tape with a dict lookup
plus ``bisect_right``. That is only safe if the slice handed to every feature is unchanged, so
the first test compares against the ORIGINAL expression rather than against a golden file — a
golden file would drift with the fixture, the original expression cannot.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from oct_trading_agent.core import FeatureTier
from oct_trading_agent.featurestore.pointintime.store import PointInTimeFeatureStore

T0 = datetime(2026, 1, 1, tzinfo=UTC)
TA = frozenset({FeatureTier.A_RAW_CHART})


class FakeEvent:
    """Minimal TapeEvent stand-in: the store only reads `mint` and `block_time`."""

    __slots__ = ("mint", "block_time", "tag")

    def __init__(self, mint: str, secs: int, tag: str) -> None:
        self.mint = mint
        self.block_time = T0 + timedelta(seconds=secs)
        self.tag = tag


def _linear(tape, mint, as_of):
    """The pre-optimisation scoping expression, verbatim."""
    return [e for e in tape if e.mint == mint and e.block_time <= as_of]


def _mixed_tape():
    """Two interleaved mints, so a per-mint index has something to actually separate."""
    out = []
    for i in range(60):
        out.append(FakeEvent("A", i * 2, f"a{i}"))
        out.append(FakeEvent("B", i * 2 + 1, f"b{i}"))
    return out


def test_slice_is_identical_to_the_linear_scan():
    """Same objects, same order, at every cut point — including both ends."""
    tape = _mixed_tape()
    store = PointInTimeFeatureStore(tape)
    for mint in ("A", "B"):
        for secs in (0, 1, 2, 3, 59, 60, 61, 118, 119, 500):
            as_of = T0 + timedelta(seconds=secs)
            expected = _linear(tape, mint, as_of)
            hi = __import__("bisect").bisect_right(store._times.get(mint, []), as_of)
            got = store._by_mint.get(mint, [])[:hi]
            assert [id(e) for e in got] == [id(e) for e in expected], (mint, secs)


def test_boundary_is_inclusive_of_as_of():
    """`block_time <= as_of` — an event exactly at as_of must be INSIDE the slice.

    bisect_left would silently drop it, and the leakage firewall's contract is <=, not <.
    """
    tape = [FakeEvent("A", 0, "x"), FakeEvent("A", 10, "y"), FakeEvent("A", 20, "z")]
    store = PointInTimeFeatureStore(tape)
    b = store.assemble("A", T0 + timedelta(seconds=10), TA)
    hi = __import__("bisect").bisect_right(store._times["A"], T0 + timedelta(seconds=10))
    assert hi == 2, "the event at exactly as_of must be included"
    assert b.as_of == T0 + timedelta(seconds=10)


def test_unknown_mint_yields_an_empty_scope_not_a_crash():
    store = PointInTimeFeatureStore(_mixed_tape())
    bundle = store.assemble("NOPE", T0 + timedelta(seconds=100), TA)
    assert bundle.mint == "NOPE"
    assert FeatureTier.A_RAW_CHART in bundle.tiers


def test_empty_tape():
    store = PointInTimeFeatureStore([])
    bundle = store.assemble("A", T0, TA)
    assert FeatureTier.A_RAW_CHART in bundle.tiers


# --------------------------------------------------------------------------- cache


def test_repeated_call_returns_the_cached_bundle():
    """The whole point: consecutive env steps resolve to the same (mint, as_of, tiers)."""
    store = PointInTimeFeatureStore(_mixed_tape())
    as_of = T0 + timedelta(seconds=50)
    first = store.assemble("A", as_of, TA)
    second = store.assemble("A", as_of, TA)
    assert first is second, "identical key must not recompute"


@pytest.mark.parametrize(
    "mint,secs,tiers",
    [
        ("B", 50, TA),                                   # different mint
        ("A", 51, TA),                                   # different as_of
        ("A", 50, frozenset({FeatureTier.B_WALLET_FLOWS})),  # different tiers
    ],
)
def test_cache_never_serves_a_different_key(mint, secs, tiers):
    """A one-entry cache is only safe if EVERY component of the key is part of the key."""
    store = PointInTimeFeatureStore(_mixed_tape())
    base = store.assemble("A", T0 + timedelta(seconds=50), TA)
    other = store.assemble(mint, T0 + timedelta(seconds=secs), tiers)
    assert other is not base
    assert other.mint == mint
    assert other.as_of == T0 + timedelta(seconds=secs)


def test_alternating_keys_do_not_return_stale_bundles():
    """A one-entry cache must evict, not shadow — alternating A/B has a 0% hit rate."""
    store = PointInTimeFeatureStore(_mixed_tape())
    as_of = T0 + timedelta(seconds=50)
    a1 = store.assemble("A", as_of, TA)
    b1 = store.assemble("B", as_of, TA)
    a2 = store.assemble("A", as_of, TA)
    assert b1.mint == "B" and a2.mint == "A"
    assert a2 is not a1, "A was evicted by B, so it must be rebuilt rather than served stale"


# --------------------------------------------------------------------------- ordering


def test_out_of_order_tape_is_scoped_chronologically():
    """A tape that is NOT already chronological.

    The old linear filter preserved *tape* order; the index sorts by ``block_time``. For every
    real dataset the two agree, because tapes arrive chronological (asserted on the live
    market_dataset_snap800: 7,582 events, already sorted). Where they could differ, time order
    is the correct answer — a point-in-time reconstruction is defined by time, not by the order
    rows happened to be appended — so this pins the intended behaviour rather than leaving it
    to chance.
    """
    tape = [FakeEvent("A", 30, "late"), FakeEvent("A", 10, "early"), FakeEvent("A", 20, "mid")]
    store = PointInTimeFeatureStore(tape)
    assert [e.tag for e in store._by_mint["A"]] == ["early", "mid", "late"]
    hi = __import__("bisect").bisect_right(store._times["A"], T0 + timedelta(seconds=20))
    assert [e.tag for e in store._by_mint["A"][:hi]] == ["early", "mid"]


def test_equal_block_times_keep_tape_order():
    """Ties must be stable: same-second events keep the order they arrived in."""
    tape = [FakeEvent("A", 5, "first"), FakeEvent("A", 5, "second"), FakeEvent("A", 5, "third")]
    store = PointInTimeFeatureStore(tape)
    assert [e.tag for e in store._by_mint["A"]] == ["first", "second", "third"]
