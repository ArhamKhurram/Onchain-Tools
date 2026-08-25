"""The resolved-cohort cache and the launch-path ratchet — the fix for the recurring Pinax stall.

Every ladder launch used to re-pull ~40 tracked wallets from a hard-rate-limiting Pinax, burn 10+
minutes, and reach training with ~8 of them — few enough that the rung-100 ``tracked_traders``
baseline was degenerate. These tests pin the behaviour that replaces it:

* the cohort survives a round trip through JSON **exactly** (``Decimal`` amounts, tz-aware
  timestamps, optional prices) — a lossy cache would quietly change the baseline it feeds;
* a launch with a covering cache does **no** network work, and a partial pull asks only for what is
  still missing;
* coverage RATCHETS — wallets and their trades are unioned across runs, never replaced, including
  under ``--cohort-refresh``;
* every cache failure degrades to a live pull rather than failing the run, while a ``UnicodeError``
  (a logging bug, not a data failure) is still re-raised so it can never silently kill the baseline.

Everything here is pure: the pull is an injected fake, the cache is a ``tmp_path`` file. No network.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest

from oct_trading_agent.agent.imitation.cohort import CohortPullResult
from oct_trading_agent.agent.imitation.cohort_store import (
    CACHE_FORMAT_VERSION,
    CohortCacheError,
    cohort_cache_path,
    load_cohort,
    merge_cohorts,
    read_cohort_cache,
    save_cohort,
)
from oct_trading_agent.agent.train_market import resolve_cohort
from oct_trading_agent.core import Side
from oct_trading_agent.data.labeling.schema import LabeledTrade, LabeledWallet
from oct_trading_agent.data.labeling.wallets_file import TrackedWallet

T0 = datetime(2026, 8, 1, 12, 0, tzinfo=UTC)

ADDR_A = "TraderAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
ADDR_B = "TraderBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
ADDR_C = "TraderCcccccccccccccccccccccccccccccccccccccc"
MINT = "Mint00000000000000000000000000000000000000000"


def _trade(*, sig: str, minute: int, side: Side = Side.BUY) -> LabeledTrade:
    # Deliberately awkward amounts: Decimal("0.250000000000001") is not representable as a float,
    # so a cache that round-tripped through float would visibly corrupt it.
    return LabeledTrade(
        timestamp=T0 + timedelta(minutes=minute),
        mint=MINT,
        side=side,
        base_amount=Decimal("1000.500000000000001"),
        quote_amount=Decimal("0.250000000000001"),
        price=None if minute % 2 else Decimal("0.00024987506246878"),
        signature=sig,
    )


def _wallet(address: str, *, sigs: Sequence[tuple[str, int]], labels: list[str] | None = None) -> LabeledWallet:
    return LabeledWallet(
        wallet=address,
        labels=list(labels or ["tracked", "balance-ranked"]),
        trades=[_trade(sig=sig, minute=minute) for sig, minute in sigs],
    )


def _tracked(address: str) -> TrackedWallet:
    return TrackedWallet(address=address, name=address[:6], native_balance=Decimal(10))


# ---------------------------------------------------------------------------
# Save / load round trip
# ---------------------------------------------------------------------------


def test_round_trip_is_exact(tmp_path: Path) -> None:
    """A cached cohort reloads as the SAME objects — no float rounding, no dropped optionals."""
    wallets = [
        _wallet(ADDR_A, sigs=[("sigA1", 0), ("sigA2", 1)]),
        _wallet(ADDR_B, sigs=[("sigB1", 5)], labels=["tracked", "whale"]),
        _wallet(ADDR_C, sigs=[]),  # a resolved wallet with no trades is still coverage
    ]
    path = tmp_path / "cohort.json"

    save_cohort(path, wallets, max_wallets=40, max_pages=8)
    restored = load_cohort(path)

    assert restored.wallets == wallets  # pydantic equality: every field, Decimals included
    assert restored.max_wallets == 40
    assert restored.max_pages == 8
    # Not merely equal-looking: the exact Decimal scale and the None price survived.
    assert restored.wallets[0].trades[0].quote_amount == Decimal("0.250000000000001")
    assert str(restored.wallets[0].trades[0].base_amount) == "1000.500000000000001"
    assert restored.wallets[0].trades[1].price is None
    assert restored.wallets[0].trades[0].timestamp == T0


def test_saved_file_is_readable_json_with_provenance(tmp_path: Path) -> None:
    """The file is inspectable by hand — an operator must be able to see what a cache claims."""
    path = tmp_path / "cohort.json"
    save_cohort(path, [_wallet(ADDR_A, sigs=[("s1", 0)])], max_wallets=40, max_pages=8)

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["version"] == CACHE_FORMAT_VERSION
    assert payload["n_wallets"] == 1
    assert payload["n_trades"] == 1
    assert payload["saved_at"]
    assert payload["wallets"][0]["wallet"] == ADDR_A


def test_cache_path_keys_on_export_contents_and_bounds(tmp_path: Path) -> None:
    """Anything that changes what a pull WOULD return changes the file it reads."""
    export = tmp_path / "wallets.json"
    export.write_text('[{"address": "A"}]', encoding="utf-8")
    base = cohort_cache_path(tmp_path, export, max_wallets=40, max_pages=8)

    assert base.name.startswith("cohort_")
    assert base.name.endswith("_40_8.json")
    assert cohort_cache_path(tmp_path, export, max_wallets=40, max_pages=8) == base  # stable
    assert cohort_cache_path(tmp_path, export, max_wallets=80, max_pages=8) != base
    assert cohort_cache_path(tmp_path, export, max_wallets=40, max_pages=16) != base

    # A re-exported file with different balances selects a different cohort — different key.
    export.write_text('[{"address": "A"}, {"address": "B"}]', encoding="utf-8")
    assert cohort_cache_path(tmp_path, export, max_wallets=40, max_pages=8) != base


def test_cache_path_survives_an_unreadable_export(tmp_path: Path) -> None:
    """Key derivation must never be the thing that raises — a missing export falls back to its path."""
    path = cohort_cache_path(tmp_path, tmp_path / "does-not-exist.json", max_wallets=40, max_pages=8)
    assert path.name.startswith("cohort_")


# ---------------------------------------------------------------------------
# Tolerant reads: a cache failure degrades, it never fails a run
# ---------------------------------------------------------------------------


def test_missing_cache_is_a_silent_empty(tmp_path: Path) -> None:
    lines: list[str] = []
    assert read_cohort_cache(tmp_path / "absent.json", log=lines.append) == []
    assert read_cohort_cache(None, log=lines.append) == []
    assert lines == []  # the first launch is not an anomaly worth shouting about


@pytest.mark.parametrize(
    "contents",
    [
        "{ this is not json",
        json.dumps([1, 2, 3]),  # JSON, but not a cohort object
        json.dumps({"version": CACHE_FORMAT_VERSION}),  # no wallets list
        json.dumps({"version": CACHE_FORMAT_VERSION + 99, "wallets": []}),  # a schema we don't write
        json.dumps({"version": CACHE_FORMAT_VERSION, "wallets": [{"nonsense": True}]}),
    ],
)
def test_corrupt_cache_degrades_loudly_instead_of_crashing(tmp_path: Path, contents: str) -> None:
    path = tmp_path / "cohort.json"
    path.write_text(contents, encoding="utf-8")
    lines: list[str] = []

    assert read_cohort_cache(path, log=lines.append) == []  # degrade to "no cache"

    assert any("cache unusable" in line for line in lines)
    with pytest.raises(CohortCacheError):  # the strict reader still says exactly what was wrong
        load_cohort(path)


# ---------------------------------------------------------------------------
# The ratchet
# ---------------------------------------------------------------------------


def test_merge_keeps_wallets_only_one_side_has() -> None:
    """The union is the whole point: a partial pull adds to coverage, it never subtracts."""
    cached = [_wallet(ADDR_A, sigs=[("sigA1", 0)]), _wallet(ADDR_B, sigs=[("sigB1", 0)])]
    live = [_wallet(ADDR_C, sigs=[("sigC1", 0)])]

    merged = merge_cohorts(cached, live)

    assert [w.wallet for w in merged.wallets] == [ADDR_C, ADDR_A, ADDR_B]  # live first, then cache
    assert merged.n_live == 1
    assert merged.n_cache_only == 2
    assert merged.n_trades_recovered == 0


def test_merge_unions_trades_within_a_shared_wallet() -> None:
    """A shorter fresh window cannot shrink a trader's history — the two windows are unioned."""
    cached = [_wallet(ADDR_A, sigs=[("old1", 0), ("old2", 1), ("shared", 2)])]
    live = [_wallet(ADDR_A, sigs=[("shared", 2), ("new1", 3)])]

    merged = merge_cohorts(cached, live)

    assert len(merged.wallets) == 1
    sigs = [t.signature for t in merged.wallets[0].trades]
    assert sigs == ["old1", "old2", "shared", "new1"]  # de-duped and re-sorted by time
    assert merged.n_trades_recovered == 2  # the two the fresh window had dropped


def test_merge_unions_labels_and_prefers_the_live_record() -> None:
    cached = [_wallet(ADDR_A, sigs=[("s", 0)], labels=["tracked", "whale"])]
    live = [_wallet(ADDR_A, sigs=[("s", 0)], labels=["tracked", "balance-ranked"])]

    merged = merge_cohorts(cached, live)

    assert merged.wallets[0].labels == ["tracked", "balance-ranked", "whale"]
    assert len(merged.wallets[0].trades) == 1  # the same trade seen twice is still one trade


def test_merge_with_an_empty_side_is_the_other_side() -> None:
    only_live = merge_cohorts([], [_wallet(ADDR_A, sigs=[("s", 0)])])
    assert [w.wallet for w in only_live.wallets] == [ADDR_A]
    assert (only_live.n_live, only_live.n_cache_only) == (1, 0)

    only_cache = merge_cohorts([_wallet(ADDR_B, sigs=[("s", 0)])], [])
    assert [w.wallet for w in only_cache.wallets] == [ADDR_B]
    assert (only_cache.n_live, only_cache.n_cache_only) == (0, 1)


# ---------------------------------------------------------------------------
# resolve_cohort — the launch path, with an injected fake pull
# ---------------------------------------------------------------------------


class FakePull:
    """A stand-in cohort pull: resolves the addresses it knows, "skips" the rest (rate-limited)."""

    def __init__(self, *, resolves: set[str], boom: Exception | None = None) -> None:
        self._resolves = resolves
        self._boom = boom
        self.requests: list[list[str]] = []  # what each launch actually asked the network for

    def __call__(self, tracked: Sequence[TrackedWallet]) -> CohortPullResult:
        self.requests.append([tw.address for tw in tracked])
        if self._boom is not None:
            raise self._boom
        wallets = [
            _wallet(tw.address, sigs=[(f"{tw.address[:6]}-s1", 0)])
            for tw in tracked
            if tw.address in self._resolves
        ]
        skipped = [(tw.name, "429 rate limited") for tw in tracked if tw.address not in self._resolves]
        return CohortPullResult(wallets=wallets, n_requested=len(tracked), skipped=skipped)

    @property
    def called(self) -> bool:
        return bool(self.requests)


COHORT = [_tracked(ADDR_A), _tracked(ADDR_B), _tracked(ADDR_C)]


def _resolve(pull: FakePull, path: Path | None, *, refresh: bool = False) -> tuple[list[LabeledWallet], list[str]]:
    lines: list[str] = []
    wallets = resolve_cohort(
        COHORT, pull=pull, cache_path=path, refresh=refresh,
        max_wallets=40, max_pages=8, log=lines.append,
    )
    return wallets, lines


def test_a_covering_cache_means_no_network_at_all(tmp_path: Path) -> None:
    """The stall dies here: with every wallet cached, a launch asks Pinax for nothing."""
    path = tmp_path / "cohort.json"
    first = FakePull(resolves={ADDR_A, ADDR_B, ADDR_C})
    _resolve(first, path)

    second = FakePull(resolves=set())
    wallets, lines = _resolve(second, path)

    assert not second.called
    assert {w.wallet for w in wallets} == {ADDR_A, ADDR_B, ADDR_C}
    assert any("no Pinax pull" in line for line in lines)


def test_coverage_ratchets_up_across_partial_launches(tmp_path: Path) -> None:
    """Three rate-limited launches accumulate the cohort instead of resetting it each time."""
    path = tmp_path / "cohort.json"

    first = FakePull(resolves={ADDR_A})
    wallets_1, _ = _resolve(first, path)
    assert {w.wallet for w in wallets_1} == {ADDR_A}
    assert first.requests == [[ADDR_A, ADDR_B, ADDR_C]]  # nothing cached yet: ask for everything

    second = FakePull(resolves={ADDR_B})
    wallets_2, lines_2 = _resolve(second, path)
    assert {w.wallet for w in wallets_2} == {ADDR_A, ADDR_B}
    assert second.requests == [[ADDR_B, ADDR_C]]  # only the ones still missing
    assert any("1 still missing" in line for line in lines_2)

    third = FakePull(resolves={ADDR_C})
    wallets_3, lines_3 = _resolve(third, path)
    assert {w.wallet for w in wallets_3} == {ADDR_A, ADDR_B, ADDR_C}
    assert third.requests == [[ADDR_C]]
    assert any("0 still missing" in line for line in lines_3)


def test_refresh_forces_a_live_pull_but_still_cannot_lose_coverage(tmp_path: Path) -> None:
    """``--cohort-refresh`` re-pulls everything; the cache is merged in, not discarded."""
    path = tmp_path / "cohort.json"
    _resolve(FakePull(resolves={ADDR_A, ADDR_B, ADDR_C}), path)

    # A refresh that only manages to re-resolve one wallet must still return all three.
    refresher = FakePull(resolves={ADDR_A})
    wallets, lines = _resolve(refresher, path, refresh=True)

    assert refresher.requests == [[ADDR_A, ADDR_B, ADDR_C]]  # every wallet asked for, cache ignored
    assert {w.wallet for w in wallets} == {ADDR_A, ADDR_B, ADDR_C}
    assert any("--cohort-refresh" in line for line in lines)


def test_refresh_with_no_cache_just_pulls(tmp_path: Path) -> None:
    pull = FakePull(resolves={ADDR_A, ADDR_B})
    wallets, _ = _resolve(pull, tmp_path / "cohort.json", refresh=True)
    assert pull.requests == [[ADDR_A, ADDR_B, ADDR_C]]
    assert {w.wallet for w in wallets} == {ADDR_A, ADDR_B}


def test_corrupt_cache_degrades_to_a_full_live_pull(tmp_path: Path) -> None:
    path = tmp_path / "cohort.json"
    path.write_text("{ truncated mid-write", encoding="utf-8")
    pull = FakePull(resolves={ADDR_A, ADDR_B, ADDR_C})

    wallets, lines = _resolve(pull, path)

    assert pull.requests == [[ADDR_A, ADDR_B, ADDR_C]]  # no coverage claimed from a broken file
    assert len(wallets) == 3
    assert any("cache unusable" in line for line in lines)
    assert load_cohort(path).wallets == wallets  # and the run repaired the cache on its way out


def test_pull_failure_falls_back_to_the_cache_and_keeps_the_baseline_on(tmp_path: Path) -> None:
    """A dead Pinax must not undo the ratchet — a cached cohort still scores the baseline."""
    path = tmp_path / "cohort.json"
    _resolve(FakePull(resolves={ADDR_A, ADDR_B}), path)

    broken = FakePull(resolves=set(), boom=RuntimeError("PINAX_API_KEY is not set"))
    wallets, lines = _resolve(broken, path)

    assert {w.wallet for w in wallets} == {ADDR_A, ADDR_B}
    assert any("the baseline stays ON" in line for line in lines)
    assert not any("baseline OFF" in line for line in lines)


def test_pull_failure_with_no_cache_says_baseline_off(tmp_path: Path) -> None:
    broken = FakePull(resolves=set(), boom=RuntimeError("PINAX_API_KEY is not set"))
    wallets, lines = _resolve(broken, tmp_path / "cohort.json")

    assert wallets == []
    assert any("baseline OFF" in line for line in lines)


def test_a_pull_that_resolves_nothing_says_baseline_off(tmp_path: Path) -> None:
    """Everything rate-limited and no cache: honest OFF, not a silent empty baseline."""
    wallets, lines = _resolve(FakePull(resolves=set()), tmp_path / "cohort.json")

    assert wallets == []
    assert any("3 wallet(s) skipped after retries" in line for line in lines)
    assert any("baseline OFF" in line for line in lines)


def test_unicode_error_from_logging_is_reraised_not_degraded(tmp_path: Path) -> None:
    """A cp1252 console blowing up on an emoji wallet name is a BUG — it must never turn the
    baseline off by masquerading as a data failure."""
    exploding = FakePull(resolves=set(), boom=UnicodeEncodeError("cp1252", "\U0001f433", 0, 1, "no"))

    with pytest.raises(UnicodeError):
        _resolve(exploding, tmp_path / "cohort.json")


def test_cache_write_failure_does_not_fail_the_run(tmp_path: Path) -> None:
    """A cache we cannot write is a lost speed-up, not a lost run."""
    unwritable = tmp_path / "a-directory-not-a-file"
    unwritable.mkdir()
    pull = FakePull(resolves={ADDR_A})

    wallets, lines = _resolve(pull, unwritable)

    assert [w.wallet for w in wallets] == [ADDR_A]
    assert any("cache write failed" in line for line in lines)


def test_no_cache_path_still_resolves_live(tmp_path: Path) -> None:
    """``--cohort-cache ''`` disables both layers; the ladder behaves exactly as it used to."""
    pull = FakePull(resolves={ADDR_A, ADDR_B, ADDR_C})
    wallets, _ = _resolve(pull, None)
    assert len(wallets) == 3
    assert pull.requests == [[ADDR_A, ADDR_B, ADDR_C]]
