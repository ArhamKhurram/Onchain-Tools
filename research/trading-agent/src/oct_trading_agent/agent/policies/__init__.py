"""agent/policies — actor heads; the hybrid discrete-continuous action (paper §3.3).

Two policy surfaces live here, deliberately distinct:

* **OCT-facing** (``core.decision.Policy``): a :class:`~oct_trading_agent.core.features.FeatureBundle`
  in, a rich :class:`~oct_trading_agent.core.decision.AgentDecision` out — the product/convergence
  contract. :class:`HoldPolicy` is the trivial stub for the Phase-0 vertical slice.
* **RL-loop-facing** (:class:`EnvPolicy`): an :class:`~oct_trading_agent.agent.envs.Observation` in,
  an :class:`~oct_trading_agent.agent.envs.EnvAction` out — the seam the Phase-1 environment and the
  eval runner accept. :class:`RandomPolicy` is the mandated random baseline; a learned actor
  (IQL/CQL/PPO) drops in here without touching the env. :class:`CorePolicyAdapter` bridges an
  OCT-facing policy into an ``EnvPolicy`` for evaluation.

Phase 1 lands the **learned actor** (:mod:`.torch_actor`): a shared-torso
:class:`HybridActorCritic` (categorical intent + Beta size + distributional quantile critic) and
:class:`TorchPolicy`, the :class:`EnvPolicy` adapter that drops the trained actor into the eval
runner unchanged. The torch pieces require the ``learn`` extra; :class:`TorchPolicy`/
:class:`ActorConfig` import in a lean install and raise only on construction.
"""

from __future__ import annotations

from oct_trading_agent.core import (
    AgentDecision,
    FeatureBundle,
    Intent,
    SignalContribution,
    ValueDistribution,
)

from .base import CorePolicyAdapter, EnvPolicy
from .random_policy import RandomPolicy
from .torch_actor import ActorConfig, TorchPolicy

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


__all__ = [
    "ActorConfig",
    "CorePolicyAdapter",
    "EnvPolicy",
    "HoldPolicy",
    "RandomPolicy",
    "TorchPolicy",
]
