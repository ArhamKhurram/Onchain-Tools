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

A FOURTH baseline is defined here for the operator's actual north-star bar — not "beat hold-SOL" but
**"out-trade the tracked traders themselves"**: :class:`CohortReplayPolicy` replays the tracked
traders' OWN realized actions on each held-out mint through the SAME env at the SAME costs, so the
learned agent is scored head-to-head against the cohort it is meant to beat (paper §8.2 per-token
edge, now against the cohort rather than a mechanical floor).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from oct_trading_agent.agent.envs import EnvAction, Observation
from oct_trading_agent.agent.imitation.demos import CohortAction
from oct_trading_agent.agent.policies import RandomPolicy
from oct_trading_agent.core import Intent, Mint


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


class CohortReplayPolicy:
    """Baseline: replay the tracked traders' OWN realized actions on each mint (the north-star bar).

    Constructed with the cohort's per-mint action tape
    (:func:`~oct_trading_agent.agent.imitation.demos.build_cohort_action_tape`), it runs the tracked
    traders as a single trader through the *same* :class:`~oct_trading_agent.agent.envs.TradingEnv` as
    the learned agent: at each env decision instant it FIRES the next tracked-trader decision whose
    timestamp has come due (the first env step at/after the trade happened), and emits a passive
    ``HOLD`` (when it holds a position) or ``NO_OP`` (when flat) in between. This makes the comparison
    apples-to-apples on *decisions* under identical execution and costs — not the traders' real
    on-chain fills, which no baseline could reproduce.

    A mint the cohort never traded yields all ``NO_OP``/``HOLD`` — the traders did not touch it, so the
    baseline does NOT fabricate a trade (it degenerates to hold-SOL on that token, honestly).

    Fairness note: the tape MUST be built from ONLY the held-out tokens' cohort trades (pass the test
    mints to the builder), so the baseline reflects what the cohort did on the exact tokens the agent
    is scored on — never train-token behaviour leaking into the test comparison.
    """

    def __init__(self, action_tape: Mapping[Mint, Sequence[CohortAction]]) -> None:
        self._tape = action_tape
        self._seq: Sequence[CohortAction] = ()
        self._cursor = 0
        self._started = False

    def reset(self) -> None:
        self._seq = ()
        self._cursor = 0
        self._started = False

    def act(self, observation: Observation) -> EnvAction:
        bundle = observation.bundle
        if not self._started:
            # The env drives one mint per episode; resolve its tape on the first observation.
            self._seq = self._tape.get(bundle.mint, ())
            self._cursor = 0
            self._started = True
        if self._cursor < len(self._seq) and self._seq[self._cursor].at <= bundle.as_of:
            action = self._seq[self._cursor].action
            self._cursor += 1
            return action
        # No cohort decision is due at this instant: hold if we hold, else stay in SOL.
        has_position = bool(observation.state[0] > 0.5)  # STATE_SLOTS[0] is has_position
        return EnvAction(intent=Intent.HOLD if has_position else Intent.NO_OP, size=0.0)


__all__ = ["BuyAndHoldPolicy", "CohortReplayPolicy", "HoldSolPolicy", "RandomPolicy"]
