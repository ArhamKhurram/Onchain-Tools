"""eval/ablations — per-tier + leakage-guard + convergence A/B (paper §8.4; 03 §Phase 1/2).

    * per-tier      : with-vs-without each information tier — the curriculum as instrument.
    * leakage-guard : replace a tier with noise; performance MUST collapse to the no-information
                      prior. If it doesn't, the agent was exploiting leakage (a NO-GO).
    * convergence   : convergence-with-N vs convergence-without-N — the clean A/B for Model N's lift.

Phase 1 ships the leakage-guard: :func:`assert_raw_chart_causal` (the causal audit over the tier-A
features) and :class:`NoiseTierFeatureStore` / :func:`noise_ablation` (the "replace a tier with noise;
performance must collapse" scaffold). Per-tier and convergence ablations arrive with tiers B-E.
"""

from __future__ import annotations

from .leakage import (
    NoiseAblationStores,
    NoiseTierFeatureStore,
    assert_raw_chart_causal,
    noise_ablation,
)

__all__ = [
    "NoiseAblationStores",
    "NoiseTierFeatureStore",
    "assert_raw_chart_causal",
    "noise_ablation",
]
