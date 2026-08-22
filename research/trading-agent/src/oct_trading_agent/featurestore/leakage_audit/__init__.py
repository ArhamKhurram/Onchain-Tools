"""featurestore/leakage_audit — the standing causality test (02 §2 (2), §6; paper §7).

The one assertion this module exists to make: **a feature that knows the future must fail the
audit.** For a :class:`~oct_trading_agent.core.features.PointInTimeFeature`, run ``compute_as_of``
twice — once on the real past, once on the past PLUS injected future events — and assert the output
is identical. A leaky feature changes under appended future events and fails.

This is a first-class, always-on test (03 §Phase 1/2 leakage-guard ablation), not a one-off.

TODO(Wave-1: featurestore agent): implement ``LeakageAudit`` (see core.features) and wire it into
the standing test suite so every registered feature is audited on every run.
"""

from __future__ import annotations


def audit_feature_is_causal() -> None:
    """Placeholder for the standing audit runner.

    TODO(Wave-1): implement per core.features.LeakageAudit — invariance under appended future events.
    """
    raise NotImplementedError("Wave-1: featurestore agent owns the leakage audit implementation")
