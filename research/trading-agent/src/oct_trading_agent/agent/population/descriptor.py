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

# ---------------------------------------------------------------------------
# Fine style axes (operator directive 2026-08-24): sizing style × exit style.
#
# These two extra axes refine — never replace — the 3×2 role grid: the full style space is
# freq(3) × hold(2) × entry-size(3) × exit-clip(3) = 54 cells, and the first two axes still
# project onto the six codename roles the desk viz renders (:func:`bin_descriptor` is untouched).
# The fine cell lives in :func:`bin_style_cell` and travels as ADDITIVE champion telemetry only.
# ---------------------------------------------------------------------------

#: mean entry-size fraction (of the risk budget) SMALL | MID | FULL split points.
ENTRY_SMALL_MAX = 0.15
ENTRY_FULL_MIN = 0.5

#: mean exit-clip fraction (of the held position per sell) CLIP | CHUNK | FULL split points.
EXIT_CLIP_MAX = 0.25
EXIT_FULL_MIN = 0.75

#: Style-axis bin labels, in ascending-threshold order (used to compose ``style_cell`` ids).
STYLE_ENTRY_BINS: tuple[str, ...] = ("SMALL", "MID", "FULL")
STYLE_EXIT_BINS: tuple[str, ...] = ("CLIP", "CHUNK", "FULL")


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
    # Fine style axes (defaults keep older constructions valid). ``mean_exit_clip`` defaults to 1.0:
    # an agent with no self-driven exits realizes its whole book in one forced close — economically a
    # single full-stack exit, so it bins as FULL rather than pretending to clip.
    mean_entry_size: float = 0.0  # mean size fraction on BUY fills (open_long/add), 0..1
    mean_exit_clip: float = 1.0  # mean fraction of the position sold per exit fill, 0..1


@dataclass(frozen=True)
class CurveMetrics:
    """Equity-curve read-out over the held-out episodes — gate inputs + luck-vs-skill diagnostics.

    Computed on the agent's REALIZED cross-episode equity path (additive, one unit of risk budget per
    the eval's per-token funding convention; see :func:`equity_curve`). The first three fields feed the
    admission gate (:mod:`.admission`): ``min_equity`` (the ruin check), ``max_drawdown`` (deepest
    peak-to-trough retrace, in budget units), and ``loss_escalation`` (tail-half vs early-half mean
    loss size — the martingale signature; 1.0 = stable "premium"-sized losses). Deliberately NO
    smoothness/monotonicity score: in a fat-tailed market a flat-or-bleeding stretch before a sudden
    step up is a legitimate positive-skew shape, so shape alone is never gated on.

    ``pnl_share_top`` (fraction of total positive pnl carried by the single best episode; ``None``
    when total pnl <= 0) and ``pnl_split_bps`` (mean pnl over the first vs second half of the
    held-out episode sequence) are recorded DIAGNOSTICS, not admission filters — with 40–300 held-out
    tokens a real rare-event strategy may catch 1–2 runners per window, so hard-gating on
    concentration would false-negative genuine skill.
    """

    final_equity: float  # equity at the end of the path (start = 1.0 budget unit)
    min_equity: float  # lowest point on the path (the ruin-gate input)
    max_drawdown: float  # deepest peak-to-trough drop, in budget units (>= 0)
    loss_escalation: float  # mean(|late-half losses|) / mean(|early-half losses|); 1.0 = stable
    n_losses: int  # realized loss events observed (escalation needs enough of them)
    pnl_share_top: float | None  # best episode's share of total positive pnl (diagnostic)
    pnl_split_bps: tuple[float, float]  # mean pnl bps, first vs second half of the eval (diagnostic)


#: The benign default curve: a flat path that never lost — used for empty/synthetic profiles.
BENIGN_CURVE = CurveMetrics(
    final_equity=1.0, min_equity=1.0, max_drawdown=0.0, loss_escalation=1.0,
    n_losses=0, pnl_share_top=None, pnl_split_bps=(0.0, 0.0),
)

#: Below this many realized loss events the escalation ratio is 1.0 (insufficient evidence — loose
#: by design, per the calibrate-loose directive: never reject on a handful of losses).
MIN_LOSSES_FOR_ESCALATION = 8


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
    # Style + equity-curve extensions (defaults keep older constructions valid).
    entry_sizes: tuple[float, ...] = ()  # size fractions on BUY fills only
    exit_clips: tuple[float, ...] = ()  # per-sell clip fraction (trim size; close = 1.0)
    equity_marks: tuple[float, ...] = ()  # cumulative realized return (of budget) at realize events
    loss_fracs: tuple[float, ...] = ()  # |realized loss| per losing realize event, chronological


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
    #: Held-out equity-curve metrics (gate inputs + diagnostics). Defaults to the benign flat curve
    #: so synthetic/legacy constructions stay valid and pass the admission gate untouched.
    curve: CurveMetrics = BENIGN_CURVE


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
    entry_sizes: list[float] = []
    exit_clips: list[float] = []
    equity_marks: list[float] = []
    loss_fracs: list[float] = []
    cum_realized = 0.0
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
            size = float(info.get("size", 0.0))  # type: ignore[arg-type]
            if intent in _SIZED_INTENTS:
                sizes.append(size)
            if intent in _BUY_INTENTS:
                n_buys += 1
                entry_sizes.append(size)
                if not position_open:
                    position_open = True
                    entry_time = as_of if isinstance(as_of, datetime) else None
                    if first_entry_step is None:
                        first_entry_step = n_steps
            elif intent in _SELL_INTENTS:
                n_sells += 1
                # The clip fraction of the held position this exit realized: a trim sells its size
                # fraction; a close always sells the whole remaining book (sim contract).
                exit_clips.append(size if intent == "trim" else 1.0)
                if position_open and intent == "close":
                    if entry_time is not None and isinstance(as_of, datetime):
                        hold_secs.append((as_of - entry_time).total_seconds())
                    position_open = False
                    entry_time = None
        # Realized-equity marks: the step's booked realized pnl (never unrealized — same discipline
        # as the reward path) moves the intra-episode equity path; losses feed the discipline gate.
        realized = float(info.get("realized_pnl_quote", 0.0))  # type: ignore[arg-type]
        if realized != 0.0 and initial_balance > 0:
            cum_realized += realized
            equity_marks.append(cum_realized / initial_balance)
            if realized < 0.0:
                loss_fracs.append(-realized / initial_balance)
        n_steps += 1
        done = result.terminated or result.truncated
        # A position still open at the episode boundary is realized by the env's forced liquidation;
        # close its hold span at the last decision instant so a buy-and-hold style has a real duration.
        if done and position_open and entry_time is not None and isinstance(as_of, datetime):
            hold_secs.append((as_of - entry_time).total_seconds())
        obs = result.observation

    episode = env.close_episode()
    total_realized = float(episode.realized_pnl_quote) if episode is not None else 0.0
    return_pct = total_realized / initial_balance if initial_balance > 0 else 0.0
    # A forced end-of-episode liquidation books pnl the per-step info never showed; close the equity
    # path at the episode's true realized total, and count a losing residual as a real loss event.
    residual = return_pct - (equity_marks[-1] if equity_marks else 0.0)
    if residual != 0.0:
        equity_marks.append(return_pct)
        if residual < 0.0:
            loss_fracs.append(-residual)
    return BehaviorSample(
        return_pct=return_pct,
        n_steps=n_steps,
        n_trades=n_buys + n_sells,
        n_buys=n_buys,
        n_sells=n_sells,
        first_entry_step=first_entry_step,
        hold_secs=tuple(hold_secs),
        sizes=tuple(sizes),
        entry_sizes=tuple(entry_sizes),
        exit_clips=tuple(exit_clips),
        equity_marks=tuple(equity_marks),
        loss_fracs=tuple(loss_fracs),
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
    all_entry_sizes = [z for s in samples for z in s.entry_sizes]
    all_clips = [c for s in samples for c in s.exit_clips]
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
        mean_entry_size=sum(all_entry_sizes) / len(all_entry_sizes) if all_entry_sizes else 0.0,
        mean_exit_clip=sum(all_clips) / len(all_clips) if all_clips else 1.0,
    )
    return BehaviorProfile(
        pnl_bps=pnl_bps,
        win_rate=win_rate,
        n_trades=total_trades,
        mean_hold_secs=mean_hold,
        descriptor=descriptor,
        n_tokens=n_tokens,
        curve=compute_curve_metrics(samples),
    )


# ---------------------------------------------------------------------------
# Equity-curve metrics — the admission-gate inputs + luck-vs-skill diagnostics (pure)
# ---------------------------------------------------------------------------


def equity_curve(samples: list[BehaviorSample]) -> list[float]:
    """The agent's realized cross-episode equity path, starting at 1.0 unit of risk budget.

    Follows the eval's per-token funding convention (each episode independently funded, fitness the
    SUM/mean of per-token returns): episodes are chained ADDITIVELY in held-out order, each episode
    contributing its intra-episode realized marks offset by the equity already banked. Realized-only —
    the path moves exactly when pnl is booked, never on unrealized marks.
    """
    points = [1.0]
    offset = 1.0
    for sample in samples:
        marks = sample.equity_marks or ((sample.return_pct,) if sample.return_pct != 0.0 else ())
        points.extend(offset + m for m in marks)
        offset += sample.return_pct
    return points


def max_drawdown(curve: list[float]) -> float:
    """Deepest peak-to-trough drop along ``curve``, in budget units (0.0 for a monotone path).

    Duration-agnostic on purpose: a plateau at (or a shallow range just below) the high-water mark
    costs only its depth, so flat-then-step-up shapes score clean while deep retraces of
    previously-held equity do not. This is why drawdown DEPTH — not any smoothness measure — is the
    curve-shape gate.
    """
    peak = float("-inf")
    worst = 0.0
    for value in curve:
        peak = max(peak, value)
        worst = max(worst, peak - value)
    return worst


def loss_escalation_ratio(losses: list[float]) -> float:
    """Tail-half vs early-half mean loss size — the martingale signature (1.0 = stable premiums).

    Splits the chronological realized-loss sequence in half and returns
    ``mean(|late|) / mean(|early|)``. A disciplined agent pays roughly stable-size "premiums" (ratio
    ~1); an agent doubling down after losses shows a growing tail (ratio >> 1). With fewer than
    :data:`MIN_LOSSES_FOR_ESCALATION` losses the evidence is too thin and the ratio is 1.0 — loose by
    design, per the calibrate-loose directive.
    """
    if len(losses) < MIN_LOSSES_FOR_ESCALATION:
        return 1.0
    half = len(losses) // 2
    early = sum(losses[:half]) / half
    late = sum(losses[half:]) / (len(losses) - half)
    return late / early if early > 0.0 else 1.0


def compute_curve_metrics(samples: list[BehaviorSample]) -> CurveMetrics:
    """Fold the per-episode samples into the :class:`CurveMetrics` the admission gate reads (pure)."""
    if not samples:
        return BENIGN_CURVE
    curve = equity_curve(samples)
    losses = [loss for s in samples for loss in s.loss_fracs]
    returns = [s.return_pct for s in samples]
    total = sum(returns)
    best = max(returns)
    share = best / total if total > 0.0 and best > 0.0 else None
    half = len(samples) // 2
    if half == 0:
        split = (returns[0] * 10_000.0, returns[0] * 10_000.0)
    else:
        split = (
            (sum(returns[:half]) / half) * 10_000.0,
            (sum(returns[half:]) / (len(returns) - half)) * 10_000.0,
        )
    return CurveMetrics(
        final_equity=curve[-1],
        min_equity=min(curve),
        max_drawdown=max_drawdown(curve),
        loss_escalation=loss_escalation_ratio(losses),
        n_losses=len(losses),
        pnl_share_top=share,
        pnl_split_bps=split,
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


def _entry_bin(mean_entry_size: float) -> str:
    """SMALL (<0.15) | MID | FULL (>=0.5) entry-sizing style."""
    if mean_entry_size < ENTRY_SMALL_MAX:
        return STYLE_ENTRY_BINS[0]
    if mean_entry_size < ENTRY_FULL_MIN:
        return STYLE_ENTRY_BINS[1]
    return STYLE_ENTRY_BINS[2]


def _exit_bin(mean_exit_clip: float) -> str:
    """CLIP (<=0.25 per exit) | CHUNK | FULL (>=0.75, the single-exit full-stack) exit style."""
    if mean_exit_clip <= EXIT_CLIP_MAX:
        return STYLE_EXIT_BINS[0]
    if mean_exit_clip < EXIT_FULL_MIN:
        return STYLE_EXIT_BINS[1]
    return STYLE_EXIT_BINS[2]


def bin_style_cell(descriptor: BehavioralDescriptor) -> str:
    """Map a descriptor to its FINE 4-axis style cell (pure): ``"<ROLE>:<ENTRY>:<EXIT>"``.

    The full grid is freq(3) × hold(2) × entry-size(3) × exit-clip(3) = **54 cells**; the first two
    axes are exactly :func:`bin_descriptor`, so every style cell projects onto its 6-role coarse
    niche by construction (``cell.split(":")[0]``). The desk viz keeps rendering the six roles; the
    fine cell travels only as additive champion telemetry (``style_cell``), letting the archive
    illuminate sizing/exit style without touching the 6-desk console contract.
    """
    role = bin_descriptor(descriptor)
    return f"{role}:{_entry_bin(descriptor.mean_entry_size)}:{_exit_bin(descriptor.mean_exit_clip)}"


def style_grid() -> tuple[str, ...]:
    """Every fine style cell, in display order (role-major): 6 roles × 3 entry × 3 exit = 54."""
    return tuple(
        f"{role}:{entry}:{exit_}"
        for role in MEMECOIN_ROLES
        for entry in STYLE_ENTRY_BINS
        for exit_ in STYLE_EXIT_BINS
    )


__all__ = [
    "MEMECOIN_ROLES",
    "FREQ_LOW_MAX",
    "FREQ_HIGH_MIN",
    "HOLD_SHORT_MAX_SECS",
    "ENTRY_SMALL_MAX",
    "ENTRY_FULL_MIN",
    "EXIT_CLIP_MAX",
    "EXIT_FULL_MIN",
    "STYLE_ENTRY_BINS",
    "STYLE_EXIT_BINS",
    "MIN_LOSSES_FOR_ESCALATION",
    "BENIGN_CURVE",
    "CurveMetrics",
    "BehavioralDescriptor",
    "BehaviorSample",
    "BehaviorProfile",
    "behavioral_rollout",
    "profile_policy",
    "summarize_behavior",
    "bin_descriptor",
    "bin_style_cell",
    "style_grid",
    "equity_curve",
    "max_drawdown",
    "loss_escalation_ratio",
    "compute_curve_metrics",
]
