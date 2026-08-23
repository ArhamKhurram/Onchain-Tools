"""Turn labeled traders' reconstructed episodes into env-aligned (observation, expert-action) demos.

A behavioral-cloning warm-start needs the experts' decisions expressed in **exactly** the env's
contract: at each decision instant, the tier-A observation the policy would see
(:mod:`~oct_trading_agent.agent.envs.observation`) paired with the §3.3 hybrid action the trader
actually took (:mod:`~oct_trading_agent.agent.envs.action`). This module builds that dataset.

The alignment, precisely:

* **Observation** — the tier-A masked bundle assembled by a
  :class:`~oct_trading_agent.featurestore.PointInTimeFeatureStore` **as-of** the decision instant,
  encoded exactly as :class:`~oct_trading_agent.agent.envs.TradingEnv` does (same slots, same mask,
  same agent-state block), then mask-gated to the flat vector the network reads. The store is built
  over the **pooled cohort tape** for each mint — every tracked trader's swaps on that token — a
  partial but honest reconstruction of the chart (we deliberately do NOT pull the full token tape
  per mint; that would blow the bounded pull). What the trader saw of *liquidity* we cannot recover
  from a swap stream, so it is masked-missing — the same explicit missingness the env feeds.
* **Action** — the discrete :class:`~oct_trading_agent.core.enums.Intent` the trader took
  (OPEN_LONG / ADD / TRIM / CLOSE), plus **HOLD** at cohort prints while the trader held and
  **NO_OP** at cohort prints just before the trader entered. Including the do-nothing decisions is
  what stops BC from learning "always act"; capping them (``hold_ratio`` / ``noop_ratio``) is what
  stops it collapsing to "always hold" — the two degenerate policies the from-scratch PPO fell into.
* **Size** — the continuous [0, 1] target: buys as a fraction of the trader's own largest buy in the
  episode (relative conviction); trims as the fraction of the held position sold. Non-sizing intents
  (CLOSE / HOLD / NO_OP) carry size 0 and are masked out of the size loss.

Everything here is pure numpy + the fixed substrate — **no torch** — so the whole demo build is in
the base test suite. The BC trainer (:mod:`.bc`) consumes :class:`DemoDataset`.

**Selection-bias caveat (paper §9.3):** these are the *full* histories of tracked wallets — wins and
losses both. Nothing is hindsight-filtered, but the wallets were chosen by the operator (and, in the
bounded first pass, ranked by current balance), so the cohort is not a random sample of traders.
Imitating them clones their behaviour, which is not the same as cloning a proven edge.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal

import numpy as np

from oct_trading_agent.agent.envs.action import INTENT_ORDER, intent_index
from oct_trading_agent.agent.envs.observation import (
    AgentState,
    encode,
    vector_length,
)
from oct_trading_agent.core import (
    FeatureTier,
    Intent,
    Side,
    SwapEvent,
)
from oct_trading_agent.data.labeling.reconstruct import build_trajectories
from oct_trading_agent.data.labeling.schema import (
    DemonstrationStep,
    DemonstrationTrajectory,
    LabeledTrade,
    LabeledWallet,
)
from oct_trading_agent.featurestore import PointInTimeFeatureStore

_SIZED_INTENTS = frozenset({Intent.OPEN_LONG, Intent.ADD, Intent.TRIM})
_A_TIER = frozenset({FeatureTier.A_RAW_CHART})


@dataclass(frozen=True)
class DemoConfig:
    """Knobs for building the demo set (bounded + class-balanced by construction)."""

    hold_ratio: float = 1.0  # HOLD demos per action demo, per trajectory (0 disables)
    noop_ratio: float = 0.5  # NO_OP demos per action demo, per trajectory (0 disables)
    noop_lead: timedelta = timedelta(minutes=10)  # pre-entry watch window for NO_OP
    max_demos: int | None = 20000  # global cap (keeps a bounded BC run quick)


@dataclass(frozen=True)
class DemoStep:
    """One (observation, expert-action) pair, in the env's exact encoding.

    ``observation`` is the mask-gated flat vector (``concat(features·mask, mask, state)``); ``intent``
    is the expert's discrete intent and ``intent_index`` its position in :data:`INTENT_ORDER`;
    ``size`` is the [0, 1] target and ``is_sized`` marks whether the size loss applies to this step.
    ``mint``/``wallet``/``outcome`` are provenance (held-out splits + reporting), never fed to a net.
    """

    observation: np.ndarray
    intent: Intent
    intent_index: int
    size: float
    is_sized: bool
    mint: str
    wallet: str
    outcome: str


@dataclass(frozen=True)
class DemoDataset:
    """A built demo set plus the trajectory bookkeeping the cohort report needs."""

    steps: list[DemoStep]
    n_wallets: int
    n_trajectories: int
    outcome_counts: dict[str, int] = field(default_factory=dict)

    def __len__(self) -> int:
        return len(self.steps)


# ---------------------------------------------------------------------------
# Cohort tape: LabeledTrades -> synthesized SwapEvents (a causal per-mint tape)
# ---------------------------------------------------------------------------


def _trade_price(trade: LabeledTrade) -> Decimal | None:
    if trade.price is not None and trade.price > 0:
        return trade.price
    if trade.base_amount > 0:
        return trade.quote_amount / trade.base_amount
    return None


def _synthesize_swap(wallet: str, trade: LabeledTrade) -> SwapEvent | None:
    """Map a labeled trade back to a :class:`SwapEvent` for the point-in-time feature store.

    The labeling schema drops the slot (it is a trade record, not a tape event); we resynthesize a
    monotone-in-time slot from the timestamp so the causal ``(slot, block_time)`` ordering the
    featurestore relies on holds. Reserves are absent (a swap stream never carries them) — liquidity
    is therefore masked-missing downstream, exactly as in the live env.
    """
    if trade.base_amount <= 0 or trade.quote_amount <= 0:
        return None
    price = _trade_price(trade)
    return SwapEvent(
        mint=trade.mint,
        slot=int(trade.timestamp.timestamp()),
        block_time=trade.timestamp,
        signature=trade.signature,
        signer=wallet,
        side=trade.side,
        base_amount=trade.base_amount,
        quote_amount=trade.quote_amount,
        price=price,
    )


def build_cohort_tape(wallets: Sequence[LabeledWallet]) -> list[SwapEvent]:
    """Pool every tracked trader's swaps into one causal multi-mint tape (the observation substrate)."""
    tape: list[SwapEvent] = []
    for wallet in wallets:
        for trade in wallet.trades:
            event = _synthesize_swap(wallet.wallet, trade)
            if event is not None:
                tape.append(event)
    tape.sort(key=lambda e: (e.mint, e.slot, e.block_time))
    return tape


def _evenly_spaced(items: list[SwapEvent], keep: int) -> list[SwapEvent]:
    """Deterministically subsample ``items`` down to ``keep`` by even spacing (no RNG, reproducible)."""
    if keep <= 0 or not items:
        return []
    if keep >= len(items):
        return list(items)
    idx = [round(i * (len(items) - 1) / (keep - 1)) for i in range(keep)] if keep > 1 else [0]
    seen: set[int] = set()
    out: list[SwapEvent] = []
    for i in idx:
        if i not in seen:
            seen.add(i)
            out.append(items[i])
    return out


# ---------------------------------------------------------------------------
# Expert action targets
# ---------------------------------------------------------------------------


def _size_target(step: DemonstrationStep, base_qty_before: Decimal, max_buy_quote: Decimal) -> float:
    """The [0, 1] size target for one expert step (see the module docstring for the mapping)."""
    if step.intent in (Intent.OPEN_LONG, Intent.ADD):
        if max_buy_quote <= 0:
            return 0.0
        return float(min(Decimal(1), step.quote_amount / max_buy_quote))
    if step.intent is Intent.TRIM:
        if base_qty_before <= 0:
            return 0.0
        sold = base_qty_before - step.base_qty_after
        return float(min(Decimal(1), max(Decimal(0), sold / base_qty_before)))
    return 0.0


def _fraction(as_of: datetime, start: datetime, end: datetime) -> float:
    span = (end - start).total_seconds()
    if span <= 0:
        return 0.0
    return float(np.clip((as_of - start).total_seconds() / span, 0.0, 1.0))


# ---------------------------------------------------------------------------
# The builder
# ---------------------------------------------------------------------------


class _DemoBuilder:
    def __init__(self, store: PointInTimeFeatureStore, tape_by_mint: dict[str, list[SwapEvent]]):
        self._store = store
        self._by_mint = tape_by_mint

    def _observe(self, mint: str, as_of: datetime, *, has_position: bool, frac: float) -> np.ndarray:
        bundle = self._store.assemble(mint, as_of, _A_TIER)
        state = AgentState(has_position=has_position, steps_elapsed_frac=frac, balance_ratio=1.0)
        obs = encode(bundle, state)
        vec = obs.to_vector().copy()
        nf = obs.features.shape[0]
        # Mask-gate the feature block (features · mask) — a masked-off slot contributes exactly 0,
        # matching TorchPolicy's network-boundary gate.
        vec[:nf] = vec[:nf] * obs.mask
        return vec.astype(np.float32)

    def _action_steps(
        self, trajectory: DemonstrationTrajectory, wallet: str
    ) -> tuple[list[DemoStep], set[str | None], set[datetime]]:
        buys = [s.quote_amount for s in trajectory.steps if s.side is Side.BUY and s.quote_amount > 0]
        max_buy = max(buys) if buys else Decimal(0)
        out: list[DemoStep] = []
        own_sigs: set[str | None] = set()
        own_times: set[datetime] = set()
        base_before = Decimal(0)
        for step in trajectory.steps:
            has_pos = base_before > 0
            frac = _fraction(step.timestamp, trajectory.started_at, trajectory.ended_at)
            size = _size_target(step, base_before, max_buy)
            obs = self._observe(trajectory.mint, step.timestamp, has_position=has_pos, frac=frac)
            out.append(
                DemoStep(
                    observation=obs,
                    intent=step.intent,
                    intent_index=intent_index(step.intent),
                    size=size,
                    is_sized=step.intent in _SIZED_INTENTS,
                    mint=trajectory.mint,
                    wallet=wallet,
                    outcome=trajectory.outcome,
                )
            )
            own_sigs.add(step.signature)
            own_times.add(step.timestamp)
            base_before = step.base_qty_after
        return out, own_sigs, own_times

    def _passive_steps(
        self,
        trajectory: DemonstrationTrajectory,
        wallet: str,
        own_sigs: set[str | None],
        own_times: set[datetime],
        n_actions: int,
        config: DemoConfig,
    ) -> list[DemoStep]:
        cohort = self._by_mint.get(trajectory.mint, [])
        hold_src = [
            e
            for e in cohort
            if trajectory.started_at < e.block_time < trajectory.ended_at
            and e.signature not in own_sigs
            and e.block_time not in own_times
        ]
        noop_src = [
            e
            for e in cohort
            if trajectory.started_at - config.noop_lead <= e.block_time < trajectory.started_at
            and e.block_time not in own_times
        ]
        out: list[DemoStep] = []
        for src, ratio, intent, has_pos in (
            (hold_src, config.hold_ratio, Intent.HOLD, True),
            (noop_src, config.noop_ratio, Intent.NO_OP, False),
        ):
            keep = round(ratio * max(1, n_actions))
            for e in _evenly_spaced(src, keep):
                frac = _fraction(e.block_time, trajectory.started_at, trajectory.ended_at)
                obs = self._observe(trajectory.mint, e.block_time, has_position=has_pos, frac=frac)
                out.append(
                    DemoStep(
                        observation=obs,
                        intent=intent,
                        intent_index=intent_index(intent),
                        size=0.0,
                        is_sized=False,
                        mint=trajectory.mint,
                        wallet=wallet,
                        outcome=trajectory.outcome,
                    )
                )
        return out


def build_demos(
    wallets: Sequence[LabeledWallet],
    config: DemoConfig | None = None,
) -> DemoDataset:
    """Build the env-aligned (observation, expert-action) demo set from labeled traders' histories.

    Reconstructs each wallet's per-token episodes (wins AND losses), then, per episode, emits the
    trader's actual trades as action demos plus a class-balanced sample of HOLD/NO_OP demos. All
    observations are assembled from the pooled cohort tape at the decision instant, in the env's
    exact tier-A encoding.
    """
    cfg = config or DemoConfig()
    tape = build_cohort_tape(wallets)
    by_mint: dict[str, list[SwapEvent]] = {}
    for e in tape:
        by_mint.setdefault(e.mint, []).append(e)
    store = PointInTimeFeatureStore(tape)
    builder = _DemoBuilder(store, by_mint)

    steps: list[DemoStep] = []
    n_trajectories = 0
    outcome_counts: dict[str, int] = {}
    for wallet in wallets:
        for trajectory in build_trajectories(wallet):
            n_trajectories += 1
            outcome_counts[trajectory.outcome] = outcome_counts.get(trajectory.outcome, 0) + 1
            action_steps, own_sigs, own_times = builder._action_steps(trajectory, wallet.wallet)
            steps.extend(action_steps)
            steps.extend(
                builder._passive_steps(
                    trajectory, wallet.wallet, own_sigs, own_times, len(action_steps), cfg
                )
            )
            if cfg.max_demos is not None and len(steps) >= cfg.max_demos:
                break
        if cfg.max_demos is not None and len(steps) >= cfg.max_demos:
            break

    if cfg.max_demos is not None:
        steps = steps[: cfg.max_demos]
    return DemoDataset(
        steps=steps,
        n_wallets=len(wallets),
        n_trajectories=n_trajectories,
        outcome_counts=outcome_counts,
    )


def demo_matrices(
    steps: Sequence[DemoStep],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Stack demos into ``(observations, intents, sizes, sized_mask)`` numpy arrays for BC."""
    if not steps:
        d = vector_length()
        return (
            np.zeros((0, d), dtype=np.float32),
            np.zeros((0,), dtype=np.int64),
            np.zeros((0,), dtype=np.float32),
            np.zeros((0,), dtype=np.float32),
        )
    obs = np.stack([s.observation for s in steps]).astype(np.float32)
    intents = np.array([s.intent_index for s in steps], dtype=np.int64)
    sizes = np.array([s.size for s in steps], dtype=np.float32)
    sized = np.array([1.0 if s.is_sized else 0.0 for s in steps], dtype=np.float32)
    return obs, intents, sizes, sized


def intent_distribution(steps: Sequence[DemoStep]) -> dict[str, int]:
    """Count demos per intent name (for the class-balance line of the cohort report)."""
    counts = {intent.value: 0 for intent in INTENT_ORDER}
    for s in steps:
        counts[s.intent.value] += 1
    return counts


__all__ = [
    "DemoConfig",
    "DemoStep",
    "DemoDataset",
    "build_cohort_tape",
    "build_demos",
    "demo_matrices",
    "intent_distribution",
]
