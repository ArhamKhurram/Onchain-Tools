"""featurestore/leakage_audit — the standing causality test (02 §2 (2), §6; paper §7).

The one assertion this module exists to make: **a feature that knows the future must fail the
audit.** For a :class:`~oct_trading_agent.core.features.PointInTimeFeature`, run ``compute_as_of``
twice — once on the real past, once on the past PLUS injected future events — and assert the output
is identical. A leaky feature changes under appended future events and fails.

This is a first-class, always-on test (03 §Phase 1/2 leakage-guard ablation), not a one-off.

Public surface:
    * :class:`StandingLeakageAudit` — the audit (satisfies ``core.LeakageAudit``).
    * :func:`run_standing_audit` / :func:`assert_no_leaks` — run it over a feature set and fail loudly.
    * :class:`NextTradePriceLeak` — a deliberately leaky feature the audit must catch (the canary).
"""

from __future__ import annotations

from .audit import StandingLeakageAudit
from .examples import NextTradePriceLeak, assert_no_leaks, run_standing_audit

__all__ = [
    "NextTradePriceLeak",
    "StandingLeakageAudit",
    "assert_no_leaks",
    "run_standing_audit",
]
