"""Tier B — wallet-flow features. First implemented slot: smart-wallet co-occurrence.

Spec: [`09-cooccurrence-feature.md`](../../../../09-cooccurrence-feature.md). Empirical basis:
PROGRESS 2026-08-28 (iv) — out of sample, the count of *ranked* wallets buying a token early
separates its >10x rate from 0.003 to 0.423. This turns the earliness *wallet* ranking into a
*token* signal, and unlike earliness it needs no hindsight about the quantity: "how many known-good
wallets have bought this by now" is knowable at any instant from the tape alone.

Two things make it Tier B, not Tier A:

* It reads ``SwapEvent.signer`` — *who* trades — which Tier A deliberately never resolves.
* It depends on a **roster** of "smart" wallets. That roster is the leakage surface, and it is the
  reason this feature is dependency-injected rather than self-contained:

  - **Surface (a) — roster recency.** ``RosterProvider.as_of(t)`` must return only wallets rankable
    from history strictly before ``t``. :class:`WalkForwardRosterProvider` enforces this selection;
    :class:`StaticRosterProvider` deliberately does **not** and is a dev/test scaffold only.
  - **Surface (b) — roster label.** The census "smart" label the study used ranks by a *hindsight
    peak* (04 LEAKAGE RULE forbids that in an observation). A point-in-time re-derivation is a
    precondition for admitting this feature to the live observation vector (09 §8) — it is *not*
    enforced here, because this layer only computes the intersection; the provider owns the label.

Causal by construction, like every Tier-A feature: ``compute_as_of`` re-filters the tape to
``block_time <= as_of`` itself, so appending future swaps cannot change any value (the standing
leakage audit's invariant). Missingness is explicit, never a silent zero — a token with buyers but
*no* roster wallet among them emits an OBSERVED ``0`` (the study's "0 smart buyers" band), which is
distinct from a token too young to have any swap yet (NOT_YET_AVAILABLE).

Wiring: the default store keeps Tier B present-but-empty (no roster in scope). A caller with a
roster registers the features explicitly::

    registry = {FeatureTier.A_RAW_CHART: default_tier_a_features(),
                FeatureTier.B_WALLET_FLOWS: smart_wallet_features(roster), ...}
    store = PointInTimeFeatureStore(tape, registry)

which is exactly the curriculum unlock the store's empty-tier gate anticipates.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, runtime_checkable

from oct_trading_agent.core import (
    Feature,
    FeatureStatus,
    FeatureTier,
    FeatureValue,
    PointInTimeFeature,
    Side,
    SwapEvent,
    TapeEvent,
    Wallet,
)

_TIER = FeatureTier.B_WALLET_FLOWS


# ---------------------------------------------------------------------------
# Roster — the future-blind set of "smart" wallets, injected into every feature.
# ---------------------------------------------------------------------------


@runtime_checkable
class RosterProvider(Protocol):
    """Returns the set of wallets considered "smart" *as of* ``t``.

    The contract is a leakage contract: ``as_of(t)`` must be reconstructable from information
    available strictly before ``t``. A provider that returns a wallet whose "smart" status was only
    knowable after ``t`` leaks the future into the feature, however causal the swap tape itself is.
    """

    def as_of(self, t: datetime) -> frozenset[Wallet]: ...


@dataclass(frozen=True, slots=True)
class StaticRosterProvider:
    """A constant roster for every instant.

    **Not point-in-time.** The roster does not change with ``as_of``, so it silently backdates any
    wallet whose "smart" status was only knowable later (leakage surface (a)). Use ONLY as a
    dev/test scaffold or where the roster is genuinely fixed and pre-dates the whole evaluation
    window. A live feature must use :class:`WalkForwardRosterProvider`.
    """

    wallets: frozenset[Wallet]

    def as_of(self, t: datetime) -> frozenset[Wallet]:
        return self.wallets


@dataclass(frozen=True, slots=True)
class WalkForwardRosterProvider:
    """Point-in-time-safe roster (leakage surface (a)).

    A time-ordered tuple of ``(effective_from, roster)`` snapshots. ``as_of(t)`` returns the latest
    snapshot whose ``effective_from <= t``, or the empty set before the first — so a wallet only
    enters the roster at the instant its snapshot takes effect, never retroactively. This class
    enforces the walk-forward *selection*; each snapshot must itself have been ranked only from data
    before its ``effective_from`` (surface (b)), which the constructor cannot check and the caller
    must guarantee.
    """

    snapshots: tuple[tuple[datetime, frozenset[Wallet]], ...]

    def __post_init__(self) -> None:
        times = [t for t, _ in self.snapshots]
        if times != sorted(times):
            raise ValueError(
                "WalkForwardRosterProvider snapshots must be sorted by effective_from ascending"
            )

    def as_of(self, t: datetime) -> frozenset[Wallet]:
        chosen: frozenset[Wallet] = frozenset()
        for effective_from, roster in self.snapshots:
            if effective_from <= t:
                chosen = roster
            else:
                break
        return chosen


# ---------------------------------------------------------------------------
# Feature helpers — mirror tier_a's causal filter + explicit-missingness constructors.
# ---------------------------------------------------------------------------


def _swaps_at_or_before(tape: list[TapeEvent], as_of: datetime) -> list[SwapEvent]:
    """Swaps with ``block_time <= as_of``, slot-ordered. The causal firewall, re-applied here so a
    feature can never read the future by trusting the caller to have pre-clipped."""
    kept = [e for e in tape if isinstance(e, SwapEvent) and e.block_time <= as_of]
    kept.sort(key=lambda e: (e.slot, e.block_time))
    return kept


def _observed(value: FeatureValue, as_of: datetime) -> Feature[FeatureValue]:
    return Feature(value=value, status=FeatureStatus.OBSERVED, as_of=as_of)


def _missing(status: FeatureStatus, as_of: datetime) -> Feature[FeatureValue]:
    return Feature(value=None, status=status, as_of=as_of)


# ---------------------------------------------------------------------------
# Features. Roster-dependent, so `roster` is the first (undefaulted) field; name/tier follow with
# defaults, matching the tier_a slotted-dataclass shape. Each satisfies core.PointInTimeFeature.
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class SmartWalletCount:
    """Distinct roster wallets that have **bought** this mint at/before ``as_of``.

    The token-level co-occurrence signal (PROGRESS iv). BUY-only (accumulation, not churn),
    distinct (a wallet counts once however often it bought). NOT_YET_AVAILABLE before the first swap
    ever; an OBSERVED ``0`` once the token is live but no roster wallet has bought — a *measured*
    zero, the study's "0 smart buyers" band, never imputed.
    """

    roster: RosterProvider
    name: str = "smart_wallet_count"
    tier: FeatureTier = _TIER

    def compute_as_of(self, tape: list[TapeEvent], as_of: datetime) -> Feature[FeatureValue]:
        swaps = _swaps_at_or_before(tape, as_of)
        if not swaps:
            return _missing(FeatureStatus.MISSING_NOT_YET_AVAILABLE, as_of)
        buyers = {e.signer for e in swaps if e.side is Side.BUY}
        smart = buyers & self.roster.as_of(as_of)
        return _observed(len(smart), swaps[-1].block_time)


@dataclass(slots=True)
class SmartWalletShare:
    """Roster share of a token's distinct buyers so far: ``smart_buyers / distinct_buyers``.

    Carries the crowd-size control (PROGRESS iv showed wallet-quality and crowd-size are separate,
    additive effects). Range ``[0, 1]``. NOT_YET_AVAILABLE before the first swap; NOT_APPLICABLE
    when swaps exist but there are zero *buyers* yet (share is 0/0 undefined).
    """

    roster: RosterProvider
    name: str = "smart_wallet_share"
    tier: FeatureTier = _TIER

    def compute_as_of(self, tape: list[TapeEvent], as_of: datetime) -> Feature[FeatureValue]:
        swaps = _swaps_at_or_before(tape, as_of)
        if not swaps:
            return _missing(FeatureStatus.MISSING_NOT_YET_AVAILABLE, as_of)
        buyers = {e.signer for e in swaps if e.side is Side.BUY}
        if not buyers:
            return _missing(FeatureStatus.MISSING_NOT_APPLICABLE, swaps[-1].block_time)
        smart = buyers & self.roster.as_of(as_of)
        return _observed(len(smart) / len(buyers), swaps[-1].block_time)


def smart_wallet_features(roster: RosterProvider) -> list[PointInTimeFeature]:
    """The co-occurrence slot set the store registers under Tier B once a roster is in scope.

    Both slots share the injected roster. Until a caller supplies one, the store's Tier B stays
    present-but-empty (an absent roster is a source gap, not a zero) — the curriculum-unlock gate
    the store already models.
    """
    return [SmartWalletCount(roster), SmartWalletShare(roster)]


__all__ = [
    "RosterProvider",
    "SmartWalletCount",
    "SmartWalletShare",
    "StaticRosterProvider",
    "WalkForwardRosterProvider",
    "smart_wallet_features",
]
