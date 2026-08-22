"""Walk-forward tests: time ordering is enforced; token holdout is time-ordered; no random splits."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from oct_trading_agent.eval.walkforward import (
    TokenSpan,
    assert_time_ordered,
    token_time_holdout,
    walk_forward_time_splits,
)

T0 = datetime(2026, 8, 22, 0, 0, 0, tzinfo=UTC)


def _times(n: int) -> list[datetime]:
    return [T0 + timedelta(hours=i) for i in range(n)]


def test_walk_forward_splits_are_time_ordered() -> None:
    splits = walk_forward_time_splits(_times(12), n_splits=3, scheme="expanding")
    assert len(splits) == 3
    for s in splits:
        assert s.train_start <= s.train_end <= s.test_end
    # Expanding: every fold trains from the very start.
    assert all(s.train_start == splits[0].train_start for s in splits)


def test_rolling_scheme_moves_the_train_window() -> None:
    splits = walk_forward_time_splits(_times(12), n_splits=3, scheme="rolling")
    starts = [s.train_start for s in splits]
    assert starts == sorted(starts)
    assert starts[0] < starts[-1]  # the window slid forward


def test_token_holdout_is_newest_fraction() -> None:
    spans = [TokenSpan(mint=f"m{i}", start_time=T0 + timedelta(days=i)) for i in range(10)]
    holdout = token_time_holdout(spans, test_fraction=0.3)
    assert len(holdout.test) == 3
    assert holdout.train and holdout.test
    # every test token launched at/after the cutoff; every train token before it
    latest_train = max(T0 + timedelta(days=int(m[1:])) for m in holdout.train)
    earliest_test = min(T0 + timedelta(days=int(m[1:])) for m in holdout.test)
    assert earliest_test >= latest_train


def test_assert_time_ordered_flags_leakage() -> None:
    train = [T0 + timedelta(hours=5)]
    test_bad = [T0 + timedelta(hours=1)]  # precedes train -> leakage
    with pytest.raises(AssertionError):
        assert_time_ordered(train, test_bad)
    # A properly ordered split does not raise.
    assert_time_ordered([T0], [T0 + timedelta(hours=1)])


def test_too_few_instants_raises() -> None:
    with pytest.raises(ValueError):
        walk_forward_time_splits(_times(2), n_splits=5)
