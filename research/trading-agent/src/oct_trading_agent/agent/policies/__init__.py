"""agent/policies — actor heads; the hybrid discrete-continuous action (paper §3.3).

Ships :class:`HoldPolicy`, a trivial baseline that always emits ``HOLD`` with zero size. It exists
to prove the Phase-0 vertical slice (feature bundle → typed decision) end-to-end; it is NOT a
learned policy. The real policy (hybrid discrete intent + continuous size head reading a
distributional critic) is Wave-1's job.

TODO(Wave-1: agent agent): implement the learned actor behind ``core.decision.Policy``.
"""

from __future__ import annotations

from oct_trading_agent.core import (
    AgentDecision,
    FeatureBundle,
    Intent,
    SignalContribution,
    ValueDistribution,
)

_HOLD_MODEL_ID = "stub.hold_policy.v0"


class HoldPolicy:
    """Baseline policy: always HOLD, zero size, minimal-conviction signal.

    Satisfies the :class:`~oct_trading_agent.core.decision.Policy` protocol. Emits a degenerate but
    VALID ``ValueDistribution`` (a point mass at 0) so the full typed decision composes for tests
    and wiring checks.
    """

    def decide(self, bundle: FeatureBundle) -> AgentDecision:
        return AgentDecision(
            mint=bundle.mint,
            intent=Intent.HOLD,
            size=0.0,
            value_distribution=ValueDistribution(
                representation="categorical", locations=[0.0], weights=[1.0]
            ),
            confidence=0.0,
            rationale_trace=[],
            signal_contribution=SignalContribution(model_id=_HOLD_MODEL_ID, score=0.0),
        )
