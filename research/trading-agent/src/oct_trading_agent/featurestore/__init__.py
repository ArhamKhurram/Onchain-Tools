"""featurestore/ — the point-in-time feature store (02 §2 (2), §6).

Responsibility: reconstruct, for any ``(mint, as_of)``, exactly the features knowable at that
instant — no look-ahead — with EXPLICIT missingness and tier tags. This is the leakage firewall
(the ONLY place features are computed).

Subpackages:
    * pointintime  — as-of reconstruction + missingness encoding. Ships a tiny stub store today.
    * tiers        — the five tiers' feature computations (A raw-chart … E chatter).
    * leakage_audit — the standing causality test ("a feature that knows the future must fail").

Contracts (FeatureStore, PointInTimeFeature, LeakageAudit, Feature, FeatureBundle) live in
:mod:`oct_trading_agent.core.features`.

TODO(Wave-1: featurestore agent): implement per-tier PointInTimeFeature computations and the
LeakageAudit; replace the stub store below with a real point-in-time store over columnar storage.
"""

from __future__ import annotations

from .pointintime import StubTierAFeatureStore

__all__ = ["StubTierAFeatureStore"]
