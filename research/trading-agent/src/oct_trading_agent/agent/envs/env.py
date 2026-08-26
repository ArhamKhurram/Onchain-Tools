"""``TradingEnv`` — a Gym-style single-token environment on the bonding-curve regime (paper §3).

One environment instance trades **one token episode** (paper §3.4, per-token episodes). It composes
the fixed Wave-1/2 machinery through its public interfaces only — the replay
:class:`~oct_trading_agent.sim.replay.simulator.ReplaySimulator`, the point-in-time
:class:`~oct_trading_agent.featurestore.PointInTimeFeatureStore`, and the
:class:`~oct_trading_agent.ledger.PaperLedger` — and adds the RL contract on top: ``reset``/``step``,
typed observation/action spaces, and the reward.

The five design commitments the task pins:

* **Observation** = the tier-A raw-chart bundle as-of the decision instant, with explicit missingness
  fed as a mask (:mod:`.observation`) — never imputed.
* **Action** = the §3.3 hybrid discrete intent + continuous size (:mod:`.action`), translated to a
  sim :class:`~oct_trading_agent.core.sim.Order` and executed against the bonding curve.
* **Episode** boundaries per §3.4: terminate on full exit / token death / liquidity floor / rug
  (the sim's terminal), or a generous ~3-day hard cap (compute bound, NOT behaviour-shaping). The
  cap and end-of-tape are *truncations*, not natural terminals.
* **Reward** per §3.5 (:mod:`.reward`): realized, cost-inclusive, risk-adjusted PnL primary;
  potential-based shaping only; and — enforced structurally — **no unrealized/peak quantity ever
  reaches the reward** (``PositionState.mark_price`` is never read on the reward path; asserted).
* **Seam**: the env is policy-agnostic. A learner drives it with the standard ``reset``/``step``
  loop; :class:`~oct_trading_agent.agent.policies.EnvPolicy` is the protocol the runner accepts.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal

import numpy as np

from oct_trading_agent.agent.encoders.tracker import (
    AttentionFeatures,
    AttentionTrackerConfig,
    HawkesAttentionTracker,
)
from oct_trading_agent.core import (
    Episode,
    FeatureStore,
    FeatureTier,
    Intent,
    Mint,
    Order,
    SimStepResult,
    SwapEvent,
    TapeEvent,
    TerminalReason,
)
from oct_trading_agent.featurestore import PointInTimeFeatureStore
from oct_trading_agent.ledger import PaperLedger
from oct_trading_agent.sim.replay.simulator import ReplaySimulator, SimConfig

from .action import EnvAction, action_from_array, action_space, action_to_order
from .observation import (
    AgentState,
    Observation,
    encode,
    observation_space,
    vector_length,
)
from .reward import (
    RewardConfig,
    RewardFunction,
    assert_no_unrealized_read,
    reward_from_step,
)
from .spaces import BoxSpace, DictSpace, DiscreteSpace

# The generous per-token hard cap (paper §3.4): bounds compute + guarantees termination, and does
# NOT shape behaviour (no short max-hold is imposed — the scalper style is learned via the reward).
DEFAULT_HARD_CAP = timedelta(days=3)


@dataclass(frozen=True)
class StepResult:
    """The 5-tuple a Gym ``step`` returns, typed. ``terminated`` = natural end; ``truncated`` = cap.

    ``info`` carries the sim step, the running paper balance, the realized PnL booked this step, the
    reward decomposition, and the terminal reason — everything the eval battery needs, nothing the
    reward is allowed to read.
    """

    observation: Observation
    reward: float
    terminated: bool
    truncated: bool
    info: dict[str, object]


class EnvConfig:
    """Episode-level configuration for :class:`TradingEnv` (kept a plain object, not a dataclass, so
    the sim/reward configs it holds stay identity-stable)."""

    def __init__(
        self,
        *,
        initial_balance_quote: Decimal = Decimal(1),
        hard_cap: timedelta = DEFAULT_HARD_CAP,
        max_steps: int | None = None,
        force_liquidate_on_truncation: bool = True,
        reward_config: RewardConfig | None = None,
        attention_features: bool = False,
        attention_config: AttentionTrackerConfig | None = None,
    ) -> None:
        if initial_balance_quote <= 0:
            raise ValueError("initial_balance_quote must be positive")
        self.initial_balance_quote = initial_balance_quote
        self.hard_cap = hard_cap
        self.max_steps = max_steps
        self.force_liquidate_on_truncation = force_liquidate_on_truncation
        self.reward_config = reward_config or RewardConfig()
        # Tier-A+ ablation flag (paper §4.4): OFF by default so every existing config/test sees a
        # byte-identical observation. ON widens the obs by the three attention slots (λ_buy/μ, n,
        # suspicion), masked-missing before the tracker's fit window.
        self.attention_features = attention_features
        self.attention_config = attention_config


class TradingEnv:
    """A Gym-style env for one bonding-curve token episode. See the module docstring for the contract.

    Construct with a **sim-ready tape** for a single mint (use
    :func:`~oct_trading_agent.agent.envs.bonding.prepare_bonding_curve_tape` to seed the pump.fun
    virtual reserves), the mint, and a :class:`~oct_trading_agent.sim.replay.simulator.SimConfig`.
    Decision instants default to the token's swap times (a new print = new information, matching
    ``sim/replay/driver.py``). The feature store defaults to a point-in-time store over the same tape.
    """

    def __init__(
        self,
        tape: list[TapeEvent],
        mint: Mint,
        sim_config: SimConfig,
        *,
        decision_times: list[datetime] | None = None,
        feature_store: FeatureStore | None = None,
        config: EnvConfig | None = None,
    ) -> None:
        self._tape = tape
        self.mint = mint
        self._sim_config = sim_config
        self.config = config or EnvConfig()
        self._feature_store: FeatureStore = feature_store or PointInTimeFeatureStore(tape)
        self._decision_times = (
            list(decision_times) if decision_times is not None else self._default_decision_times()
        )
        self._reward = RewardFunction(
            self.config.reward_config, capital_base=self.config.initial_balance_quote
        )
        # Tier-A+ attention tracker (paper §4.4) — built once per token; its stride-refit cache
        # persists across resets, so repeated episodes over the same tape pay for each fit once.
        self._attention_tracker: HawkesAttentionTracker | None = None
        if self.config.attention_features:
            mint_swaps = [
                e for e in tape if isinstance(e, SwapEvent) and e.mint == mint
            ]
            self._attention_tracker = HawkesAttentionTracker(
                mint_swaps, config=self.config.attention_config
            )
        # Built on reset.
        self._sim: ReplaySimulator | None = None
        self._ledger: PaperLedger | None = None
        self._step_index = 0
        self._start_time: datetime | None = None
        self._done = False

    # -- spaces -----------------------------------------------------------------------------------

    @property
    def observation_space(self) -> DictSpace:
        return observation_space(attention=self.config.attention_features)

    @property
    def action_space(self) -> tuple[DiscreteSpace, BoxSpace]:
        return action_space()

    @property
    def observation_vector_length(self) -> int:
        return vector_length(attention=self.config.attention_features)

    @property
    def decision_times(self) -> list[datetime]:
        return list(self._decision_times)

    # -- Gym API ----------------------------------------------------------------------------------

    def _build_simulator(self) -> ReplaySimulator:
        """Construct the simulator ``reset`` drives. The bonding-curve env uses the constant-product
        :class:`ReplaySimulator`; a subclass (the generic full-chart env) overrides this to build a
        venue-dispatching simulator. Kept a seam so the rest of the RL contract is shared verbatim."""
        return ReplaySimulator(self._tape, self._sim_config)

    def reset(self) -> Observation:
        """Reset to the first decision instant and return the initial observation."""
        self._sim = self._build_simulator()
        self._sim.reset(self.mint)
        self._ledger = PaperLedger(self.config.initial_balance_quote)
        self._reward.reset()
        self._step_index = 0
        self._done = False
        self._start_time = self._decision_times[0] if self._decision_times else None
        return self._observe()

    def step(self, action: EnvAction | np.ndarray) -> StepResult:
        """Advance one decision step: execute ``action``, book it, score it, and advance time."""
        if self._sim is None or self._ledger is None:
            raise RuntimeError("step() called before reset()")
        if self._done:
            raise RuntimeError("step() called on a finished episode; call reset()")
        if not self._decision_times:
            raise RuntimeError("no decision times — the token has no swaps to act on")

        env_action = action if isinstance(action, EnvAction) else action_from_array(action)
        as_of = self._decision_times[self._step_index]
        pre_obs = self._observe()  # the state the decision was made in (for shaping)

        order = action_to_order(env_action, self.mint)
        result = self._sim.step(order, as_of)
        self._ledger.record(self.mint, result, as_of)
        reward, breakdown = self._score(result, pre_obs)

        terminated = bool(result.terminal)
        terminal_reason = result.terminal_reason
        info: dict[str, object] = {
            "as_of": as_of,
            "intent": env_action.intent.value,
            "size": env_action.size,
            "fill_success": result.fill.success,
            "realized_pnl_quote": result.realized_pnl_quote,
            "balance_quote": self._ledger.balance_quote,
            "slippage_bps": result.fill.slippage_bps,
            "price_impact_bps": result.fill.price_impact_bps,
            "fee_quote": result.fill.fee_quote,
            "mev_penalty_quote": result.fill.mev_penalty_quote,
            "reward_breakdown": breakdown,
            "forced_liquidation": False,
        }

        # A GRADUATED token migrated venues; it did not die. Realize any open position at the last
        # instant the curve could still quote it — the step BEFORE the one that reported graduation.
        # Without this, a token that made it all the way to the AMM (i.e. a winner) books as a total
        # loss of its entry cost, biasing the measurement against exactly the tokens that ran.
        if (
            terminated
            and terminal_reason is TerminalReason.GRADUATED
            and self._step_index > 0
            and self._sim.position(self.mint).is_open
        ):
            last_quotable = self._decision_times[self._step_index - 1]
            close = self._sim.force_close_at(self.mint, last_quotable)
            self._ledger.record(self.mint, close, last_quotable)
            close_input = reward_from_step(close, ())
            assert_no_unrealized_read(close_input)
            reward += self._reward.step(close_input).total
            info["forced_liquidation"] = True
            info["balance_quote"] = self._ledger.balance_quote

        # Advance, then decide truncation (end-of-tape or the ~3-day hard cap).
        self._step_index += 1
        truncated = False
        if not terminated:
            truncated, terminal_reason, extra_reward = self._maybe_truncate(as_of)
            reward += extra_reward
            if truncated and extra_reward != 0.0:
                info["forced_liquidation"] = True
                info["balance_quote"] = self._ledger.balance_quote

        self._done = terminated or truncated
        if terminal_reason is not None:
            info["terminal_reason"] = terminal_reason.value

        next_obs = self._observe()
        return StepResult(
            observation=next_obs,
            reward=reward,
            terminated=terminated,
            truncated=truncated,
            info=info,
        )

    # -- introspection ----------------------------------------------------------------------------

    @property
    def balance_quote(self) -> Decimal:
        return self._ledger.balance_quote if self._ledger is not None else (
            self.config.initial_balance_quote
        )

    def close_episode(self) -> Episode | None:
        """Finalize the mint's ledger episode (realized-only). Returns the closed ``Episode``."""
        if self._ledger is None:
            raise RuntimeError("close_episode() before reset()")
        open_ep = self._ledger.open_episode(self.mint)
        if open_ep is None:
            return None
        return self._ledger.close_episode(self.mint)

    # -- helpers ----------------------------------------------------------------------------------

    def _default_decision_times(self) -> list[datetime]:
        times = sorted(
            {
                e.block_time
                for e in self._tape
                if isinstance(e, SwapEvent) and e.mint == self.mint
            }
        )
        if self.config.max_steps is not None:
            return times[: self.config.max_steps]
        return times

    def _score(
        self, result: SimStepResult, pre_obs: Observation
    ) -> tuple[float, object]:
        obs_features = tuple(float(x) for x in pre_obs.features)
        reward_input = reward_from_step(result, obs_features)
        assert_no_unrealized_read(reward_input)  # structural guard: never unrealized/peak (§3.5.4)
        breakdown = self._reward.step(reward_input)
        return breakdown.total, breakdown

    def _maybe_truncate(
        self, last_as_of: datetime
    ) -> tuple[bool, TerminalReason | None, float]:
        """Decide truncation after advancing. Returns (truncated, reason, extra_forced-close reward).

        Truncation fires when the tape is exhausted or the ~3-day hard cap is reached. If a position
        is still open and ``force_liquidate_on_truncation`` is set, we issue a final CLOSE at
        ``last_as_of`` to REALIZE the position — the ~3-day cap is generous and a real holder could
        still sell, so a forced liquidation books an honest *realized* result (never unrealized).
        """
        assert self._sim is not None and self._ledger is not None
        hit_cap = False
        if self._start_time is not None and (last_as_of - self._start_time) >= self.config.hard_cap:
            hit_cap = True
        end_of_tape = self._step_index >= len(self._decision_times)
        if not (hit_cap or end_of_tape):
            return False, None, 0.0

        reason = TerminalReason.HARD_CAP
        extra_reward = 0.0
        if self.config.force_liquidate_on_truncation and self._sim.position(self.mint).is_open:
            close = self._sim.step(Order(mint=self.mint, intent=Intent.CLOSE), last_as_of)
            self._ledger.record(self.mint, close, last_as_of)
            reward_input = reward_from_step(close, ())
            assert_no_unrealized_read(reward_input)
            extra_reward = self._reward.step(reward_input).total
            if close.terminal and close.terminal_reason is not None:
                reason = close.terminal_reason
        return True, reason, extra_reward

    def _observe(self) -> Observation:
        assert self._sim is not None and self._ledger is not None
        idx = min(self._step_index, len(self._decision_times) - 1) if self._decision_times else 0
        as_of = self._decision_times[idx] if self._decision_times else self._fallback_as_of()
        bundle = self._feature_store.assemble(
            self.mint, as_of, tiers=frozenset({FeatureTier.A_RAW_CHART})
        )
        position = self._sim.position(self.mint)
        denom = max(1, len(self._decision_times))
        state = AgentState(
            has_position=position.is_open,
            steps_elapsed_frac=self._step_index / denom,
            balance_ratio=float(self._ledger.balance_quote / self.config.initial_balance_quote),
        )
        attention: AttentionFeatures | None = None
        if self._attention_tracker is not None:
            # Causal by construction: the tracker reads only swaps with block_time <= as_of.
            attention = self._attention_tracker.features_at(as_of)
        return encode(bundle, state, attention=attention)

    def _fallback_as_of(self) -> datetime:
        # Only reached if the token has no swaps at all; use the earliest tape event's time.
        return min((e.block_time for e in self._tape), default=datetime.now())


__all__ = ["DEFAULT_HARD_CAP", "EnvConfig", "StepResult", "TradingEnv"]
