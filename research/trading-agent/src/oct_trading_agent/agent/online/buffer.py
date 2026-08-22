"""On-policy rollout storage + GAE — pure-numpy, so the advantage math is testable without torch.

A :class:`RolloutBuffer` accumulates the per-step transitions PPO needs — the normalized observation
vector, the hybrid action's two parts (``intent`` index + ``size``), the joint log-prob under the
behaviour policy, the scalar value baseline, the reward, and the episode-boundary flags — and turns
them into per-step **advantages** (GAE-λ, Schulman et al. 2016) and **value targets** (λ-returns).

Two boundary flags are kept distinct on purpose, matching :class:`TradingEnv`'s contract:

* ``terminated`` — a *natural* terminal (full exit / rug / liquidity floor). The return-to-go past it
  is zero: bootstrapping across a real terminal would invent value that the episode proved absent.
* ``truncated`` — the ~3-day hard cap or end-of-tape. The MDP did **not** end; the value function
  *should* bootstrap the tail. The env force-liquidates on truncation so the realized PnL is booked,
  but for the critic's target we still bootstrap with the provided ``last_value`` so a truncated tail
  is not mistaken for a worthless one.

Keeping this pure (no torch import) means the whole GAE/return computation is exercised by the base
``uv sync --extra dev`` suite; only the network that *produces* ``value``/``logp`` needs the extra.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class Transition:
    """One environment step's worth of on-policy data (all plain Python/numpy — no torch)."""

    obs_vector: np.ndarray  # normalized flat observation, shape (D,)
    intent_index: int
    size: float
    log_prob: float  # joint log-prob of (intent, size) under the behaviour policy
    value: float  # critic mean-value baseline at this state
    reward: float
    terminated: bool
    truncated: bool


@dataclass
class RolloutBatch:
    """A flattened, ready-to-train batch: parallel arrays over all collected steps."""

    obs: np.ndarray  # (N, D) float32
    intents: np.ndarray  # (N,) int64
    sizes: np.ndarray  # (N,) float32
    log_probs: np.ndarray  # (N,) float32 — behaviour-policy joint log-prob
    values: np.ndarray  # (N,) float32 — baseline values at collection time
    advantages: np.ndarray  # (N,) float32 — GAE-λ
    returns: np.ndarray  # (N,) float32 — λ-returns (critic regression target)

    def __len__(self) -> int:
        return int(self.obs.shape[0])


@dataclass
class RolloutBuffer:
    """Accumulates :class:`Transition`s across episodes, then emits a GAE :class:`RolloutBatch`.

    ``add_episode`` appends one complete episode's transitions together with the bootstrap value at
    the episode's final next-state (``last_value``; used only when the episode ended by *truncation*,
    ignored on a natural terminal). ``compute(gamma, lam)`` returns the flattened batch.
    """

    gamma: float = 0.99
    lam: float = 0.95
    _episodes: list[tuple[list[Transition], float]] = field(default_factory=list)

    def add_episode(self, transitions: list[Transition], last_value: float) -> None:
        if transitions:
            self._episodes.append((list(transitions), float(last_value)))

    @property
    def n_steps(self) -> int:
        return sum(len(ep) for ep, _ in self._episodes)

    @property
    def n_episodes(self) -> int:
        return len(self._episodes)

    def clear(self) -> None:
        self._episodes.clear()

    def compute(self, *, normalize_adv: bool = True) -> RolloutBatch:
        """Flatten every stored episode into a GAE batch (advantages + λ-returns)."""
        obs_list: list[np.ndarray] = []
        intents: list[int] = []
        sizes: list[float] = []
        log_probs: list[float] = []
        values: list[float] = []
        advantages: list[float] = []
        returns: list[float] = []

        for transitions, last_value in self._episodes:
            adv = _gae(transitions, last_value, self.gamma, self.lam)
            for t, a in zip(transitions, adv, strict=True):
                obs_list.append(np.asarray(t.obs_vector, dtype=np.float32))
                intents.append(int(t.intent_index))
                sizes.append(float(t.size))
                log_probs.append(float(t.log_prob))
                values.append(float(t.value))
                advantages.append(float(a))
                returns.append(float(a + t.value))  # λ-return = advantage + baseline value

        adv_arr = np.asarray(advantages, dtype=np.float32)
        if normalize_adv and adv_arr.size > 1:
            std = float(adv_arr.std())
            if std > 1e-8:
                adv_arr = (adv_arr - float(adv_arr.mean())) / (std + 1e-8)

        return RolloutBatch(
            obs=np.asarray(obs_list, dtype=np.float32).reshape(len(obs_list), -1),
            intents=np.asarray(intents, dtype=np.int64),
            sizes=np.asarray(sizes, dtype=np.float32),
            log_probs=np.asarray(log_probs, dtype=np.float32),
            values=np.asarray(values, dtype=np.float32),
            advantages=adv_arr,
            returns=np.asarray(returns, dtype=np.float32),
        )


def _gae(
    transitions: list[Transition], last_value: float, gamma: float, lam: float
) -> np.ndarray:
    """Generalized Advantage Estimation over one episode (Schulman et al. 2016).

    A *natural* terminal cuts the bootstrap (next value and the running GAE both reset to 0); a
    *truncation* bootstraps the tail with ``last_value``. Returns per-step advantages.
    """
    n = len(transitions)
    adv = np.zeros(n, dtype=np.float64)
    gae = 0.0
    next_value = float(last_value)
    for i in reversed(range(n)):
        t = transitions[i]
        if t.terminated:
            # Natural terminal: no future value, and GAE does not telescope across it.
            next_nonterminal = 0.0
            gae = 0.0
        elif t.truncated:
            # Truncation is NOT the end of the MDP: bootstrap the tail, but stop telescoping (the
            # trajectory we observed ended here).
            next_nonterminal = 1.0
            gae = 0.0
        else:
            next_nonterminal = 1.0
        delta = t.reward + gamma * next_value * next_nonterminal - t.value
        gae = delta + gamma * lam * next_nonterminal * gae
        adv[i] = gae
        next_value = t.value
    return adv


__all__ = ["RolloutBatch", "RolloutBuffer", "Transition"]
