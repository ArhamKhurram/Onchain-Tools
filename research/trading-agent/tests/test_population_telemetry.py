"""Niche-archive accumulation + desk-telemetry export tests. TORCH-FREE.

Two things are pinned: (1) the archive is a streaming per-niche accumulator — binning a batch of
agents in two halves gives the same archive as binning them all at once (so the population never has
to be resident whole), and (2) the exported document matches the ``desk-telemetry-schema.md`` contract
exactly, validated by :func:`validate_desk_document` (which the shipped reference fixture also passes,
cross-checking the validator itself).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from oct_trading_agent.agent.population.archive import AgentReport, NicheArchive
from oct_trading_agent.agent.population.descriptor import (
    MEMECOIN_ROLES,
    BehavioralDescriptor,
    BehaviorProfile,
)
from oct_trading_agent.agent.population.telemetry import (
    COST_BPS,
    DeskTelemetryWriter,
    aggregate_generation,
    generation_from_archive,
)


def _report(agent_id: str, *, freq: float, hold: float, pnl_bps: float) -> AgentReport:
    """A synthetic report whose descriptor lands it in a known niche and whose fitness we control."""
    desc = BehavioralDescriptor(
        trade_frequency=freq, mean_hold_secs=hold,
        entry_latency_frac=0.3, sell_ratio=0.5, mean_size=0.5,
    )
    profile = BehaviorProfile(
        pnl_bps=pnl_bps, win_rate=0.5, n_trades=10, mean_hold_secs=hold,
        descriptor=desc, n_tokens=4,
    )
    return AgentReport(agent_id=agent_id, profile=profile)


def _one_archive(reports: list[AgentReport]) -> NicheArchive:
    archive = NicheArchive()
    archive.add_batch(reports)
    return archive


def _mixed_batch() -> list[AgentReport]:
    return [
        _report("a0", freq=0.30, hold=10.0, pnl_bps=-10.0),  # GOBLIN
        _report("a1", freq=0.30, hold=10.0, pnl_bps=+25.0),  # GOBLIN (champion)
        _report("a2", freq=0.02, hold=10.0, pnl_bps=-50.0),  # GREMLIN
        _report("a3", freq=0.02, hold=200.0, pnl_bps=+5.0),  # GIZMO
        _report("a4", freq=0.12, hold=200.0, pnl_bps=-30.0),  # PICKLE
    ]


# ---------------------------------------------------------------------------
# Schema validator (structural, per desk-telemetry-schema.md)
# ---------------------------------------------------------------------------


def validate_desk_document(doc: dict[str, Any]) -> None:
    """Assert ``doc`` matches the telemetry contract shape. Raises AssertionError on any mismatch."""
    assert doc["desk_type"] in {"memecoin", "equities"}
    assert isinstance(doc["run_id"], str) and doc["run_id"]
    assert doc["algo"] in {"pbt", "map_elites"}
    roles = doc["roles"]
    assert isinstance(roles, list) and len(roles) == 6 and all(isinstance(r, str) for r in roles)
    assert isinstance(doc["cost_bps"], int)
    assert isinstance(doc["generations"], list)
    for gen in doc["generations"]:
        assert isinstance(gen["gen"], int)
        assert isinstance(gen["population_size"], int)
        assert 0.0 <= gen["coverage"] <= 1.0
        assert isinstance(gen["best_pnl_bps"], (int, float))
        assert isinstance(gen["mean_pnl_bps"], (int, float))
        desks = gen["desks"]
        assert len(desks) == len(roles)
        assert [d["role"] for d in desks] == roles  # one desk per role, in display order
        for desk in desks:
            assert isinstance(desk["occupancy"], int) and desk["occupancy"] >= 0
            assert isinstance(desk["events"], list) and len(desk["events"]) <= 4
            if desk["occupancy"] == 0:
                assert desk["median_pnl_bps"] is None
                assert desk["champion"] is None
            else:
                assert isinstance(desk["median_pnl_bps"], (int, float))
                champ = desk["champion"]
                assert isinstance(champ["agent_id"], str) and champ["agent_id"]
                assert isinstance(champ["pnl_bps"], (int, float))
                assert isinstance(champ["trades"], int)
                assert 0.0 <= champ["win_rate"] <= 1.0
                assert isinstance(champ["hold_secs"], int)
                assert isinstance(champ["status"], str)


def test_validator_accepts_the_reference_fixture() -> None:
    """Cross-check: the shipped schema-valid fixture must pass our validator (guards the validator)."""
    fixture = Path(__file__).resolve().parents[1] / "desk_telemetry_fixture.json"
    if not fixture.exists():  # fixture lives in the scratchpad in CI-less local runs
        import pytest

        pytest.skip("reference fixture not present")
    validate_desk_document(json.loads(fixture.read_text(encoding="utf-8")))


def test_archive_accumulates_incrementally() -> None:
    """Binning a batch in two halves equals binning it whole — the streaming property that scales."""
    reports = _mixed_batch()
    whole = NicheArchive()
    whole.add_batch(reports)
    split = NicheArchive()
    split.add_batch(reports[:2])
    split.add_batch(reports[2:])

    assert split.total == whole.total == 5
    for role in MEMECOIN_ROLES:
        assert split.occupancy(role) == whole.occupancy(role)
    assert split.coverage == whole.coverage
    assert split.best_pnl_bps == whole.best_pnl_bps == 25.0


def test_archive_champion_is_best_occupant() -> None:
    archive = NicheArchive()
    archive.add_batch(_mixed_batch())
    goblin = archive.champion("GOBLIN")
    assert goblin is not None and goblin.agent_id == "a1"  # the +25 bps GOBLIN, not the -10
    assert archive.occupancy("GOBLIN") == 2
    assert archive.champion("NOODLE") is None  # no HIGH-freq LONG-hold agent in the batch
    assert archive.occupancy("GECKO") == 0


def test_generation_shape_matches_schema() -> None:
    gen = aggregate_generation(_mixed_batch(), gen=0, population_size=5)
    validate_desk_document(
        {
            "desk_type": "memecoin", "run_id": "unit", "algo": "pbt",
            "roles": list(MEMECOIN_ROLES), "cost_bps": COST_BPS, "generations": [gen],
        }
    )
    # occupancy sums to the population; coverage is filled/6.
    assert sum(d["occupancy"] for d in gen["desks"]) == 5
    filled = sum(1 for d in gen["desks"] if d["occupancy"] > 0)
    assert gen["coverage"] == round(filled / 6, 3)


def test_generation_from_archive_matches_aggregate() -> None:
    reports = _mixed_batch()
    archive = NicheArchive()
    archive.add_batch(reports)
    assert generation_from_archive(archive, gen=2, population_size=5) == aggregate_generation(
        reports, gen=2, population_size=5
    )


def test_writer_grows_a_valid_document(tmp_path: Path) -> None:
    """The writer appends generations and always leaves a valid, complete snapshot on disk."""
    out = tmp_path / "sub" / "telemetry.json"
    writer = DeskTelemetryWriter(out, run_id="pbt-unit-seed0")

    a0 = NicheArchive()
    a0.add_batch(_mixed_batch())
    writer.add_generation(a0, gen=0, population_size=5)

    a1 = NicheArchive()
    a1.add_batch([_report("b0", freq=0.30, hold=200.0, pnl_bps=40.0)])  # a NOODLE appears
    writer.add_generation(a1, gen=1, population_size=1)

    doc = json.loads(out.read_text(encoding="utf-8"))
    validate_desk_document(doc)
    assert [g["gen"] for g in doc["generations"]] == [0, 1]
    noodle_desk = next(d for d in doc["generations"][1]["desks"] if d["role"] == "NOODLE")
    assert noodle_desk["occupancy"] == 1 and noodle_desk["champion"]["agent_id"] == "b0"


def test_events_are_real_run_derived_facts() -> None:
    """The squawk feed must state true facts about the run — first-fill, champion stat, deltas."""
    # gen 0: GOBLIN gets its first two occupants (champion a1 at +25 bps).
    g0 = aggregate_generation(_mixed_batch(), gen=0, population_size=5)
    goblin0 = next(d for d in g0["desks"] if d["role"] == "GOBLIN")
    assert "niche filled at gen 0" in goblin0["events"]
    assert "champion +25 bps · 10 trades" in goblin0["events"]
    empty0 = next(d for d in g0["desks"] if d["role"] == "NOODLE")
    assert empty0["events"] == []  # an empty niche squawks nothing

    # gen 1: the GOBLIN champion improves to +60 bps and the niche grows 2 -> 3.
    g1 = generation_from_archive(
        _one_archive(
            [
                _report("c0", freq=0.30, hold=10.0, pnl_bps=+60.0),  # GOBLIN, new champion
                _report("c1", freq=0.30, hold=10.0, pnl_bps=-5.0),  # GOBLIN
                _report("c2", freq=0.30, hold=10.0, pnl_bps=-9.0),  # GOBLIN
            ]
        ),
        gen=1,
        population_size=3,
        prev_generation=g0,
    )
    goblin1 = next(d for d in g1["desks"] if d["role"] == "GOBLIN")
    assert "new champion, +35 bps over prior" in goblin1["events"]  # 60 - 25
    assert "champion +60 bps · 10 trades" in goblin1["events"]
    assert "occupancy 2 -> 3" in goblin1["events"]
    assert len(goblin1["events"]) <= 4
