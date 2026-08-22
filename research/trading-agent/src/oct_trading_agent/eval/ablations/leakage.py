"""Leakage-guard hook — wire the featurestore's causal audit + the noise-ablation for a training run.

Two guards, both required by Phase 1 (paper §5.6 gating (iii), §8.4 leakage-guard ablation; 03
§Phase 1):

1. **Causal audit** (:func:`assert_raw_chart_causal`) — the raw-chart tier must be *causal*: no
   feature may change when future events are appended at the same ``as_of``. This wraps the
   featurestore's standing :class:`~oct_trading_agent.featurestore.StandingLeakageAudit` over the
   real tier-A feature set (and confirms the deliberately-leaky canary fails), so a training run can
   call one function to certify the firewall on the actual tape it trains on.

2. **Noise ablation** (:class:`NoiseTierFeatureStore` + :func:`noise_ablation`) — the "a tier
   replaced by noise must collapse performance" guard. If a policy scores the same when the raw-chart
   tier is replaced by noise, it was not using the tier causally (or was exploiting leakage), and the
   apparent edge is spurious. This provides the *scaffolding* — the noised feature store and a paired
   real-vs-noised run — so a learned Phase-1 policy's edge can be asserted to collapse under noise.
   (For a random policy, performance is ~invariant to features by construction, so the meaningful
   assertion for the substrate is the causal audit; the noise ablation is the seam the learner uses.)
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from oct_trading_agent.core import (
    Feature,
    FeatureBundle,
    FeatureStatus,
    FeatureStore,
    FeatureTier,
    Mint,
    TapeEvent,
    TierFeatures,
)
from oct_trading_agent.featurestore import (
    PointInTimeFeatureStore,
    default_tier_a_features,
)
from oct_trading_agent.featurestore.leakage_audit import (
    NextTradePriceLeak,
    assert_no_leaks,
    run_standing_audit,
)


def _split_past_future(
    tape: list[TapeEvent], as_of: datetime
) -> tuple[list[TapeEvent], list[TapeEvent]]:
    past = [e for e in tape if e.block_time <= as_of]
    future = [e for e in tape if e.block_time > as_of]
    return past, future


def assert_raw_chart_causal(tape: list[TapeEvent], as_of: datetime) -> None:
    """Certify the tier-A feature set is causal on ``tape`` at ``as_of`` (and the canary leaks).

    Runs the standing audit over :func:`default_tier_a_features` (all must pass — appending future
    events changes nothing) and over the deliberately-leaky :class:`NextTradePriceLeak` (which must
    FAIL — proving the audit actually bites). Raises ``AssertionError`` on any real-feature leak or
    if the canary fails to trip.
    """
    past, future = _split_past_future(tape, as_of)
    if not future:
        raise ValueError("need at least one event strictly after as_of to make the audit non-vacuous")

    results = run_standing_audit(list(default_tier_a_features()), past, future, as_of)
    assert_no_leaks(results)  # raises naming any leaky real feature

    canary = run_standing_audit([NextTradePriceLeak()], past, future, as_of)
    if all(r.passed for r in canary):
        raise AssertionError(
            "leakage canary did not trip — the audit is not biting; refusing to certify causality"
        )


class NoiseTierFeatureStore:
    """Wrap a :class:`FeatureStore`, replacing one tier's OBSERVED numeric values with noise.

    Missingness is preserved exactly (a missing slot stays missing — we only corrupt *observed*
    values), so the ablation isolates "the observed signal is destroyed" from "the data is present".
    Noise is deterministic per ``(mint, as_of, slot)`` so repeated assembles are reproducible (the env
    and the audit both require determinism). This is the leakage-guard's noised store: a policy whose
    performance survives it was not using the tier's signal.
    """

    def __init__(
        self,
        base: FeatureStore,
        target_tier: FeatureTier = FeatureTier.A_RAW_CHART,
        *,
        seed: int = 0,
        scale: float = 1.0,
    ) -> None:
        self._base = base
        self._tier = target_tier
        self._seed = seed
        self._scale = scale

    def _noise(self, mint: Mint, as_of: datetime, slot: str) -> float:
        key = f"{self._seed}|{mint}|{as_of.isoformat()}|{slot}".encode()
        digest = hashlib.sha256(key).digest()
        # Map 8 bytes to a uniform in [-1, 1], then scale — deterministic, no RNG state.
        raw = int.from_bytes(digest[:8], "big") / float(1 << 64)
        return float((raw * 2.0 - 1.0) * self._scale)

    def assemble(
        self, mint: Mint, as_of: datetime, tiers: frozenset[FeatureTier]
    ) -> FeatureBundle:
        bundle = self._base.assemble(mint, as_of, tiers)
        if self._tier not in bundle.tiers:
            return bundle
        corrupted: TierFeatures = {}
        for name, feat in bundle.tiers[self._tier].items():
            if feat.observed and isinstance(feat.value, (int, float)) and not isinstance(
                feat.value, bool
            ):
                corrupted[name] = Feature(
                    value=self._noise(mint, as_of, name),
                    status=FeatureStatus.OBSERVED,
                    as_of=feat.as_of,
                )
            else:
                corrupted[name] = feat
        new_tiers = dict(bundle.tiers)
        new_tiers[self._tier] = corrupted
        return FeatureBundle(mint=mint, as_of=as_of, tiers=new_tiers)


@dataclass(frozen=True)
class NoiseAblationStores:
    """A paired (real, noised) feature-store set for the leakage-guard ablation."""

    real: FeatureStore
    noised: NoiseTierFeatureStore


def noise_ablation(
    tape: Sequence[TapeEvent],
    *,
    target_tier: FeatureTier = FeatureTier.A_RAW_CHART,
    seed: int = 0,
) -> NoiseAblationStores:
    """Build the (real, noised) stores over ``tape`` for a real-vs-noised policy comparison.

    The caller builds two envs — one with ``.real``, one with ``.noised`` — runs the *same* policy
    through both, and asserts the noised performance collapses toward the prior tier (§8.4). For a
    learned raw-chart policy this is the causal-use guarantee; the substrate ships the mechanism.
    """
    real = PointInTimeFeatureStore(list(tape))
    noised = NoiseTierFeatureStore(
        PointInTimeFeatureStore(list(tape)), target_tier, seed=seed
    )
    return NoiseAblationStores(real=real, noised=noised)


# NoiseTierFeatureStore must structurally satisfy the FeatureStore protocol (static + import-time check).
_STORE_CONFORMANCE: FeatureStore = NoiseTierFeatureStore(PointInTimeFeatureStore([]))


__all__ = [
    "NoiseAblationStores",
    "NoiseTierFeatureStore",
    "assert_raw_chart_causal",
    "noise_ablation",
]
