"""The hybrid discrete-continuous action (paper §3.3) and its translation to a sim :class:`Order`.

Per §3.3 the agent emits, each decision step and per candidate token, a **discrete intent** drawn
from ``{no-op, open-long, add, trim, close, hold}`` paired with a **continuous size fraction** in
``[0, 1]`` (the fraction of the risk budget; ``1.0`` maps to ``f_max``). Memecoin new-pairs are
long-only in the alpha, so no intent expresses a short — the discrete set above is the whole space.

Two representations, one meaning:

* :class:`EnvAction` — the structured, typed action a policy returns (``intent`` + ``size``). This
  is the ergonomic form and what the baselines and the random policy produce.
* A flat ``numpy`` array ``[intent_index, size]`` — the form an RL library's actor head emits. The
  discrete index follows :data:`INTENT_ORDER`; :func:`action_from_array` narrows it back.

:func:`action_to_order` is the single translation into the simulator's :class:`Order`. It is
deliberately total and defensive: ``size`` is clamped to ``[0, 1]`` (a squashing actor can overshoot
by an epsilon), and the non-sizing intents (``NO_OP``/``HOLD``/``CLOSE``) carry ``size == 0`` because
the sim ignores size for them (``CLOSE`` always exits the whole position — see
``sim/replay/simulator.py``).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from oct_trading_agent.core import Intent, Mint, Order

from .spaces import BoxSpace, DiscreteSpace

# The canonical discrete-intent ordering. Index i <-> INTENT_ORDER[i]; an actor head's argmax over
# 6 logits maps through this table. Order is stable and MUST NOT be reordered (it is the action
# encoding a trained policy would learn against).
INTENT_ORDER: tuple[Intent, ...] = (
    Intent.NO_OP,
    Intent.OPEN_LONG,
    Intent.ADD,
    Intent.TRIM,
    Intent.CLOSE,
    Intent.HOLD,
)
_INTENT_INDEX: dict[Intent, int] = {intent: i for i, intent in enumerate(INTENT_ORDER)}

# Intents for which ``size`` is meaningful (a fraction of the risk budget / of the held position).
# The rest carry size 0 — the sim ignores size for NO_OP/HOLD and sells the whole book on CLOSE.
_SIZED_INTENTS = frozenset({Intent.OPEN_LONG, Intent.ADD, Intent.TRIM})


@dataclass(frozen=True)
class EnvAction:
    """A structured hybrid action: a discrete :class:`Intent` and a continuous ``size`` in [0, 1]."""

    intent: Intent
    size: float = 0.0

    def __post_init__(self) -> None:
        if not 0.0 <= self.size <= 1.0 and np.isfinite(self.size):
            # Only reject clearly-out-of-range finite sizes; NaN/inf are handled by clamping later.
            raise ValueError(f"size must be in [0, 1], got {self.size}")


def intent_index(intent: Intent) -> int:
    """The discrete index of ``intent`` under :data:`INTENT_ORDER`."""
    return _INTENT_INDEX[intent]


def action_space() -> tuple[DiscreteSpace, BoxSpace]:
    """The env's action space: ``Discrete(6)`` intent + ``Box([0], [1])`` size fraction."""
    return DiscreteSpace(len(INTENT_ORDER)), BoxSpace(low=(0.0,), high=(1.0,))


def _clamp01(x: float) -> float:
    if not np.isfinite(x):
        return 0.0
    return float(min(1.0, max(0.0, x)))


def action_from_array(array: np.ndarray) -> EnvAction:
    """Narrow a flat ``[intent_index, size]`` actor output into a typed :class:`EnvAction`.

    The intent index is rounded and clamped into ``[0, len(INTENT_ORDER))``; ``size`` is clamped to
    ``[0, 1]``. This is total — a noisy actor output can never raise, only saturate.
    """
    arr = np.asarray(array, dtype=np.float64).reshape(-1)
    if arr.size < 2:
        raise ValueError("action array must carry [intent_index, size]")
    raw_idx = 0 if not np.isfinite(arr[0]) else round(float(arr[0]))
    idx = min(len(INTENT_ORDER) - 1, max(0, raw_idx))
    return EnvAction(intent=INTENT_ORDER[idx], size=_clamp01(float(arr[1])))


def action_to_order(action: EnvAction, mint: Mint) -> Order:
    """Translate a typed :class:`EnvAction` into a simulator :class:`Order` for ``mint``.

    ``size`` is clamped to ``[0, 1]`` and zeroed for the non-sizing intents. The per-token hard cap
    and the risk budget are enforced *inside* the sim/risk layer (``sim/replay/simulator.py``), not
    here — the order only ever expresses the policy's *intent*, never a spend authorization.
    """
    size = _clamp01(action.size) if action.intent in _SIZED_INTENTS else 0.0
    return Order(mint=mint, intent=action.intent, size=size)


__all__ = [
    "INTENT_ORDER",
    "EnvAction",
    "action_from_array",
    "action_space",
    "action_to_order",
    "intent_index",
]
