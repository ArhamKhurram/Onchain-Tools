"""featurestore/pointintime — as-of reconstruction with explicit missingness.

Ships :class:`StubTierAFeatureStore`, a deliberately tiny, correct point-in-time store used by the
Phase-0 vertical slice to prove the wiring (tape → feature bundle → policy). It computes a couple
of Tier-A ("naked chart") features from the swap tape restricted to ``block_time <= as_of``, and
marks everything it cannot compute as explicitly MISSING (never imputed).

It is a reference for the CAUSAL contract, not the real store: the real point-in-time store (over
columnar storage, all five tiers, with the standing leakage audit) is Wave-1's job.

TODO(Wave-1: featurestore agent): replace this with the real store; keep the causality invariant
(no event with ``block_time > as_of`` may ever influence a feature).
"""

from __future__ import annotations

from datetime import datetime

from oct_trading_agent.core import (
    Feature,
    FeatureBundle,
    FeatureStatus,
    FeatureTier,
    FeatureValue,
    Mint,
    SwapEvent,
    TapeEvent,
    TierFeatures,
)


class StubTierAFeatureStore:
    """A minimal point-in-time store over an in-memory tape. Tier A only.

    Satisfies the :class:`~oct_trading_agent.core.features.FeatureStore` protocol. Constructed with
    the full tape; ``assemble`` filters to ``block_time <= as_of`` so no future event leaks in.
    """

    def __init__(self, tape: list[TapeEvent]) -> None:
        self._tape = tape

    def assemble(
        self,
        mint: Mint,
        as_of: datetime,
        tiers: frozenset[FeatureTier],
    ) -> FeatureBundle:
        out: dict[FeatureTier, TierFeatures] = {}
        if FeatureTier.A_RAW_CHART in tiers:
            out[FeatureTier.A_RAW_CHART] = self._tier_a(mint, as_of)
        # Any other requested tier is present-but-all-missing in this stub (explicit, not imputed).
        for tier in tiers - {FeatureTier.A_RAW_CHART}:
            out[tier] = {}
        return FeatureBundle(mint=mint, as_of=as_of, tiers=out)

    def _tier_a(self, mint: Mint, as_of: datetime) -> TierFeatures:
        swaps = [
            e
            for e in self._tape
            if isinstance(e, SwapEvent) and e.mint == mint and e.block_time <= as_of
        ]
        if not swaps:
            return {
                "price": self._missing(as_of),
                "trade_count": self._missing(as_of),
            }
        swaps.sort(key=lambda e: e.slot)
        last = swaps[-1]
        price: Feature[FeatureValue] = (
            Feature(value=float(last.price), status=FeatureStatus.OBSERVED, as_of=last.block_time)
            if last.price is not None
            else self._missing(as_of)
        )
        trade_count: Feature[FeatureValue] = Feature(
            value=len(swaps), status=FeatureStatus.OBSERVED, as_of=last.block_time
        )
        return {"price": price, "trade_count": trade_count}

    @staticmethod
    def _missing(as_of: datetime) -> Feature[FeatureValue]:
        return Feature(
            value=None, status=FeatureStatus.MISSING_NOT_YET_AVAILABLE, as_of=as_of
        )
