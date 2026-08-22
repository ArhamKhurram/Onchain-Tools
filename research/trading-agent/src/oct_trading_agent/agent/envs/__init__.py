"""agent/envs — the Gym-style RL environment for the raw-chart agent (paper §3; Phase 1).

The environment is the substrate a learner plugs into: it wraps the fixed Wave-1/2 simulator,
feature store, and paper ledger behind a ``reset``/``step`` contract with typed observation/action
spaces and the §3.5 reward. It carries **no heavy RL dependency** — the core :class:`TradingEnv`
imports only ``numpy`` and the repo's own contracts, so ``uv sync --extra dev`` runs it. A learner
that wants a real ``gymnasium.Env`` gets one from :func:`make_gymnasium_env` (guarded import; the
``rl`` optional extra).

Public surface:
    * :class:`TradingEnv` / :class:`EnvConfig` / :class:`StepResult` — the environment.
    * :class:`Observation` / :func:`observation_space` / :class:`AgentState` — the tier-A masked obs.
    * :class:`EnvAction` / :func:`action_space` / :func:`action_to_order` — the §3.3 hybrid action.
    * :class:`RewardFunction` / :class:`RewardConfig` / :class:`RewardBreakdown` — the §3.5 reward.
    * :func:`prepare_bonding_curve_tape` / :func:`bonding_curve_sim_config` — the pump.fun regime.
    * :func:`make_gymnasium_env` — the optional ``gymnasium.Env`` adapter.
"""

from __future__ import annotations

from .action import (
    INTENT_ORDER,
    EnvAction,
    action_from_array,
    action_space,
    action_to_order,
    intent_index,
)
from .bonding import (
    PUMPFUN_BONDING_FEE_BPS,
    PUMPFUN_PROTOCOL,
    bonding_curve_seed_liquidity,
    bonding_curve_sim_config,
    prepare_bonding_curve_tape,
)
from .env import DEFAULT_HARD_CAP, EnvConfig, StepResult, TradingEnv
from .observation import (
    STATE_SLOTS,
    TIER_A_SLOTS,
    AgentState,
    Observation,
    encode,
    observation_space,
    vector_length,
)
from .reward import (
    DifferentialSharpe,
    PotentialShaper,
    RewardBreakdown,
    RewardConfig,
    RewardFunction,
    RewardInput,
    assert_no_unrealized_read,
    reward_from_step,
)
from .spaces import BoxSpace, DictSpace, DiscreteSpace


def make_gymnasium_env(*args: object, **kwargs: object) -> object:
    """Return a ``gymnasium.Env`` wrapping a :class:`TradingEnv` (requires the ``rl`` extra).

    Imported lazily so the base package never depends on ``gymnasium``. Raises a clear error if the
    extra is not installed. Signature mirrors :class:`TradingEnv`.
    """
    from .gymnasium_env import make_gymnasium_env as _make

    return _make(*args, **kwargs)


__all__ = [
    "DEFAULT_HARD_CAP",
    "INTENT_ORDER",
    "PUMPFUN_BONDING_FEE_BPS",
    "PUMPFUN_PROTOCOL",
    "STATE_SLOTS",
    "TIER_A_SLOTS",
    "AgentState",
    "BoxSpace",
    "DictSpace",
    "DifferentialSharpe",
    "DiscreteSpace",
    "EnvAction",
    "EnvConfig",
    "Observation",
    "PotentialShaper",
    "RewardBreakdown",
    "RewardConfig",
    "RewardFunction",
    "RewardInput",
    "StepResult",
    "TradingEnv",
    "action_from_array",
    "action_space",
    "action_to_order",
    "assert_no_unrealized_read",
    "bonding_curve_seed_liquidity",
    "bonding_curve_sim_config",
    "encode",
    "intent_index",
    "make_gymnasium_env",
    "observation_space",
    "prepare_bonding_curve_tape",
    "reward_from_step",
    "vector_length",
]
