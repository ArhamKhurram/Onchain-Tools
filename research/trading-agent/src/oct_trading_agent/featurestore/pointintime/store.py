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

    def assemble(
        self,
        mint: Mint,
        as_of: datetime,
        tiers: frozenset[FeatureTier],
    ) -> FeatureBundle:
        """Reconstruct the requested tiers for ``mint`` as-of ``as_of``. No event after ``as_of``
        may influence any slot (enforced here AND re-checked inside each feature)."""
        # Firewall: mint-scope and time-clip once, up front. Features never see a future event.
        scoped: list[TapeEvent] = [
            e for e in self._tape if e.mint == mint and e.block_time <= as_of
        ]
        out: dict[FeatureTier, TierFeatures] = {}
        for tier in tiers:
            out[tier] = self._compute_tier(tier, scoped, as_of)
        return FeatureBundle(mint=mint, as_of=as_of, tiers=out)

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
