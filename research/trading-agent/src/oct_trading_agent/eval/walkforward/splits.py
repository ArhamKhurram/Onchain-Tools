"""Walk-forward splitting — time-ordered ONLY, never random (paper §8.5, §9.6; 05-evaluation-plan).

"Time ordering is sacred" (§8.5): a memecoin edge learned this month can invert next month, so the
single most common way trading ML lies is a random train/test split that lets the future leak into
training. This module refuses that by construction — every split here is a *time cut*, and both
held-out axes the plan requires are produced time-ordered:

* **Held-out time periods** (:func:`walk_forward_time_splits`) — expanding- or rolling-window folds
  over a sorted time axis, each with a train window strictly *before* its test window.
* **Held-out tokens** (:func:`token_time_holdout`) — the latest-launching fraction of tokens is the
  test set; earlier tokens train. A token never appears in both, and the test tokens are strictly
  newer, so this is a forward test on tokens the training window never saw.

There is no random-split function on purpose. :func:`assert_time_ordered` is the standing guard a
caller can invoke to prove a split it built elsewhere respects ordering.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from oct_trading_agent.core import Mint


@dataclass(frozen=True)
class TokenSpan:
    """A token and its representative instant (e.g. first-swap / creation time) for time ordering."""

    mint: Mint
    start_time: datetime


@dataclass(frozen=True)
class TimeSplit:
    """One walk-forward fold over a time axis: train is strictly before test."""

    fold: int
    train_start: datetime
    train_end: datetime  # exclusive upper bound of train / lower bound of test
    test_end: datetime

    def __post_init__(self) -> None:
        if not self.train_start <= self.train_end <= self.test_end:
            raise ValueError("a TimeSplit must satisfy train_start <= train_end <= test_end")


@dataclass(frozen=True)
class TokenHoldout:
    """A time-ordered token split: the newest ``test_fraction`` of tokens held out for testing."""

    train: list[Mint]
    test: list[Mint]
    cutoff_time: datetime


def walk_forward_time_splits(
    times: list[datetime], n_splits: int, *, scheme: str = "expanding"
) -> list[TimeSplit]:
    """Produce ``n_splits`` time-ordered folds over the sorted unique instants in ``times``.

    ``scheme='expanding'`` grows the train window from the start each fold (anchored walk-forward);
    ``scheme='rolling'`` slides a fixed-width train window forward. Test is always the block of time
    immediately after the train window — never before, never overlapping.
    """
    if n_splits < 1:
        raise ValueError("n_splits must be >= 1")
    if scheme not in {"expanding", "rolling"}:
        raise ValueError("scheme must be 'expanding' or 'rolling'")
    unique = sorted(set(times))
    if len(unique) < n_splits + 1:
        raise ValueError(
            f"need at least n_splits+1={n_splits + 1} distinct instants, got {len(unique)}"
        )
    n = len(unique)
    # Partition the axis into n_splits+1 contiguous blocks; fold k trains on blocks[0..k], tests k+1.
    edges = [round(i * n / (n_splits + 1)) for i in range(n_splits + 2)]
    splits: list[TimeSplit] = []
    for fold in range(n_splits):
        train_lo_idx = 0 if scheme == "expanding" else edges[fold]
        train_hi_idx = edges[fold + 1]  # exclusive
        test_hi_idx = edges[fold + 2]  # exclusive
        splits.append(
            TimeSplit(
                fold=fold,
                train_start=unique[train_lo_idx],
                train_end=unique[train_hi_idx],
                test_end=unique[min(test_hi_idx, n - 1)],
            )
        )
    return splits


def token_time_holdout(spans: list[TokenSpan], test_fraction: float) -> TokenHoldout:
    """Hold out the newest ``test_fraction`` of tokens by ``start_time`` for testing; rest train.

    Strictly time-ordered: after sorting by start time, the tail fraction is the test set, so the
    test tokens all launched *after* (or no earlier than) every train token — a forward token test.
    """
    if not 0.0 < test_fraction < 1.0:
        raise ValueError("test_fraction must be in (0, 1)")
    if len(spans) < 2:
        raise ValueError("need at least 2 tokens to hold one out")
    ordered = sorted(spans, key=lambda s: (s.start_time, s.mint))
    n_test = max(1, round(test_fraction * len(ordered)))
    n_test = min(n_test, len(ordered) - 1)  # always keep >=1 train token
    split_idx = len(ordered) - n_test
    train = [s.mint for s in ordered[:split_idx]]
    test = [s.mint for s in ordered[split_idx:]]
    cutoff = ordered[split_idx].start_time
    return TokenHoldout(train=train, test=test, cutoff_time=cutoff)


def assert_time_ordered(train_times: list[datetime], test_times: list[datetime]) -> None:
    """Standing guard: every test instant must be >= the maximum train instant (no leakage).

    Raises ``AssertionError`` if any test instant precedes the latest train instant — the exact
    failure a random split would introduce.
    """
    if not train_times or not test_times:
        return
    latest_train = max(train_times)
    earliest_test = min(test_times)
    if earliest_test < latest_train:
        raise AssertionError(
            f"time ordering violated: earliest test {earliest_test.isoformat()} precedes "
            f"latest train {latest_train.isoformat()} — walk-forward requires test strictly after "
            "train (never a random split)"
        )


__all__ = [
    "TimeSplit",
    "TokenHoldout",
    "TokenSpan",
    "assert_time_ordered",
    "token_time_holdout",
    "walk_forward_time_splits",
]
