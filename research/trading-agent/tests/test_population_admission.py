"""Admission-gate + fine-style-grid tests (``agent/population/admission`` & descriptor axes). TORCH-FREE.

Pins the operator directives (2026-08-24) as invariants:

* a RUINED agent (equity path lost ~all the risk budget) never holds an archive niche, never serves
  as a champion, and never serves as a PBT exploit source — no matter how large its pnl;
* the curve gate reads loss DISCIPLINE (drawdown depth + loss escalation), never SHAPE — a
  flat-or-bleed-then-sudden-step-up path (the legitimate positive-skew profile) passes while a deep
  retrace or a martingale-style escalating loss tail fails;
* the fine sizing/exit style grid (54 cells) refines — never replaces — the 6-role projection the
  desk viz renders, and every telemetry addition is additive (the 6-role contract stays valid).
"""

from __future__ import annotations

import numpy as np
import pytest

from oct_trading_agent.agent.population.admission import (
    VERDICT_DRAWDOWN,
    VERDICT_LOSS_ESCALATION,
    VERDICT_RUINED,
    AdmissionConfig,
    admission_verdict,
    is_admissible,
)
from oct_trading_agent.agent.population.archive import AgentReport, NicheArchive
from oct_trading_agent.agent.population.descriptor import (
    MEMECOIN_ROLES,
    BehavioralDescriptor,
    BehaviorProfile,
    BehaviorSample,
    CurveMetrics,
    bin_descriptor,
    bin_style_cell,
    compute_curve_metrics,
    equity_curve,
    max_drawdown,
    style_grid,
    summarize_behavior,
)
from oct_trading_agent.agent.population.map_elites import Elite, EliteArchive
from oct_trading_agent.agent.population.pbt import select_exploit_explore

# ---------------------------------------------------------------------------
# Synthetic fixtures
# ---------------------------------------------------------------------------


def _sample(
    return_pct: float,
    *,
    equity_marks: tuple[float, ...] = (),
    loss_fracs: tuple[float, ...] = (),
    entry_sizes: tuple[float, ...] = (),
    exit_clips: tuple[float, ...] = (),
) -> BehaviorSample:
    return BehaviorSample(
        return_pct=return_pct, n_steps=20, n_trades=4, n_buys=2, n_sells=2,
        first_entry_step=1, hold_secs=(30.0,), sizes=(0.5,),
        entry_sizes=entry_sizes, exit_clips=exit_clips,
        equity_marks=equity_marks, loss_fracs=loss_fracs,
    )


def _curve(
    *, min_equity: float = 1.0, drawdown: float = 0.0, escalation: float = 1.0
) -> CurveMetrics:
    return CurveMetrics(
        final_equity=max(min_equity, 1.0), min_equity=min_equity, max_drawdown=drawdown,
        loss_escalation=escalation, n_losses=10, pnl_share_top=None, pnl_split_bps=(0.0, 0.0),
    )


def _profile(
    *, freq: float = 0.30, hold: float = 10.0, pnl_bps: float = 10.0,
    curve: CurveMetrics | None = None,
    entry_size: float = 0.5, exit_clip: float = 1.0,
) -> BehaviorProfile:
    desc = BehavioralDescriptor(
        trade_frequency=freq, mean_hold_secs=hold, entry_latency_frac=0.3,
        sell_ratio=0.5, mean_size=0.5, mean_entry_size=entry_size, mean_exit_clip=exit_clip,
    )
    return BehaviorProfile(
        pnl_bps=pnl_bps, win_rate=0.5, n_trades=10, mean_hold_secs=hold,
        descriptor=desc, n_tokens=4, curve=curve if curve is not None else _curve(),
    )


CFG = AdmissionConfig()  # the loose defaults: ruin 0.2, drawdown 0.5, escalation 3.0


# ---------------------------------------------------------------------------
# Equity-curve math: plateaus + jumps score clean, deep retraces do not
# ---------------------------------------------------------------------------


def test_equity_curve_chains_episodes_additively() -> None:
    samples = [
        _sample(0.1, equity_marks=(0.05, 0.1)),
        _sample(-0.02, equity_marks=(-0.02,)),
    ]
    assert equity_curve(samples) == [1.0, 1.05, 1.1, 1.08]


def test_max_drawdown_is_zero_for_flat_then_step_up() -> None:
    """The operator's blessed shapes — steady up, or flat/range then a sudden step — carry no depth."""
    assert max_drawdown([1.0, 1.0, 1.0, 1.5, 1.5, 2.0]) == 0.0  # plateau -> jump -> plateau -> jump
    assert max_drawdown([1.0, 0.99, 1.0, 0.99, 1.5]) == pytest.approx(0.01)  # shallow range -> jump


def test_max_drawdown_measures_the_deep_retrace() -> None:
    assert max_drawdown([1.0, 1.6, 1.05]) == pytest.approx(0.55)  # gave back previously-held equity


def test_flat_bleed_then_spike_is_admissible() -> None:
    """Positive-skew (barbell) shapes must pass: many small stable losses, one late big win."""
    marks = tuple(-0.01 * i for i in range(1, 11))  # a slow -10% bleed of small, equal premiums...
    losses = (0.01,) * 10
    samples = [
        _sample(-0.1, equity_marks=marks, loss_fracs=losses),
        _sample(0.9, equity_marks=(0.9,)),  # ...then the sudden step up
    ]
    profile = summarize_behavior(samples)
    assert profile.curve.max_drawdown == pytest.approx(0.1)
    assert profile.curve.loss_escalation == pytest.approx(1.0)
    assert admission_verdict(profile, CFG) is None


def test_deep_drawdown_curve_is_rejected() -> None:
    """Winning big then giving most of it back breaches the drawdown-depth gate."""
    samples = [
        _sample(0.6, equity_marks=(0.6,)),
        _sample(-0.55, equity_marks=(-0.55,), loss_fracs=(0.55,)),
    ]
    profile = summarize_behavior(samples)
    assert profile.curve.max_drawdown == pytest.approx(0.55)
    assert admission_verdict(profile, CFG) == VERDICT_DRAWDOWN


def test_escalating_losses_are_rejected_stable_losses_pass() -> None:
    """The martingale signature: a growing loss tail fails; equal-size premiums do not."""
    stable = [_sample(-0.08, loss_fracs=(0.01,) * 8, equity_marks=(-0.08,))]
    escalating = [
        _sample(-0.24, loss_fracs=(0.01, 0.01, 0.01, 0.01, 0.05, 0.05, 0.05, 0.05),
                equity_marks=(-0.24,))
    ]
    assert admission_verdict(summarize_behavior(stable), CFG) is None
    profile = summarize_behavior(escalating)
    assert profile.curve.loss_escalation == pytest.approx(5.0)
    assert admission_verdict(profile, CFG) == VERDICT_LOSS_ESCALATION


def test_too_few_losses_never_trigger_escalation() -> None:
    """Loose by design: a handful of losses is not evidence of doubling down."""
    few = [_sample(-0.05, loss_fracs=(0.01, 0.04), equity_marks=(-0.05,))]
    assert summarize_behavior(few).curve.loss_escalation == 1.0


def test_ruin_floor_dominates_every_other_gate() -> None:
    samples = [_sample(-0.85, equity_marks=(-0.4, -0.85), loss_fracs=(0.4, 0.45))]
    profile = summarize_behavior(samples)
    assert profile.curve.min_equity == pytest.approx(0.15)
    assert admission_verdict(profile, CFG) == VERDICT_RUINED


def test_disabled_gate_admits_everything() -> None:
    ruined = _profile(curve=_curve(min_equity=0.0, drawdown=1.0))
    assert admission_verdict(ruined, AdmissionConfig(enabled=False)) is None


def test_diagnostics_are_recorded_but_never_gate() -> None:
    """Concentration (one episode carries all pnl) is a diagnostic — the profile stays admissible."""
    samples = [_sample(0.0), _sample(0.0), _sample(0.0), _sample(0.5, equity_marks=(0.5,))]
    metrics = compute_curve_metrics(samples)
    assert metrics.pnl_share_top == pytest.approx(1.0)  # 100% of pnl from the single best episode
    assert metrics.pnl_split_bps == pytest.approx((0.0, 2500.0))  # time-disjoint halves disagree
    assert is_admissible(summarize_behavior(samples), CFG)


# ---------------------------------------------------------------------------
# MAP-Elites admission: a ruined agent never holds a niche, whatever its pnl
# ---------------------------------------------------------------------------


def test_ruined_elite_never_admitted_even_with_best_pnl() -> None:
    archive = EliteArchive()
    ruined = Elite(
        agent_id="lucky",
        profile=_profile(pnl_bps=99_999.0, curve=_curve(min_equity=0.1, drawdown=0.9)),
    )
    role, took = archive.try_add(ruined)
    assert took is False
    assert archive.get(role) is None  # the niche stays EMPTY rather than host a ruined agent
    assert archive.ruined == 1 and archive.admitted == 0 and archive.considered == 1

    # A modest but disciplined agent then takes the same cell.
    _, took_ok = archive.try_add(Elite(agent_id="steady", profile=_profile(pnl_bps=1.0)))
    assert took_ok is True
    champ = archive.get(role)
    assert champ is not None and champ.agent_id == "steady"


def test_curve_rejected_elite_counts_separately_from_ruined() -> None:
    archive = EliteArchive()
    archive.try_add(Elite(agent_id="deep", profile=_profile(curve=_curve(drawdown=0.9))))
    archive.try_add(Elite(agent_id="martingale", profile=_profile(curve=_curve(escalation=9.0))))
    archive.try_add(Elite(agent_id="dead", profile=_profile(curve=_curve(min_equity=0.05))))
    assert archive.curve_rejected == 2 and archive.ruined == 1 and archive.size == 0


def test_elite_archive_restore_carries_gate_tallies() -> None:
    archive = EliteArchive()
    archive.try_add(Elite(agent_id="dead", profile=_profile(curve=_curve(min_equity=0.0))))
    archive.try_add(Elite(agent_id="ok", profile=_profile(pnl_bps=5.0)))
    restored = EliteArchive.restore(
        archive.elites(), considered=archive.considered, admitted=archive.admitted,
        ruined=archive.ruined, curve_rejected=archive.curve_rejected,
    )
    assert restored.ruined == 1 and restored.curve_rejected == 0
    assert restored.filled_roles() == archive.filled_roles()


# ---------------------------------------------------------------------------
# PBT: ruined members are never champions, never exploit sources, always reseeded
# ---------------------------------------------------------------------------


def test_niche_archive_never_crowns_an_inadmissible_champion() -> None:
    archive = NicheArchive(admission=CFG)
    archive.add(AgentReport("lucky", _profile(pnl_bps=500.0, curve=_curve(min_equity=0.1))))
    archive.add(AgentReport("steady", _profile(pnl_bps=2.0)))
    role = bin_descriptor(_profile().descriptor)
    champ = archive.champion(role)
    assert champ is not None and champ.agent_id == "steady"  # not the +500 ruined one
    assert archive.occupancy(role) == 1  # the ruined agent is excluded from the census entirely
    assert archive.best_pnl_bps == 2.0  # a barred lottery curve can't headline the run
    assert archive.ruined == 1


def test_exploit_selection_never_copies_an_inadmissible_winner() -> None:
    rng = np.random.default_rng(0)
    fitnesses = [0.0, 1.0, 2.0, 3.0]
    admissible = [True, True, True, False]  # the top-fitness member is ruined
    pairs = select_exploit_explore(fitnesses, rng, exploit_frac=0.25, admissible=admissible)
    assert all(winner != 3 for _, winner in pairs)  # never an exploit source...
    assert any(loser == 3 for loser, _ in pairs)  # ...and always reseeded
    # And with no admissible member at all, there is nothing safe to copy.
    assert select_exploit_explore(fitnesses, rng, admissible=[False] * 4) == []


def test_exploit_selection_unchanged_when_all_admissible() -> None:
    rng = np.random.default_rng(7)
    fitnesses = [3.0, 1.0, 2.0, 0.0]
    with_mask = select_exploit_explore(fitnesses, np.random.default_rng(7), admissible=[True] * 4)
    without = select_exploit_explore(fitnesses, rng)
    assert with_mask == without


# ---------------------------------------------------------------------------
# Fine style grid: 54 cells, projecting onto the unchanged 6-role grid
# ---------------------------------------------------------------------------


def test_style_grid_enumerates_54_unique_cells() -> None:
    cells = style_grid()
    assert len(cells) == 54 == len(set(cells))
    assert all(cell.split(":")[0] in MEMECOIN_ROLES for cell in cells)


def test_style_cell_projects_onto_the_role_grid() -> None:
    """The coarse 6-role projection is exactly bin_descriptor — the viz contract is untouched."""
    for freq, hold in [(0.02, 10.0), (0.12, 10.0), (0.30, 10.0), (0.02, 200.0), (0.30, 200.0)]:
        for entry, clip in [(0.05, 0.1), (0.3, 0.5), (0.9, 1.0)]:
            profile = _profile(freq=freq, hold=hold, entry_size=entry, exit_clip=clip)
            cell = bin_style_cell(profile.descriptor)
            assert cell.split(":")[0] == bin_descriptor(profile.descriptor)


def test_style_cell_bins_sizing_and_exit_styles() -> None:
    desc = _profile(freq=0.30, hold=10.0).descriptor  # GOBLIN territory
    assert bin_style_cell(_profile(entry_size=0.05, exit_clip=0.10).descriptor).endswith("SMALL:CLIP")
    assert bin_style_cell(_profile(entry_size=0.30, exit_clip=0.50).descriptor).endswith("MID:CHUNK")
    assert bin_style_cell(_profile(entry_size=0.80, exit_clip=1.00).descriptor).endswith("FULL:FULL")
    assert bin_style_cell(desc).startswith("GOBLIN:")
    # Boundary semantics: 0.25 is still a clip; 0.75 is already a full-stack exit.
    assert bin_style_cell(_profile(exit_clip=0.25).descriptor).endswith(":CLIP")
    assert bin_style_cell(_profile(exit_clip=0.75).descriptor).endswith(":FULL")


def test_summarize_bins_synthetic_action_streams_into_expected_cells() -> None:
    """Sizing/exit statistics folded from raw per-episode streams land in the expected style cell."""
    clipper = [
        _sample(0.02, entry_sizes=(0.1, 0.1), exit_clips=(0.1, 0.1, 0.1, 0.1, 1.0))
        for _ in range(3)
    ]
    profile = summarize_behavior(clipper)
    assert profile.descriptor.mean_entry_size == pytest.approx(0.1)
    assert profile.descriptor.mean_exit_clip == pytest.approx(0.28)
    assert bin_style_cell(profile.descriptor).endswith("SMALL:CHUNK")

    fullstack = [_sample(0.02, entry_sizes=(0.9,), exit_clips=(1.0,))]
    assert bin_style_cell(summarize_behavior(fullstack).descriptor).endswith("FULL:FULL")

    # No self-driven exits: the whole book realizes in one forced close -> a full-stack single exit.
    no_exit = [_sample(0.02, entry_sizes=(0.9,), exit_clips=())]
    assert bin_style_cell(summarize_behavior(no_exit).descriptor).endswith("FULL:FULL")


# ---------------------------------------------------------------------------
# Telemetry: additive fields land, the 6-role contract stays valid
# ---------------------------------------------------------------------------


def test_generation_carries_gate_tallies_and_champion_style_fields() -> None:
    from oct_trading_agent.agent.population.telemetry import COST_BPS, generation_from_archive
    from tests.test_population_telemetry import validate_desk_document

    reports = [
        AgentReport("ok", _profile(pnl_bps=8.0, entry_size=0.6, exit_clip=0.2)),
        AgentReport("dead", _profile(pnl_bps=900.0, curve=_curve(min_equity=0.1))),
    ]
    archive = NicheArchive(admission=CFG)
    archive.add_batch(reports)
    gen = generation_from_archive(archive, gen=0, population_size=2)

    assert gen["ruined"] == 1 and gen["curve_rejected"] == 0
    doc = {
        "desk_type": "memecoin", "run_id": "unit", "algo": "map_elites",
        "roles": list(MEMECOIN_ROLES), "cost_bps": COST_BPS, "generations": [gen],
    }
    validate_desk_document(doc)  # the additive fields never break the 6-role contract

    champ = next(d["champion"] for d in gen["desks"] if d["occupancy"] > 0)
    assert champ["agent_id"] == "ok"
    assert champ["style_cell"] == "GOBLIN:FULL:CLIP"
    assert champ["max_drawdown"] == 0.0 and champ["final_equity"] == 1.0
    assert champ["loss_escalation"] == 1.0
    assert champ["pnl_share_top"] is None and champ["pnl_split_bps"] == [0.0, 0.0]
