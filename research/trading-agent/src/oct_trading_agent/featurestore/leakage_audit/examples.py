"""Reference features + a standing-audit runner for the leakage firewall.

* :class:`NextTradePriceLeak` — a **deliberately leaky** feature that peeks at the *first swap
  strictly after* ``as_of``. It exists to prove the audit bites: on the past alone it is missing,
  but append a future swap and it reports that future price — exactly the divergence
  :class:`~oct_trading_agent.core.features.LeakageAudit` must catch.
* :func:`run_standing_audit` — audits a list of features against a past/future tape split and
  returns every :class:`~oct_trading_agent.core.features.LeakageAuditResult`. The Tier-A set
  (:func:`~oct_trading_agent.featurestore.tiers.default_tier_a_features`) must pass all of them;
  :class:`NextTradePriceLeak` must fail. This is the always-on guard, not a one-off.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from oct_trading_agent.core import (
    Feature,
    FeatureStatus,
    FeatureTier,
    FeatureValue,
    LeakageAuditResult,
    PointInTimeFeature,
    SwapEvent,
    TapeEvent,
)

from .audit import StandingLeakageAudit


@dataclass(slots=True)
class NextTradePriceLeak:
    """LEAKY BY DESIGN — do not register. Peeks at the first swap AFTER ``as_of``.

    Uses ``block_time > as_of`` (the future), so appending a future swap changes its output from
    missing to that swap's price. The standing audit MUST flag this feature as failing; it is the
    canary that proves the firewall is live.
    """

    name: str = "next_trade_price_leak"
    tier: FeatureTier = FeatureTier.A_RAW_CHART

    def compute_as_of(self, tape: list[TapeEvent], as_of: datetime) -> Feature[FeatureValue]:
        future = sorted(
            (e for e in tape if isinstance(e, SwapEvent) and e.block_time > as_of),
            key=lambda e: (e.slot, e.block_time),
        )
        for swap in future:
            if swap.price is not None:
                return Feature(
                    value=float(swap.price),
                    status=FeatureStatus.OBSERVED,
                    as_of=swap.block_time,  # itself a giveaway: an as_of stamped in the future
                )
        return Feature(value=None, status=FeatureStatus.MISSING_NOT_YET_AVAILABLE, as_of=as_of)


def run_standing_audit(
    features: Sequence[PointInTimeFeature],
    tape_past: list[TapeEvent],
    tape_future: list[TapeEvent],
    as_of: datetime,
) -> list[LeakageAuditResult]:
    """Audit every feature in ``features`` and return their results (order preserved)."""
    audit = StandingLeakageAudit()
    return [audit.audit(f, tape_past, tape_future, as_of) for f in features]


def assert_no_leaks(results: Sequence[LeakageAuditResult]) -> None:
    """Raise ``AssertionError`` naming any feature that failed the audit. For CI wiring."""
    failures = [r for r in results if not r.passed]
    if failures:
        lines = "\n".join(f"  - {r.feature_name} ({r.tier}): {r.detail}" for r in failures)
        raise AssertionError(f"leakage audit failed for {len(failures)} feature(s):\n{lines}")


__all__ = ["NextTradePriceLeak", "assert_no_leaks", "run_standing_audit"]
