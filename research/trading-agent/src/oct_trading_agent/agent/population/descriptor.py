"""Behavioral descriptor + archetype-niche binning (paper §6.4; 02 §2 (4)). TORCH-FREE.

The quality-diversity engine needs to know *how* an agent trades, not just *how well*. This module
turns an agent's realized eval behaviour into a compact **behavioral descriptor** and bins that
descriptor into one of the memecoin **archetype niches**. Everything here is a pure function of the
agent's own behaviour on the held-out tokens — the niche is DERIVED, never hand-assigned — and it
imports no torch, so any :class:`~oct_trading_agent.agent.policies.EnvPolicy` (a baseline or a trained
actor) can be profiled and the whole thing is unit-tested without the ``learn`` extra.

The descriptor→niche mapping is the seam a full MAP-Elites archive (CVT/adaptive bins) will replace
later; for the first PBT pass it is a fixed, documented 3×2 grid over the two axes the telemetry
contract mandates — ``(trade_frequency, mean_hold_duration)`` — with the extra axes recorded for
flavour but never used to bin. See :func:`bin_descriptor` for the exact rule and thresholds.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from oct_trading_agent.agent.envs import EnvAction, Observation, TradingEnv
from oct_trading_agent.agent.policies import EnvPolicy

# The memecoin archetype vocabulary, in the telemetry contract's display order. Deliberately GOOFY
# codenames (desk-telemetry-schema.md): they carry NO behavioral meaning — the behavior is defined
# entirely by which descriptor grid cell the name maps to (see bin_descriptor). The old functional
# names (SNIPER/SCAN/WHALE/RUG/SHILL/EXIT) misled (e.g. "RUG" read as a rug-checker), so they were
# renamed cell-for-cell to this set.
MEMECOIN_ROLES: tuple[str, ...] = ("GOBLIN", "GREMLIN", "GIZMO", "NOODLE", "PICKLE", "GECKO")

# Intent strings (``Intent`` StrEnum values, as they arrive in the env step ``info``).
_BUY_INTENTS = frozenset({"open_long", "add"})
_SELL_INTENTS = frozenset({"trim", "close"})
_SIZED_INTENTS = frozenset({"open_long", "add", "trim"})

# ---------------------------------------------------------------------------
# Grid boundaries — the FIXED, documented niche-binning thresholds.
#
# First-pass constants for the PBT seam MAP-Elites replaces. They partition the two mandated
# behavioral axes into a 3×2 grid whose six cells are exactly the six memecoin roles. Tuned to the
# memecoin timescale (swap-time decision steps, sub-minute flips vs multi-minute holds); deliberately
# static so an agent's niche is a pure function of ITS OWN descriptor, not of the population.
# ---------------------------------------------------------------------------

#: trade_frequency (fills per decision step) LOW | MED | HIGH split points.
FREQ_LOW_MAX = 0.08
FREQ_HIGH_MIN = 0.20

#: mean_hold_duration SHORT | LONG split point, in seconds.
HOLD_SHORT_MAX_SECS = 90.0


@dataclass(frozen=True)
class BehavioralDescriptor:
    """An agent's trading STYLE, distilled from its realized behaviour on the held-out tokens.

    ``trade_frequency`` and ``mean_hold_secs`` are the two axes the telemetry contract mandates and
    the only two :func:`bin_descriptor` reads; ``entry_latency_frac`` / ``sell_ratio`` / ``mean_size``
    are cheap extra axes recorded for champion flavour and future (MAP-Elites) binning.
    """

    trade_frequency: float  # fills per decision step (turnover intensity), 0..~1
    mean_hold_secs: float  # mean seconds a position is held (0 if it never opened one)
    entry_latency_frac: float  # mean fraction of the episode elapsed before the first entry, 0..1
    sell_ratio: float  # fraction of fills that were sells (trim/close), 0..1
    mean_size: float  # mean size fraction on sized fills, 0..1


@dataclass(frozen=True)
class BehaviorSample:
    """Per-token behavioural read-out of one episode (folded into a :class:`BehavioralDescriptor`)."""

    return_pct: float
    n_steps: int
    n_trades: int
    n_buys: int
    n_sells: int
    first_entry_step: int | None
    hold_secs: tuple[float, ...]
    sizes: tuple[float, ...]


@dataclass(frozen=True)
class BehaviorProfile:
    """An agent's full eval profile: its fitness, win-rate, trade count, and behavioral descriptor.

    ``pnl_bps`` is the mean per-token realized return, net of the sim's modeled costs, in basis
    points — the honest held-out fitness PBT selects on and the champion pnl the telemetry reports.
    """

    pnl_bps: float
    win_rate: float
    n_trades: int
    mean_hold_secs: float
    descriptor: BehavioralDescriptor
    n_tokens: int


def _is_fill(info: dict[str, object]) -> bool:
    """A step booked a real, base-moving fill (matches the eval runner's trade criterion)."""
    return bool(info.get("fill_success")) and float(info.get("slippage_bps", 0.0)) > 0.0  # type: ignore[arg-type]


def behavioral_rollout(env: TradingEnv, policy: EnvPolicy) -> BehaviorSample:
    """Run one episode and record the behaviour needed to describe the agent's STYLE.

    Drives the same ``reset``/``act``/``step`` loop as :func:`~oct_trading_agent.eval.runner.rollout`
    (so it is apples-to-apples with the eval battery), but instead of the metric battery it tracks
    trade counts, buy/sell mix, sizes, entry latency, and per-position hold durations from each step's
    ``info``. A hold span runs from the first entry while flat to the next full CLOSE (or the forced
    end-of-episode liquidation); intervening ADD/TRIM fills do not end it. Torch-free.
    """
    policy.reset()
    obs: Observation = env.reset()
    initial_balance = float(env.config.initial_balance_quote)

    n_steps = 0
    n_buys = 0
    n_sells = 0
    first_entry_step: int | None = None
    hold_secs: list[float] = []
    sizes: list[float] = []
    position_open = False
    entry_time: datetime | None = None

    done = False
    while not done:
        action: EnvAction = policy.act(obs)
        result = env.step(action)
        info = result.info
        as_of = info.get("as_of")
        if _is_fill(info):
            intent = str(info.get("intent", ""))
            if intent in _SIZED_INTENTS:
                sizes.append(float(info.get("size", 0.0)))  # type: ignore[arg-type]
            if intent in _BUY_INTENTS:
                n_buys += 1
                if not position_open:
                    position_open = True
                    entry_time = as_of if isinstance(as_of, datetime) else None
                    if first_entry_step is None:
                        first_entry_step = n_steps
            elif intent in _SELL_INTENTS:
                n_sells += 1
                if position_open and intent == "close":
                    if entry_time is not None and isinstance(as_of, datetime):
                        hold_secs.append((as_of - entry_time).total_seconds())
                    position_open = False
                    entry_time = None
        n_steps += 1
        done = result.terminated or result.truncated
        # A position still open at the episode boundary is realized by the env's forced liquidation;
        # close its hold span at the last decision instant so a buy-and-hold style has a real duration.
        if done and position_open and entry_time is not None and isinstance(as_of, datetime):
            hold_secs.append((as_of - entry_time).total_seconds())
        obs = result.observation

    episode = env.close_episode()
    realized = float(episode.realized_pnl_quote) if episode is not None else 0.0
    return BehaviorSample(
        return_pct=realized / initial_balance if initial_balance > 0 else 0.0,
        n_steps=n_steps,
        n_trades=n_buys + n_sells,
        n_buys=n_buys,
        n_sells=n_sells,
        first_entry_step=first_entry_step,
        hold_secs=tuple(hold_secs),
        sizes=tuple(sizes),
    )


def profile_policy(envs: list[TradingEnv], policy: EnvPolicy) -> BehaviorProfile:
    """Profile ``policy`` across ``envs`` (one episode each): fitness + behavioral descriptor.

    One pass over the held-out envs yields BOTH the fitness (mean per-token return, in bps) and the
    style descriptor, so PBT never rolls the same policy twice. An empty env set degenerates to a
    zeroed profile (reported honestly upstream, never hidden).
    """
    samples = [behavioral_rollout(env, policy) for env in envs]
    return summarize_behavior(samples)


def summarize_behavior(samples: list[BehaviorSample]) -> BehaviorProfile:
    """Fold per-episode :class:`BehaviorSample`s into one :class:`BehaviorProfile` (pure)."""
    if not samples:
        return BehaviorProfile(
            pnl_bps=0.0, win_rate=0.0, n_trades=0, mean_hold_secs=0.0,
            descriptor=BehavioralDescriptor(0.0, 0.0, 1.0, 0.0, 0.0), n_tokens=0,
        )
    n_tokens = len(samples)
    returns = [s.return_pct for s in samples]
    pnl_bps = (sum(returns) / n_tokens) * 10_000.0
    win_rate = sum(1 for r in returns if r > 0.0) / n_tokens

    total_steps = sum(s.n_steps for s in samples)
    total_trades = sum(s.n_trades for s in samples)
    total_sells = sum(s.n_sells for s in samples)
    all_holds = [h for s in samples for h in s.hold_secs]
    all_sizes = [z for s in samples for z in s.sizes]
    entered = [
        s.first_entry_step / s.n_steps
        for s in samples
        if s.first_entry_step is not None and s.n_steps > 0
    ]

    mean_hold = sum(all_holds) / len(all_holds) if all_holds else 0.0
    descriptor = BehavioralDescriptor(
        trade_frequency=total_trades / total_steps if total_steps > 0 else 0.0,
        mean_hold_secs=mean_hold,
        entry_latency_frac=sum(entered) / len(entered) if entered else 1.0,
        sell_ratio=total_sells / total_trades if total_trades > 0 else 0.0,
        mean_size=sum(all_sizes) / len(all_sizes) if all_sizes else 0.0,
    )
    return BehaviorProfile(
        pnl_bps=pnl_bps,
        win_rate=win_rate,
        n_trades=total_trades,
        mean_hold_secs=mean_hold,
        descriptor=descriptor,
        n_tokens=n_tokens,
    )


def _freq_band(trade_frequency: float) -> int:
    """0 = LOW, 1 = MED, 2 = HIGH turnover intensity."""
    if trade_frequency < FREQ_LOW_MAX:
        return 0
    if trade_frequency < FREQ_HIGH_MIN:
        return 1
    return 2


def bin_descriptor(descriptor: BehavioralDescriptor) -> str:
    """Map a behavioral descriptor to one memecoin archetype niche (MAP-Elites-style, pure).

    A fixed 3×2 grid over the two mandated axes — turnover ``trade_frequency`` (LOW/MED/HIGH) ×
    ``mean_hold_secs`` (SHORT/LONG) — with each cell a distinct role:

    ================  ==========  ==========  ==========
    hold \\ freq       LOW         MED         HIGH
    ================  ==========  ==========  ==========
    SHORT (<90s)      GREMLIN     GECKO       GOBLIN
    LONG  (>=90s)     GIZMO       PICKLE      NOODLE
    ================  ==========  ==========  ==========

    The names are deliberately GOOFY and carry NO behavioral meaning (desk-telemetry-schema.md); the
    behaviour is exactly the cell. So a **GOBLIN** is short-hold/high-turnover, a **GREMLIN** is
    short-hold/low-turnover (also where a non-trading agent lands, since ``freq=0, hold=0``), a
    **GECKO** short-hold/moderate, a **GIZMO** long-hold/low-turnover, a **PICKLE**
    long-hold/moderate, and a **NOODLE** long-hold/high-turnover. The niche is a pure function of the
    agent's own behaviour — never assigned. This cell→name assignment is fixed so PBT, MAP-Elites, and
    the viz stay comparable.
    """
    long_hold = descriptor.mean_hold_secs >= HOLD_SHORT_MAX_SECS
    band = _freq_band(descriptor.trade_frequency)
    grid: tuple[tuple[str, str, str], tuple[str, str, str]] = (
        ("GREMLIN", "GECKO", "GOBLIN"),  # SHORT hold: LOW, MED, HIGH turnover
        ("GIZMO", "PICKLE", "NOODLE"),  # LONG hold: LOW, MED, HIGH turnover
    )
    return grid[1 if long_hold else 0][band]


__all__ = [
    "MEMECOIN_ROLES",
    "FREQ_LOW_MAX",
    "FREQ_HIGH_MIN",
    "HOLD_SHORT_MAX_SECS",
    "BehavioralDescriptor",
    "BehaviorSample",
    "BehaviorProfile",
    "behavioral_rollout",
    "profile_policy",
    "summarize_behavior",
    "bin_descriptor",
]
