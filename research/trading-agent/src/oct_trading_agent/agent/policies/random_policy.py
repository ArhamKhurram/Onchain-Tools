"""``RandomPolicy`` — the uniform-random baseline actor (paper §8 baselines).

A reproducible random policy over the §3.3 hybrid action: it draws a discrete intent (uniformly, or
from an optional weighting) and a continuous size in ``[0, 1]``. It is one of the three mandated
baselines (§8.3) and, run through the same env as every other policy, it establishes the
"no-skill, full-cost" floor a learned policy must clear after realistic costs. All randomness comes
from an injected/seeded ``numpy`` Generator so a reported baseline is exactly reproducible.

It is deliberately *not* state-aware — a random policy has no business knowing whether it holds — so
the sim tolerates any intent in any state (a sell when flat is a no-op; a buy when held adds). That
tolerance is the point: the baseline exercises the full action surface honestly.
"""

from __future__ import annotations

import numpy as np

from oct_trading_agent.agent.envs import EnvAction, Observation
from oct_trading_agent.agent.envs.action import INTENT_ORDER


class RandomPolicy:
    """Uniform-random hybrid actor. Satisfies :class:`~oct_trading_agent.agent.policies.EnvPolicy`.

    ``intent_weights`` (optional) biases the discrete draw — e.g. to make the baseline trade more
    often for a livelier proof — but defaults to uniform over all six intents. ``seed`` fixes the
    stream.
    """

    def __init__(
        self,
        *,
        seed: int = 0,
        intent_weights: tuple[float, ...] | None = None,
        max_size: float = 1.0,
    ) -> None:
        self._rng = np.random.default_rng(seed)
        self._seed = seed
        if not 0.0 < max_size <= 1.0:
            raise ValueError("max_size must be in (0, 1]")
        self._max_size = max_size
        if intent_weights is not None:
            if len(intent_weights) != len(INTENT_ORDER):
                raise ValueError(f"intent_weights must have {len(INTENT_ORDER)} entries")
            if any(w < 0 for w in intent_weights) or sum(intent_weights) <= 0:
                raise ValueError("intent_weights must be non-negative and sum to > 0")
            total = sum(intent_weights)
            self._probs: np.ndarray | None = np.array(
                [w / total for w in intent_weights], dtype=np.float64
            )
        else:
            self._probs = None

    def reset(self) -> None:
        # Re-seed so each episode's random stream is reproducible and independent of ordering.
        self._rng = np.random.default_rng(self._seed)

    def act(self, observation: Observation) -> EnvAction:
        idx = int(self._rng.choice(len(INTENT_ORDER), p=self._probs))
        size = float(self._rng.random()) * self._max_size
        return EnvAction(intent=INTENT_ORDER[idx], size=size)


__all__ = ["RandomPolicy"]
