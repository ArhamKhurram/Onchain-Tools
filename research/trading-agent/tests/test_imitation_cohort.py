"""Cohort pull fault-isolation: a wallet that fails after retries is SKIPPED, never fatal.

The REST client's own exponential backoff (unit-tested in ``tests/data/test_rest_client.py``) is the
first line of defence; this exercises the *orchestrator* one level up — that
:func:`load_cohort_from_pinax` catches a wallet whose backoff was exhausted, counts it, and keeps
pulling the rest, and that the exit-code predicate only fails hard when essentially nothing came back.
Everything here uses an injected fake client — no network.
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path
from typing import Any

import pytest

from oct_trading_agent.agent.imitation.cohort import (
    CohortPullResult,
    cohort_is_usable,
    format_pull_summary,
    load_cohort_from_pinax,
)
from oct_trading_agent.console import safe_console_text, safe_print
from oct_trading_agent.data.labeling.wallets_file import TrackedWallet

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


class FakeCohortClient:
    """A stand-in ``PinaxRestClient`` whose ``get_json`` returns fixture rows for good signers and
    raises the client's own "request failed" error for addresses listed as ``bad`` (backoff already
    exhausted, from the orchestrator's point of view)."""

    def __init__(self, *, bad: set[str]) -> None:
        self._bad = bad
        payload = json.loads((FIXTURES_DIR / "pinax_signer_swaps.json").read_text(encoding="utf-8"))
        self._rows = payload["data"]
        self.calls: list[str] = []

    def get_json(
        self, path: str, params: dict[str, Any], *, use_cache: bool = True
    ) -> dict[str, Any]:
        signer = str(params.get("signer"))
        self.calls.append(signer)
        if signer in self._bad:
            raise RuntimeError("Pinax request failed for /v1/svm/swaps")
        if int(params.get("page", 1)) == 1:
            return {"data": self._rows}
        return {"data": []}


def _tracked(name: str, addr: str) -> TrackedWallet:
    from decimal import Decimal

    return TrackedWallet(address=addr, name=name, native_balance=Decimal(1))


GOOD_A = "GoodTraderAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
GOOD_B = "GoodTraderBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
BAD = "BadTraderXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"


def test_failed_wallet_is_skipped_not_fatal() -> None:
    tracked = [_tracked("A", GOOD_A), _tracked("Bad", BAD), _tracked("B", GOOD_B)]
    client = FakeCohortClient(bad={BAD})

    result = load_cohort_from_pinax(tracked, client=client)

    # The bad wallet did NOT abort the run: both good wallets came back, one skip counted.
    assert isinstance(result, CohortPullResult)
    assert result.n_requested == 3
    assert result.n_pulled == 2
    assert result.n_skipped == 1
    assert result.n_with_trades == 2
    assert [w.wallet for w in result.wallets] == [GOOD_A, GOOD_B]
    assert result.skipped[0][0].startswith("Bad (")
    assert "Pinax request failed" in result.skipped[0][1]


def test_all_wallets_skipped_is_not_usable() -> None:
    tracked = [_tracked("Bad1", BAD), _tracked("Bad2", "AnotherBad" + "y" * 34)]
    client = FakeCohortClient(bad={BAD, "AnotherBad" + "y" * 34})

    result = load_cohort_from_pinax(tracked, client=client)

    assert result.n_pulled == 0
    assert result.n_skipped == 2
    assert not cohort_is_usable(result)  # essentially nothing -> caller should exit non-zero


def test_usable_when_any_wallet_has_trades() -> None:
    tracked = [_tracked("A", GOOD_A), _tracked("Bad", BAD)]
    result = load_cohort_from_pinax(tracked, client=FakeCohortClient(bad={BAD}))
    assert cohort_is_usable(result)  # one good wallet is enough to train on


def test_non_tracked_entries_are_ignored() -> None:
    tracked: list[object] = [_tracked("A", GOOD_A), "not-a-wallet", 42]
    result = load_cohort_from_pinax(tracked, client=FakeCohortClient(bad=set()))
    assert result.n_requested == 1
    assert result.n_pulled == 1


def test_pull_summary_names_the_skips() -> None:
    tracked = [_tracked("A", GOOD_A), _tracked("Bad", BAD)]
    result = load_cohort_from_pinax(tracked, client=FakeCohortClient(bad={BAD}))
    summary = format_pull_summary(result)
    assert "1/2 wallets pulled" in summary
    assert "1 skipped after retries" in summary
    assert "Bad (" in summary


# ---------------------------------------------------------------------------
# Encoding safety: emoji wallet names on a cp1252 Windows console.
#
# The operator's tracked-wallets export carries names with emoji; a real cp1252 console raises
# UnicodeEncodeError when print interpolates one — which broad exception handling once mistook for
# a data failure and silently disabled the tracked_traders baseline. The cohort path must log such
# names losslessly-degraded (emoji -> '?'), never raise.
# ---------------------------------------------------------------------------


class Cp1252ConsoleStream(io.StringIO):
    """A StringIO that refuses exactly what a cp1252 Windows console refuses.

    Plain StringIO happily accepts any str, so it cannot reproduce the failure mode. This wrapper
    advertises ``encoding = "cp1252"`` (what ``safe_console_text`` keys off) and encode-checks every
    write against cp1252, raising ``UnicodeEncodeError`` exactly like the real console would.
    """

    encoding = "cp1252"

    def write(self, s: str) -> int:
        s.encode("cp1252")  # raises UnicodeEncodeError just like a real cp1252 console
        return super().write(s)


class Utf8Stream(io.StringIO):
    encoding = "utf-8"


EMOJI_NAME = "\U0001f433 whale hunter \U0001f680"  # "🐳 whale hunter 🚀"


def test_emoji_wallet_name_logs_without_raising_on_cp1252(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The full pull path — pulling line AND skip line — survives a cp1252 stdout with emoji names."""
    stream = Cp1252ConsoleStream()
    monkeypatch.setattr(sys, "stdout", stream)

    tracked = [_tracked(EMOJI_NAME, GOOD_A), _tracked(EMOJI_NAME + " (bad)", BAD)]
    result = load_cohort_from_pinax(tracked, client=FakeCohortClient(bad={BAD}), log=print)

    # The pull ran to completion: no UnicodeEncodeError, good wallet in, bad wallet skip-counted.
    assert result.n_pulled == 1
    assert result.n_skipped == 1
    logged = stream.getvalue()
    assert "pulling" in logged
    assert "SKIPPED after retries" in logged
    # The emoji were replaced for display, not written raw (the stream would have raised).
    assert "\U0001f433" not in logged
    assert "whale hunter" in logged
    assert "?" in logged


def test_safe_console_text_passthrough_and_replacement() -> None:
    # UTF-8-capable stream: text passes through untouched (no lossy replacement when not needed).
    assert safe_console_text(EMOJI_NAME, Utf8Stream()) == EMOJI_NAME
    # cp1252 stream: emoji degrade to '?', readable ASCII survives.
    sanitized = safe_console_text(EMOJI_NAME, Cp1252ConsoleStream())
    assert "\U0001f433" not in sanitized
    assert "whale hunter" in sanitized
    assert "?" in sanitized


def test_safe_print_never_raises_on_cp1252_stream() -> None:
    stream = Cp1252ConsoleStream()
    safe_print(f"  [1/1] pulling {EMOJI_NAME} (Abcdefgh...)", stream=stream)
    out = stream.getvalue()
    assert "pulling" in out
    assert "whale hunter" in out
    assert "\U0001f433" not in out
