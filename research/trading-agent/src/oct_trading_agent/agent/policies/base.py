"""The env-facing policy seam — ``EnvPolicy`` (observation → hybrid action).

The repo already has :class:`oct_trading_agent.core.decision.Policy` — the *OCT-facing* contract that
maps a :class:`~oct_trading_agent.core.features.FeatureBundle` to a rich, calibrated
:class:`~oct_trading_agent.core.decision.AgentDecision` for the convergence layer. That is the
product surface; it is not the RL-loop surface.

:class:`EnvPolicy` is the RL-loop surface: an :class:`~oct_trading_agent.agent.envs.Observation` in,
an :class:`~oct_trading_agent.agent.envs.EnvAction` out. This is the exact seam a learned actor
(IQL/CQL/PPO head) drops into — the environment and the eval runner accept any ``EnvPolicy``, so the
Phase-1 substrate is complete without the learner, and the learner replaces the random/baseline
policies without touching the env. :class:`CorePolicyAdapter` bridges the two worlds: it wraps a
``core.Policy`` (e.g. a trained Model N) as an ``EnvPolicy`` by reading the bundle carried on the
observation and translating the emitted decision's ``intent``/``size`` into an ``EnvAction``.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from oct_trading_agent.agent.envs import EnvAction, Observation
from oct_trading_agent.core import Policy as CorePolicy


@runtime_checkable
class EnvPolicy(Protocol):
    """A policy the environment/runner drives: observation → hybrid action.

    ``reset`` is called at episode start (stateful policies use it; stateless ones no-op). ``act``
    maps one observation to one :class:`~oct_trading_agent.agent.envs.EnvAction`.
    """

    def reset(self) -> None:
        """Reset any per-episode internal state."""
        ...

    def act(self, observation: Observation) -> EnvAction:
        """Map one observation to one hybrid action."""
        ...


class CorePolicyAdapter:
    """Adapt an OCT-facing ``core.Policy`` (bundle → AgentDecision) into an :class:`EnvPolicy`.

    The bridge a trained Model N crosses to be evaluated through the env: it reads the point-in-time
    bundle carried on the observation, asks the wrapped policy to ``decide``, and forwards the typed
    decision's ``intent``/``size`` as an :class:`EnvAction`.
    """

    def __init__(self, policy: CorePolicy) -> None:
        self._policy = policy

    def reset(self) -> None:
        return None

    def act(self, observation: Observation) -> EnvAction:
        decision = self._policy.decide(observation.bundle)
        return EnvAction(intent=decision.intent, size=decision.size)


__all__ = ["CorePolicyAdapter", "EnvPolicy"]
