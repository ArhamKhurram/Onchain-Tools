"""The three mandated baselines (paper §3.5 no-trade note, §8.3): hold-SOL, buy-and-hold, random.

Each is an :class:`~oct_trading_agent.agent.policies.EnvPolicy` run through the *same*
:class:`~oct_trading_agent.agent.envs.TradingEnv` as any learned policy, so the comparison is honest
and after identical costs. Their roles:

* **Hold-SOL** (:class:`HoldSolPolicy`) — never enters; stays in SOL. The "doing nothing is a
  legitimate and often-correct action" floor (§3.5 no-trade note). A learned policy that cannot beat
  hold-SOL after costs has found nothing.
* **Buy-and-hold** (:class:`BuyAndHoldPolicy`) — buys once at the first decision instant and holds;
  the env's forced end-of-episode liquidation realizes it. This measures the token's own net move
  after realistic costs — the second baseline §8.3 demands so a strategy is not merely riding beta.
* **Random** (:class:`~oct_trading_agent.agent.policies.RandomPolicy`, re-exported) — the no-skill,
  full-cost floor.

The random policy lives in ``agent/policies`` (the actor package); it is re-exported here so the
three baselines are importable from one place.
"""

from __future__ import annotations

from oct_trading_agent.agent.envs import EnvAction, Observation
from oct_trading_agent.agent.policies import RandomPolicy
from oct_trading_agent.core import Intent


class HoldSolPolicy:
    """Baseline: never trade — hold SOL for the whole episode. Emits ``NO_OP`` every step."""

    def reset(self) -> None:
        return None

    def act(self, observation: Observation) -> EnvAction:
        return EnvAction(intent=Intent.NO_OP, size=0.0)


class BuyAndHoldPolicy:
    """Baseline: buy once at the first decision instant, then hold to the episode's end.

    The env's forced-liquidation-on-truncation (``TradingEnv``) closes the position at the terminal
    instant, so the realized PnL is the token's net move over the episode, after the buy's and the
    final sell's realistic costs. ``size`` is the fraction of the risk budget to deploy on entry.
    """

    def __init__(self, size: float = 1.0) -> None:
        if not 0.0 < size <= 1.0:
            raise ValueError("size must be in (0, 1]")
        self._size = size
        self._entered = False

    def reset(self) -> None:
        self._entered = False

    def act(self, observation: Observation) -> EnvAction:
        if not self._entered:
            self._entered = True
            return EnvAction(intent=Intent.OPEN_LONG, size=self._size)
        return EnvAction(intent=Intent.HOLD, size=0.0)


__all__ = ["BuyAndHoldPolicy", "HoldSolPolicy", "RandomPolicy"]
