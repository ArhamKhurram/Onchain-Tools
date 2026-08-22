"""Lightweight, framework-agnostic typed spaces for :class:`TradingEnv`.

The Phase-1 substrate must import and run with **no heavy RL dependency** (gymnasium, torch,
etc. are optional extras — see ``pyproject.toml``). So the environment declares its observation
and action shapes with these tiny value types rather than importing ``gymnasium.spaces`` at module
load. A learner that wants real ``gymnasium`` spaces gets them from
:mod:`oct_trading_agent.agent.envs.gymnasium_env`, which converts these on demand behind a guarded
import — the seam is present without the dependency being mandatory.

Design:

* :class:`BoxSpace` — a bounded continuous vector (``low``/``high`` are per-dimension float bounds).
* :class:`DiscreteSpace` — a finite set ``{0, .., n-1}``.
* :class:`DictSpace` — a named product of sub-spaces (how the observation is exposed: the raw-chart
  feature vector, its missingness mask, and the agent-state vector are three named boxes so a
  consumer can never confuse a *masked-missing* slot for an observed zero).

These are values, not gymnasium's stateful spaces: ``sample`` takes an explicit ``numpy`` Generator
so every draw is reproducible (the whole program's credibility rests on determinism — 03 §Phase 0).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class BoxSpace:
    """A bounded continuous vector space. ``low``/``high`` are equal-length per-dimension bounds."""

    low: tuple[float, ...]
    high: tuple[float, ...]

    def __post_init__(self) -> None:
        if len(self.low) != len(self.high):
            raise ValueError("low and high must have equal length")
        if any(lo > hi for lo, hi in zip(self.low, self.high, strict=True)):
            raise ValueError("every low bound must be <= its high bound")

    @property
    def shape(self) -> tuple[int]:
        return (len(self.low),)

    def sample(self, rng: np.random.Generator) -> np.ndarray:
        lo = np.asarray(self.low, dtype=np.float64)
        hi = np.asarray(self.high, dtype=np.float64)
        # Clamp non-finite bounds to a wide finite range so a uniform draw is well-defined.
        lo_f = np.where(np.isfinite(lo), lo, -1e9)
        hi_f = np.where(np.isfinite(hi), hi, 1e9)
        return lo_f + (hi_f - lo_f) * rng.random(lo_f.shape)

    def contains(self, value: np.ndarray) -> bool:
        arr = np.asarray(value, dtype=np.float64)
        if arr.shape != self.shape:
            return False
        lo = np.asarray(self.low, dtype=np.float64)
        hi = np.asarray(self.high, dtype=np.float64)
        return bool(np.all(arr >= lo) and np.all(arr <= hi))


@dataclass(frozen=True)
class DiscreteSpace:
    """A finite discrete space ``{0, 1, ..., n-1}``."""

    n: int

    def __post_init__(self) -> None:
        if self.n <= 0:
            raise ValueError("n must be positive")

    def sample(self, rng: np.random.Generator) -> int:
        return int(rng.integers(0, self.n))

    def contains(self, value: int) -> bool:
        return 0 <= int(value) < self.n


@dataclass(frozen=True)
class DictSpace:
    """A named product of sub-spaces (the observation is a dict of boxes)."""

    spaces: dict[str, BoxSpace | DiscreteSpace]

    def sample(self, rng: np.random.Generator) -> dict[str, object]:
        return {name: space.sample(rng) for name, space in self.spaces.items()}


__all__ = ["BoxSpace", "DiscreteSpace", "DictSpace"]
