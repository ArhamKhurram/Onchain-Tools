"""The point-in-time feature store — ``(mint, as_of, tiers) -> FeatureBundle`` (02 §2 (2), §6).

This is the leakage firewall: it reconstructs, for any ``(mint, as_of)``, exactly the tier features
knowable at that instant, with **explicit missingness** and no look-ahead. Two enforcement layers:

1. **The store** restricts the tape to the requested ``mint`` and to ``block_time <= as_of`` before
   handing anything to a feature — an operational guarantee that no future event is ever read.
2. **Each feature** re-applies the ``block_time <= as_of`` filter itself (see ``tiers/tier_a``), so
   causality is independently auditable at the feature boundary regardless of the store — this is
   what the standing leakage audit (``featurestore/leakage_audit``) certifies.

A tier the store has no registered features for (B-E today) appears **present-but-empty** — an
absent tier and a requested-but-empty tier are different states, and consumers must handle both
(see :meth:`FeatureBundle.get`).
"""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Mapping, Sequence
from datetime import datetime

from oct_trading_agent.core import (
    FeatureBundle,
    FeatureTier,
    Mint,
    PointInTimeFeature,
    TapeEvent,
    TierFeatures,
)
from oct_trading_agent.featurestore.tiers import default_tier_a_features

# Registry type: which PointInTimeFeatures compute each tier's slots.
FeatureRegistry = Mapping[FeatureTier, Sequence[PointInTimeFeature]]


def _default_registry() -> dict[FeatureTier, list[PointInTimeFeature]]:
    """Tier A is wired; B-E are present-but-empty until the curriculum unlocks them (paper §5)."""
    return {
        FeatureTier.A_RAW_CHART: default_tier_a_features(),
        FeatureTier.B_WALLET_FLOWS: [],
        FeatureTier.C_METADATA: [],
        FeatureTier.D_SOCIAL: [],
        FeatureTier.E_CHATTER: [],
    }


class PointInTimeFeatureStore:
    """Point-in-time store over an in-memory tape. Satisfies ``core.FeatureStore``.

    Constructed with the full (multi-mint, all-time) tape and an optional feature registry; defaults
    to the canonical Tier-A slot set. ``assemble`` mint-scopes and time-clips the tape, then runs each
    registered feature. Duplicate slot names within a tier collide loudly (a registry misconfiguration
    should fail, not silently drop a feature).
    """

    def __init__(
        self,
        tape: Sequence[TapeEvent],
        registry: FeatureRegistry | None = None,
    ) -> None:
        self._tape: list[TapeEvent] = list(tape)
        self._registry: dict[FeatureTier, list[PointInTimeFeature]] = (
            {tier: list(feats) for tier, feats in registry.items()}
            if registry is not None
            else _default_registry()
        )
        # Index once: mint -> its events sorted by block_time, plus the parallel key list
        # bisect needs. `assemble` used to re-walk the WHOLE multi-mint tape on every call,
        # which measured a FLAT ~300 us regardless of depth (at depth 50 that was 102% of
        # assemble's total time) purely because the scan never got smaller.
        #
        # Sort is stable, so events sharing a block_time keep tape order and the slice handed
        # to a feature is identical to what the linear filter produced.
        by_mint: dict[Mint, list[TapeEvent]] = {}
        for e in self._tape:
            by_mint.setdefault(e.mint, []).append(e)
        self._by_mint: dict[Mint, list[TapeEvent]] = {
            m: sorted(evs, key=lambda e: e.block_time) for m, evs in by_mint.items()
        }
        self._times: dict[Mint, list[datetime]] = {
            m: [e.block_time for e in evs] for m, evs in self._by_mint.items()
        }
        # One-entry bundle cache. TradingEnv.step calls _observe() twice, and `next_obs` at
        # step i resolves to the SAME (mint, as_of) as `pre_obs` at step i+1 — so consecutive
        # steps rebuilt an identical FeatureBundle. The surrounding Observation still differs
        # (position, balance, steps_elapsed_frac), so only the bundle is cacheable.
        self._cache_key: tuple[Mint, datetime, frozenset[FeatureTier]] | None = None
        self._cache_val: FeatureBundle | None = None

    def assemble(
        self,
        mint: Mint,
        as_of: datetime,
        tiers: frozenset[FeatureTier],
    ) -> FeatureBundle:
        """Reconstruct the requested tiers for ``mint`` as-of ``as_of``. No event after ``as_of``
        may influence any slot (enforced here AND re-checked inside each feature)."""
        key = (mint, as_of, tiers)
        if self._cache_key == key and self._cache_val is not None:
            return self._cache_val

        # Firewall unchanged in meaning: mint-scope and time-clip before any feature sees an
        # event. Only the mechanism changed — a dict lookup plus bisect_right on the sorted
        # block_times, instead of a linear scan of every event of every mint.
        events = self._by_mint.get(mint)
        if events is None:
            scoped: list[TapeEvent] = []
        else:
            hi = bisect_right(self._times[mint], as_of)
            scoped = events[:hi]

        out: dict[FeatureTier, TierFeatures] = {}
        for tier in tiers:
            out[tier] = self._compute_tier(tier, scoped, as_of)
        bundle = FeatureBundle(mint=mint, as_of=as_of, tiers=out)
        self._cache_key, self._cache_val = key, bundle
        return bundle

    def _compute_tier(
        self, tier: FeatureTier, scoped_tape: list[TapeEvent], as_of: datetime
    ) -> TierFeatures:
        slots: TierFeatures = {}
        for feature in self._registry.get(tier, ()):
            if feature.name in slots:
                raise ValueError(
                    f"duplicate feature slot {feature.name!r} registered for tier {tier}"
                )
            slots[feature.name] = feature.compute_as_of(scoped_tape, as_of)
        return slots


__all__ = ["FeatureRegistry", "PointInTimeFeatureStore"]
