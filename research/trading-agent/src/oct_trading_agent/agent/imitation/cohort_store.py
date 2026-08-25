"""Persist the RESOLVED tracked-trader cohort, so a rate-limited Pinax pull is paid for ONCE.

The ladder's ``tracked_traders`` baseline needs ~40 tracked wallets' swap histories, and Pinax
rate-limits hard enough that most of them come back ``SKIPPED after retries`` on any given launch.
The ladder therefore used to stall for 10+ minutes on every start and then reach training with a
handful of wallets — few enough that at rung 100 the survivors had traded **none** of the held-out
tokens and "0% beaten" meant nothing.

The pre-existing ``--cohort-cache`` (a disk cache inside
:class:`~oct_trading_agent.data.pinax_client.rest.PinaxRestClient`) cannot fix that, because it
caches *successful HTTP responses*: the requests that stall are the ones that FAIL, so nothing about
them ever lands in the cache and every launch re-pays for the same failures. This module caches one
level up — the **resolved cohort itself**, the :class:`LabeledWallet` objects with their trades —
which is the thing that is expensive to obtain and cheap to keep.

Two properties make it worth the file:

1. **A launch that has a cache does not touch the network** for the wallets the cache already
   covers; it pulls only the ones still missing. The recurring stall shrinks run over run.
2. **Coverage RATCHETS UP.** A partial pull is *unioned* with the cached cohort
   (:func:`merge_cohorts`) rather than replacing it, at two levels: a wallet only one side has is
   kept, and a wallet both sides have gets the union of its trades (de-duped by identity, then
   re-sorted by time). Realized on-chain trades are append-only facts, so unioning two bounded
   windows of one wallet's history invents nothing — it only recovers what a single rate-limited
   window dropped. Repeated launches therefore accumulate tracked wallets instead of resetting to
   whatever survived the last five minutes, which is what makes the rung-100 baseline non-degenerate.

Round-tripping goes through pydantic (``model_dump(mode="json")`` /
:meth:`~pydantic.BaseModel.model_validate`) so ``Decimal`` amounts and tz-aware timestamps come back
**exact**, not float-rounded. Writes are atomic (temp file + rename, reusing
:func:`~oct_trading_agent.agent.population.checkpoint.atomic_write_text`) so a kill mid-write cannot
leave a truncated cache behind. Reads on the launch path go through :func:`read_cohort_cache`, which
never raises: a corrupt, stale-schema, or unreadable file degrades to "no cache" and a live pull,
because a cache is an optimization and must never be able to fail a run.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from oct_trading_agent.agent.population.checkpoint import atomic_write_text
from oct_trading_agent.core.enums import Side
from oct_trading_agent.data.labeling.schema import LabeledTrade, LabeledWallet

# Bumped whenever the on-disk shape changes. A file written by another version is treated as absent
# rather than migrated — the cache is reconstructible from the network, so correctness beats reuse.
CACHE_FORMAT_VERSION = 1

CACHE_FILE_PREFIX = "cohort_"


class CohortCacheError(RuntimeError):
    """A cohort cache file is missing, unreadable, or does not hold a cohort of this schema."""


@dataclass(frozen=True)
class CachedCohort:
    """One cohort cache file's contents: the wallets, plus when and from what they were resolved."""

    wallets: list[LabeledWallet]
    saved_at: str
    max_wallets: int
    max_pages: int

    @property
    def addresses(self) -> set[str]:
        return {w.wallet for w in self.wallets}


@dataclass(frozen=True)
class CohortMergeResult:
    """The union of a cached cohort and a fresh pull — the ratchet, with the accounting to log it."""

    wallets: list[LabeledWallet]
    n_live: int  # wallets this launch's pull resolved
    n_cache_only: int  # wallets ONLY the cache had — coverage that survived a bad pull
    n_trades_recovered: int  # trades a live wallet gained back from its cached record


# ---------------------------------------------------------------------------
# Cache key + paths
# ---------------------------------------------------------------------------


def _wallets_file_digest(wallets_file: Path | str) -> str:
    """A short content digest of the tracked-wallets export — the cache's identity, not its path.

    Content-keyed on purpose: :func:`~oct_trading_agent.data.labeling.wallets_file.select_cohort`
    ranks by the balances *inside* the export, so a re-exported file with different balances selects
    a different cohort and must not read a cache built from the old one. An unreadable file falls
    back to hashing its path string — key derivation must never be the thing that raises here (the
    caller has already degraded on a genuinely unreadable export).
    """
    path = Path(wallets_file)
    try:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        digest = hashlib.sha256(str(path.resolve()).encode("utf-8", errors="replace")).hexdigest()
    return digest[:16]


def cohort_cache_path(
    cache_root: Path | str, wallets_file: Path | str, *, max_wallets: int, max_pages: int
) -> Path:
    """Where the resolved cohort for these pull parameters lives under ``cache_root``.

    Keyed by (export contents, cohort size, pages-per-wallet) because all three change what a pull
    would return: a bigger ``max_wallets`` selects more traders and a bigger ``max_pages`` reaches
    further back in each one's history. Sharing ``cache_root`` with the REST client's response cache
    is deliberate and collision-free — those files are bare ``<sha1>.json``, these are prefixed.
    """
    name = (
        f"{CACHE_FILE_PREFIX}{_wallets_file_digest(wallets_file)}"
        f"_{int(max_wallets)}_{int(max_pages)}.json"
    )
    return Path(cache_root) / name


# ---------------------------------------------------------------------------
# Save / load
# ---------------------------------------------------------------------------


def save_cohort(
    path: Path,
    wallets: Sequence[LabeledWallet],
    *,
    max_wallets: int,
    max_pages: int,
    saved_at: datetime | None = None,
) -> None:
    """Atomically persist a resolved cohort to ``path`` (temp file + rename).

    Serialisation is ``model_dump(mode="json")`` per wallet, so every ``Decimal`` becomes its exact
    decimal string and every timestamp its ISO-8601 form — :func:`load_cohort` reconstructs the same
    objects, not lossy approximations of them.
    """
    stamp = (saved_at or datetime.now(UTC)).isoformat()
    payload: dict[str, Any] = {
        "version": CACHE_FORMAT_VERSION,
        "saved_at": stamp,
        "max_wallets": int(max_wallets),
        "max_pages": int(max_pages),
        "n_wallets": len(wallets),
        "n_trades": sum(len(w.trades) for w in wallets),
        "wallets": [w.model_dump(mode="json") for w in wallets],
    }
    atomic_write_text(path, json.dumps(payload, indent=1, sort_keys=True))


def load_cohort(path: Path) -> CachedCohort:
    """Strictly read a cohort cache file. Raises :class:`CohortCacheError` on anything unusable.

    "Unusable" covers a missing/unreadable file, non-JSON contents, a version this build does not
    write, and rows that no longer validate against :class:`LabeledWallet` — all the ways a cache
    can rot. The launch path should call :func:`read_cohort_cache` instead, which degrades.
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise CohortCacheError(f"cannot read {path} ({type(exc).__name__}: {exc})") from exc
    try:
        payload = json.loads(raw)
    except ValueError as exc:  # JSONDecodeError subclasses ValueError
        raise CohortCacheError(f"{path} is not valid JSON ({exc})") from exc
    if not isinstance(payload, dict):
        raise CohortCacheError(f"{path} does not hold a cohort object")
    version = payload.get("version")
    if version != CACHE_FORMAT_VERSION:
        raise CohortCacheError(
            f"{path} has cache format version {version!r}, this build writes {CACHE_FORMAT_VERSION}"
        )
    rows = payload.get("wallets")
    if not isinstance(rows, list):
        raise CohortCacheError(f"{path} has no 'wallets' list")
    try:
        wallets = [LabeledWallet.model_validate(row) for row in rows]
    except Exception as exc:  # pydantic ValidationError + anything a malformed row can raise
        raise CohortCacheError(f"{path} holds rows that no longer validate ({exc})") from exc
    return CachedCohort(
        wallets=wallets,
        saved_at=str(payload.get("saved_at", "")),
        max_wallets=int(payload.get("max_wallets", 0) or 0),
        max_pages=int(payload.get("max_pages", 0) or 0),
    )


def read_cohort_cache(
    path: Path | None, *, log: Callable[[str], None] = lambda _m: None
) -> list[LabeledWallet]:
    """Launch-path read: the cached cohort, or ``[]`` with a loud line. **Never raises.**

    A cache is a speed-up over a reconstructible network pull, so no cache failure may abort a run —
    a missing file is silent (the first launch), and anything worse is announced and degraded to a
    live pull. ``UnicodeError`` is deliberately re-raised: that would be a *logging* bug, and a
    logging bug must never be mistaken for a data failure (the same rule the baseline degrade path
    in ``train_market`` follows).
    """
    if path is None or not path.exists():
        return []
    try:
        return load_cohort(path).wallets
    except UnicodeError:
        raise
    except Exception as exc:
        log(f"[cohort] cache unusable ({type(exc).__name__}: {exc}) — falling back to a live pull")
        return []


# ---------------------------------------------------------------------------
# The ratchet
# ---------------------------------------------------------------------------


def _trade_identity(trade: LabeledTrade) -> tuple[str, str, Side, Decimal, Decimal, datetime]:
    """A realized trade's identity for de-duplication across two pulls of the same history.

    Signature alone is not enough (one transaction can carry several swap legs) and is optional, so
    the key is signature *plus* the economically distinguishing fields. ``price`` is deliberately
    excluded: it is derivable from the two amounts, and one pull may have carried it while another
    left it to be derived — that must not make the same trade look like two.
    """
    return (
        trade.signature or "",
        trade.mint,
        trade.side,
        trade.base_amount,
        trade.quote_amount,
        trade.timestamp,
    )


def _union_trades(
    primary: Sequence[LabeledTrade], secondary: Sequence[LabeledTrade]
) -> list[LabeledTrade]:
    """Union two bounded windows of one wallet's history, keeping ``primary``'s copy of a duplicate.

    Re-sorted by ``(timestamp, signature)`` because the reconstruction downstream assumes trades
    arrive time-ordered, and a union of two newest-first windows is not.
    """
    seen = {_trade_identity(t) for t in primary}
    merged = list(primary)
    merged.extend(t for t in secondary if _trade_identity(t) not in seen)
    merged.sort(key=lambda t: (t.timestamp, t.signature or ""))
    return merged


def _union_labels(primary: Iterable[str], secondary: Iterable[str]) -> list[str]:
    out = list(primary)
    out.extend(label for label in secondary if label not in out)
    return out


def merge_cohorts(
    cached: Sequence[LabeledWallet], live: Sequence[LabeledWallet]
) -> CohortMergeResult:
    """Union a cached cohort with a fresh (possibly partial) pull — coverage only ever goes UP.

    Live wallets lead the result (they preserve the pull's balance-ranked order); wallets only the
    cache had follow, in cached order. Where both sides hold the same wallet, the live record wins
    on metadata and its trades are unioned with the cached ones — a rate-limited pull that reached
    fewer pages than a previous one therefore cannot silently shrink that trader's history.
    """
    by_address = {w.wallet: w for w in cached}
    merged: list[LabeledWallet] = []
    recovered = 0
    for wallet in live:
        previous = by_address.get(wallet.wallet)
        if previous is None:
            merged.append(wallet)
            continue
        trades = _union_trades(wallet.trades, previous.trades)
        recovered += len(trades) - len(wallet.trades)
        merged.append(
            wallet.model_copy(
                update={
                    "labels": _union_labels(wallet.labels, previous.labels),
                    "trades": trades,
                }
            )
        )
    live_addresses = {w.wallet for w in live}
    cache_only = [w for w in cached if w.wallet not in live_addresses]
    merged.extend(cache_only)
    return CohortMergeResult(
        wallets=merged,
        n_live=len(live),
        n_cache_only=len(cache_only),
        n_trades_recovered=recovered,
    )


__all__ = [
    "CACHE_FORMAT_VERSION",
    "CachedCohort",
    "CohortCacheError",
    "CohortMergeResult",
    "cohort_cache_path",
    "load_cohort",
    "merge_cohorts",
    "read_cohort_cache",
    "save_cohort",
]
