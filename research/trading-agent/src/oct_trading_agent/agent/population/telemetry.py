"""Desk-telemetry exporter — the niche archive → the viz JSON contract (``desk-telemetry-schema.md``). TORCH-FREE.

The producer half of the single JSON contract the desk-console visualization consumes. Each reported
generation, the :class:`~oct_trading_agent.agent.population.archive.NicheArchive` — the per-niche
state accumulated from that generation's mini-batches — is rendered into the schema's per-niche form
(an occupancy count, a median pnl, and ONE champion per role) and appended to a growing
``generations[]`` timeline. Because only the archive is rendered, the file carries only
``O(roles × generations)`` rows, never one per agent, so it scales unchanged from a 24-agent smoke run
to a population of tens of thousands.

Nothing here shapes training — it is a pure, honest read-out. ``cost_bps`` declares the cost regime
every ``pnl_bps`` is net of (the sim's modeled fees / slippage / price impact); the numbers are the
after-cost, held-out-token figures the trainer measured.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from .archive import AgentReport, NicheArchive
from .checkpoint import atomic_write_text
from .descriptor import MEMECOIN_ROLES, BehaviorProfile, bin_style_cell

DESK_TYPE = "memecoin"
ALGO = "pbt"  # default producer label; MAP-Elites passes algo="map_elites" (schema's other value)
COST_BPS = 125  # the modeled-cost regime every reported pnl_bps is net of (05-evaluation-plan.md)

# Role-keyed status line for the champion sprite — a short GOOFY flavor string (matching the goofy
# codenames), not a market event and not a behavioral claim.
_ROLE_STATUS: dict[str, str] = {
    "GOBLIN": "cackling in the mempool",
    "GREMLIN": "gnawing on a cable",
    "GIZMO": "whirring quietly",
    "NOODLE": "doing the wiggle",
    "PICKLE": "brined and waiting",
    "GECKO": "stuck to the glass",
}


def _champion_payload(report: AgentReport, role: str) -> dict[str, Any]:
    profile: BehaviorProfile = report.profile
    curve = profile.curve
    return {
        "agent_id": report.agent_id,
        "pnl_bps": round(profile.pnl_bps, 1),
        "trades": int(profile.n_trades),
        "win_rate": round(profile.win_rate, 2),
        "hold_secs": round(profile.mean_hold_secs),
        "status": _ROLE_STATUS[role],
        # -- additive fields (schema §additions; the 6-role viz contract ignores them) ------------
        "style_cell": bin_style_cell(profile.descriptor),  # fine 54-cell sizing/exit style id
        "final_equity": round(curve.final_equity, 3),
        "max_drawdown": round(curve.max_drawdown, 3),
        "loss_escalation": round(curve.loss_escalation, 2),
        # Luck-vs-skill DIAGNOSTICS (recorded, never gated on): pnl concentration + repeatability.
        "pnl_share_top": round(curve.pnl_share_top, 2) if curve.pnl_share_top is not None else None,
        "pnl_split_bps": [round(curve.pnl_split_bps[0], 1), round(curve.pnl_split_bps[1], 1)],
    }


def _desk_events(
    *, occupancy: int, champion: dict[str, Any] | None, prev_desk: dict[str, Any] | None, gen: int
) -> list[str]:
    """0..4 short feed lines for a niche, each a TRUE, checkable fact about THIS run.

    Derived only from the population — a niche first-filling, its champion's realized pnl/trades, a
    champion improving on the prior generation, or an occupancy change. No invented tickers or market
    events; the desk console's squawk feed shows real training telemetry. Ordered most-newsworthy first.
    """
    if occupancy == 0:
        return []
    prev_occ = int(prev_desk["occupancy"]) if prev_desk else 0
    prev_champ = prev_desk["champion"] if prev_desk else None
    events: list[str] = []
    if prev_occ == 0:
        events.append(f"niche filled at gen {gen}")
    if champion is not None:
        if prev_champ is not None and champion["pnl_bps"] > prev_champ["pnl_bps"]:
            delta = champion["pnl_bps"] - prev_champ["pnl_bps"]
            events.append(f"new champion, {delta:+.0f} bps over prior")
        events.append(f"champion {champion['pnl_bps']:+.0f} bps · {champion['trades']} trades")
    if prev_desk is not None and occupancy != prev_occ:
        events.append(f"occupancy {prev_occ} -> {occupancy}")
    return events[:4]


def generation_from_archive(
    archive: NicheArchive,
    *,
    gen: int,
    population_size: int,
    prev_generation: dict[str, Any] | None = None,
    ruined: int | None = None,
    curve_rejected: int | None = None,
) -> dict[str, Any]:
    """Render one generation's :class:`NicheArchive` into the schema's per-niche ``Generation``.

    One desk per role (occupancy 0 allowed), each carrying its occupancy, the median pnl over its
    occupants (``null`` when empty), its champion (``null`` when empty), and a feed of true, run-derived
    ``events``. Population stats (coverage, best/mean pnl) come straight off the archive's roll-ups.
    ``prev_generation`` (the previous rendered generation) lets the events state deltas — champion
    improvement, occupancy change, first-fill; pass ``None`` for a standalone generation.

    ``ruined`` / ``curve_rejected`` (ADDITIVE fields, cumulative for the run) default to the
    archive's own admission counters; MAP-Elites overrides them with its :class:`EliteArchive`
    counters, since its rendered snapshot is a fresh archive of already-admitted elites.
    """
    prev_desks: dict[str, dict[str, Any]] = (
        {d["role"]: d for d in prev_generation["desks"]} if prev_generation else {}
    )
    desks: list[dict[str, Any]] = []
    for role in MEMECOIN_ROLES:
        occupancy = archive.occupancy(role)
        champion = archive.champion(role)
        median = archive.median_pnl_bps(role)
        champion_payload = _champion_payload(champion, role) if champion is not None else None
        desks.append(
            {
                "role": role,
                "occupancy": occupancy,
                "median_pnl_bps": round(median, 1) if median is not None else None,
                "champion": champion_payload,
                "events": _desk_events(
                    occupancy=occupancy, champion=champion_payload,
                    prev_desk=prev_desks.get(role), gen=gen,
                ),
            }
        )
    return {
        "gen": gen,
        "population_size": population_size,
        "coverage": round(archive.coverage, 3),
        "best_pnl_bps": round(archive.best_pnl_bps, 1),
        "mean_pnl_bps": round(archive.mean_pnl_bps, 1),
        # Additive admission-gate tallies (cumulative for the run; 0 when gating is off).
        "ruined": archive.ruined if ruined is None else ruined,
        "curve_rejected": archive.curve_rejected if curve_rejected is None else curve_rejected,
        "desks": desks,
    }


def aggregate_generation(
    reports: list[AgentReport], *, gen: int, population_size: int
) -> dict[str, Any]:
    """Convenience: bin a full list of reports into a fresh archive and render the generation.

    Equivalent to feeding the reports through a :class:`NicheArchive` in one batch — the whole-list
    path for callers that already hold every report; the mini-batch path (``add_batch`` per batch)
    reaches the same result without the whole population resident at once.
    """
    archive = NicheArchive()
    archive.add_batch(reports)
    return generation_from_archive(archive, gen=gen, population_size=population_size)


class DeskTelemetryWriter:
    """Accumulates ``Generation`` entries and writes the growing contract JSON after each one.

    Constructed once per run with a stable ``run_id`` (and the producing ``algo`` — ``"pbt"`` or
    ``"map_elites"``); :meth:`add_generation` renders a generation's :class:`NicheArchive` to
    per-niche form and re-writes the whole file, so the telemetry on disk is always a valid, complete
    snapshot the viz can poll mid-run.
    """

    def __init__(
        self,
        out_path: Path,
        *,
        run_id: str,
        algo: str = ALGO,
        generations: Iterable[dict[str, Any]] | None = None,
    ) -> None:
        self._out_path = out_path
        self._run_id = run_id
        self._algo = algo
        # ``generations`` seeds a RESUMED run with the timeline persisted in its checkpoint, so the
        # growing contract picks up exactly where the killed run left off instead of restarting at gen 0.
        self._generations: list[dict[str, Any]] = list(generations) if generations else []

    def add_generation(
        self,
        archive: NicheArchive,
        *,
        gen: int,
        population_size: int,
        ruined: int | None = None,
        curve_rejected: int | None = None,
    ) -> dict[str, Any]:
        generation = generation_from_archive(
            archive, gen=gen, population_size=population_size,
            prev_generation=self._generations[-1] if self._generations else None,
            ruined=ruined, curve_rejected=curve_rejected,
        )
        self._generations.append(generation)
        self.flush()
        return generation

    @property
    def generations(self) -> list[dict[str, Any]]:
        """The rendered-generation timeline so far — captured into a checkpoint so resume continues it."""
        return self._generations

    def document(self) -> dict[str, Any]:
        return {
            "desk_type": DESK_TYPE,
            "run_id": self._run_id,
            "algo": self._algo,
            "roles": list(MEMECOIN_ROLES),
            "cost_bps": COST_BPS,
            "generations": self._generations,
        }

    def flush(self) -> None:
        # Atomic (temp file + rename): a kill mid-flush can't leave the viz a truncated, unparseable JSON.
        atomic_write_text(self._out_path, json.dumps(self.document(), indent=2))


__all__ = [
    "DESK_TYPE",
    "ALGO",
    "COST_BPS",
    "AgentReport",
    "NicheArchive",
    "generation_from_archive",
    "aggregate_generation",
    "DeskTelemetryWriter",
]
