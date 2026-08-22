"""featurestore/ — the point-in-time feature store (02 §2 (2), §6).

Responsibility: reconstruct, for any ``(mint, as_of)``, exactly the features knowable at that
instant — no look-ahead — with EXPLICIT missingness and tier tags. This is the leakage firewall
(the ONLY place features are computed).

Subpackages:
    * pointintime  — as-of reconstruction + missingness encoding. Ships :class:`PointInTimeFeatureStore`
                     (the real store) plus the retained :class:`StubTierAFeatureStore` wiring stub.
    * tiers        — the five tiers' feature computations. Tier A ("naked chart") is implemented;
                     B-E are present-but-empty registries gated on the curriculum.
    * leakage_audit — the standing causality test ("a feature that knows the future must fail").

Contracts (FeatureStore, PointInTimeFeature, LeakageAudit, Feature, FeatureBundle) live in
:mod:`oct_trading_agent.core.features`.

TODO(Wave-2: featurestore agent): implement Tier B-E PointInTimeFeature computations behind the
curriculum gate; back the store with columnar, time-partitioned storage for scale.
"""

from __future__ import annotations

from .leakage_audit import (
    NextTradePriceLeak,
    StandingLeakageAudit,
    assert_no_leaks,
    run_standing_audit,
)
from .pointintime import PointInTimeFeatureStore, StubTierAFeatureStore
from .tiers import default_tier_a_features

__all__ = [
    "NextTradePriceLeak",
    "PointInTimeFeatureStore",
    "StandingLeakageAudit",
    "StubTierAFeatureStore",
    "assert_no_leaks",
    "default_tier_a_features",
    "run_standing_audit",
]
