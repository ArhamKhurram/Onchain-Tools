"""The standing leakage audit — the causality firewall's certification test (02 §6; paper §7).

One assertion, made airtight: **a feature that knows the future must fail.** For a
:class:`~oct_trading_agent.core.features.PointInTimeFeature`, :meth:`StandingLeakageAudit.audit`
runs ``compute_as_of`` twice at the *same* ``as_of`` —

    * once on the real past (``tape_past``), and
    * once on the past PLUS injected future events (``tape_past + tape_future``)

— and asserts the two :class:`Feature` outputs are **identical** in value, status, *and* the
feature's own ``as_of`` stamp. A causal feature ignores anything after ``as_of``, so appending
future events changes nothing and it PASSES; a leaky feature reads the appended future and its
output moves, so it FAILS.

Airtightness guards:

* **Injected events must genuinely be in the future.** Every event in ``tape_future`` must have
  ``block_time > as_of``; otherwise the "future" injection is not future at all and the test is
  vacuous. A violation raises ``ValueError`` rather than silently passing.
* **The past is passed by copy.** ``compute_as_of`` receives a fresh list each call, so a feature
  that mutates its input can't corrupt the comparison.
* **Full-output equality.** Value, status, and ``as_of`` are all compared — a leak that changes only
  the provenance stamp (not the value) is still caught.
"""

from __future__ import annotations

from datetime import datetime

from oct_trading_agent.core import (
    Feature,
    FeatureValue,
    LeakageAuditResult,
    PointInTimeFeature,
    TapeEvent,
)


def _features_identical(a: Feature[FeatureValue], b: Feature[FeatureValue]) -> bool:
    """Byte-for-byte identity of the two outputs: value, status, and provenance ``as_of``."""
    return a.value == b.value and a.status == b.status and a.as_of == b.as_of


def _describe(a: Feature[FeatureValue], b: Feature[FeatureValue]) -> str:
    return (
        f"output changed when future events were appended: "
        f"past=(value={a.value!r}, status={a.status}, as_of={a.as_of.isoformat()}) "
        f"vs with-future=(value={b.value!r}, status={b.status}, as_of={b.as_of.isoformat()})"
    )


class StandingLeakageAudit:
    """Standing causality test. Satisfies ``core.LeakageAudit``.

    Stateless — construct once and audit any number of features. Meant to run on *every* registered
    feature on *every* CI run (03 §Phase 1/2 leakage-guard), not as a one-off.
    """

    def audit(
        self,
        feature: PointInTimeFeature,
        tape_past: list[TapeEvent],
        tape_future: list[TapeEvent],
        as_of: datetime,
    ) -> LeakageAuditResult:
        """Assert ``feature.compute_as_of`` is invariant to appending ``tape_future`` at ``as_of``."""
        offenders = [e for e in tape_future if e.block_time <= as_of]
        if offenders:
            raise ValueError(
                f"tape_future must contain only events strictly after as_of={as_of.isoformat()}; "
                f"{len(offenders)} injected event(s) are at/before it, making the audit vacuous"
            )

        out_past = feature.compute_as_of(list(tape_past), as_of)
        out_with_future = feature.compute_as_of(list(tape_past) + list(tape_future), as_of)

        if _features_identical(out_past, out_with_future):
            return LeakageAuditResult(
                feature_name=feature.name,
                tier=feature.tier,
                passed=True,
                detail=None,
            )
        return LeakageAuditResult(
            feature_name=feature.name,
            tier=feature.tier,
            passed=False,
            detail=_describe(out_past, out_with_future),
        )


__all__ = ["StandingLeakageAudit"]
