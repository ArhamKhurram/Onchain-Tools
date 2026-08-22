"""convergence/ — the calibrated single-signal adapter for OCT (02 §2 (5); paper §4.3).

Responsibility: wrap the surviving policy population into ONE calibrated, independent signal for
OCT's convergence layer. It exposes a :class:`~oct_trading_agent.core.decision.SignalContribution`
(a calibrated [0,1] score) — never the underlying detections. Convergence fuses SCORES, never
detections (OCT's "signals stay independent" principle).

For the trade-flow attention signal specifically, the adapter must read the STOP-GRADIENT copy of
the attention state (paper §4.4 codependent training), not the policy-shaped representation, so the
shared signal stays flow-derived and mechanically independent.

TODO(Wave-2: convergence agent): implement calibration (e.g. isotonic/temperature) + the
ConvergenceAdapter that maps population outputs → a single SignalContribution.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from oct_trading_agent.core import AgentDecision, SignalContribution


@runtime_checkable
class ConvergenceAdapter(Protocol):
    """Maps the policy population's output to one calibrated, independent convergence signal."""

    def to_signal(self, decision: AgentDecision) -> SignalContribution:
        """Return the calibrated single signal for OCT's convergence layer (score-level only)."""
        ...
