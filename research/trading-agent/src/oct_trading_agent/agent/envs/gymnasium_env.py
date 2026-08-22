"""Optional ``gymnasium.Env`` adapter over :class:`TradingEnv` (the ``rl`` extra).

This module is imported lazily (via :func:`oct_trading_agent.agent.envs.make_gymnasium_env`) so the
base package never depends on ``gymnasium``. It presents the environment in the shape RL libraries
(Stable-Baselines3, CleanRL, RLlib) expect:

* **Observation** — the flat ``concat(features, mask, state)`` vector (:meth:`Observation.to_vector`),
  as a ``Box``. The missingness mask travels *inside* the vector, so a learner never loses it.
* **Action** — a 2-vector ``Box([0, 0], [n_intents-1, 1])``: a continuous relaxation of the hybrid
  ``(intent, size)`` action that :func:`action_from_array` rounds/clamps back to the typed action. A
  learner preferring a native ``Tuple(Discrete, Box)`` can subclass and override ``action_space``.

The wrapper adds nothing to the semantics — episode boundaries, the reward, and the never-unrealized
guarantee all live in :class:`TradingEnv`; this is purely the SB3-facing surface.
"""

from __future__ import annotations

from typing import Any, ClassVar

import numpy as np

from .action import INTENT_ORDER, action_from_array
from .env import TradingEnv


def make_gymnasium_env(*args: Any, **kwargs: Any) -> Any:
    """Build a ``gymnasium.Env`` wrapping a :class:`TradingEnv` constructed from ``*args/**kwargs``."""
    try:
        import gymnasium as gym
        from gymnasium import spaces
    except ImportError as exc:  # pragma: no cover - exercised only without the extra
        raise ImportError(
            "make_gymnasium_env requires the 'rl' extra: `uv sync --extra rl` "
            "(gymnasium is intentionally not a base dependency)."
        ) from exc

    class GymnasiumTradingEnv(gym.Env):  # type: ignore[misc]
        """A thin ``gymnasium.Env`` adapter; all semantics delegate to :class:`TradingEnv`."""

        metadata: ClassVar[dict[str, Any]] = {"render_modes": []}

        def __init__(self) -> None:
            super().__init__()
            self._env = TradingEnv(*args, **kwargs)
            length = self._env.observation_vector_length
            self.observation_space = spaces.Box(
                low=-np.inf, high=np.inf, shape=(length,), dtype=np.float32
            )
            n_intents = len(INTENT_ORDER)
            self.action_space = spaces.Box(
                low=np.array([0.0, 0.0], dtype=np.float32),
                high=np.array([float(n_intents - 1), 1.0], dtype=np.float32),
                dtype=np.float32,
            )

        def reset(
            self, *, seed: int | None = None, options: dict[str, Any] | None = None
        ) -> tuple[np.ndarray, dict[str, Any]]:
            super().reset(seed=seed)
            obs = self._env.reset()
            return obs.to_vector(), {}

        def step(
            self, action: np.ndarray
        ) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
            result = self._env.step(action_from_array(np.asarray(action)))
            return (
                result.observation.to_vector(),
                float(result.reward),
                result.terminated,
                result.truncated,
                result.info,
            )

    return GymnasiumTradingEnv()


__all__ = ["make_gymnasium_env"]
