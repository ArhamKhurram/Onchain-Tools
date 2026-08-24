"""Post-mortem module: band enforcement, suggestion rules on synthetic telemetry, queue gating."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from oct_trading_agent.research_loop.postmortem import (
    KNOB_BANDS,
    STATUS_ACCEPTED,
    STATUS_PENDING,
    STATUS_REJECTED,
    Evidence,
    OutOfBandError,
    append_suggestions,
    build_suggestions,
    decide,
    improvements_after_seed,
    load_queue,
    load_runs,
    make_suggestion,
)

NOW = "2026-08-24T12:00:00+00:00"


def _telemetry_doc(
    *,
    run_id: str,
    algo: str,
    coverages: list[float],
    bests: list[float],
    means: list[float] | None = None,
    win_rates: list[tuple[str, float, int]] | None = None,
    admission: bool = False,
) -> dict[str, Any]:
    roles = ["GOBLIN", "GREMLIN", "GIZMO", "NOODLE", "PICKLE", "GECKO"]
    means = means or [b / 2 for b in bests]
    gens = []
    for g, (cov, best, mean) in enumerate(zip(coverages, bests, means, strict=True)):
        desks: list[dict[str, Any]] = [{"role": r, "occupancy": 0, "median_pnl_bps": None, "champion": None, "events": []} for r in roles]
        for i, (role, wr, trades) in enumerate(win_rates or []):
            desks[i] = {
                "role": role,
                "occupancy": 1,
                "median_pnl_bps": best,
                "champion": {
                    "agent_id": f"a{i}", "pnl_bps": best, "trades": trades,
                    "win_rate": wr, "hold_secs": 10, "status": "idle",
                },
                "events": [],
            }
        gen: dict[str, Any] = {
            "gen": g,
            "population_size": 6,
            "coverage": cov,
            "best_pnl_bps": best,
            "mean_pnl_bps": mean,
            "desks": desks,
        }
        if admission:
            gen["ruined"] = 0
            gen["curve_rejected"] = 1
        gens.append(gen)
    return {
        "desk_type": "memecoin",
        "run_id": run_id,
        "algo": algo,
        "roles": roles,
        "cost_bps": 125,
        "generations": gens,
    }


def _write(tmp_path: Path, name: str, doc: dict[str, Any]) -> None:
    (tmp_path / name).write_text(json.dumps(doc), encoding="utf-8")


# ---------------------------------------------------------------------------
# Band enforcement
# ---------------------------------------------------------------------------


def test_out_of_band_proposal_is_rejected() -> None:
    band = KNOB_BANDS["map_elites.mutation_sigma"]
    with pytest.raises(OutOfBandError):
        make_suggestion(
            knob="map_elites.mutation_sigma",
            proposed=band.hi + 0.01,
            evidence=[Evidence("x.json", "made up")],
            rationale="too far",
            created_at=NOW,
        )


def test_unknown_knob_is_rejected() -> None:
    with pytest.raises(OutOfBandError):
        make_suggestion(
            knob="map_elites.reward_shape",  # a mechanism, not a declared knob
            proposed=1.0,
            evidence=[Evidence("x.json", "made up")],
            rationale="mechanisms are human work",
            created_at=NOW,
        )


def test_integer_band_rejects_fractional_proposal() -> None:
    with pytest.raises(OutOfBandError):
        make_suggestion(
            knob="map_elites.batch_size",
            proposed=8.5,
            evidence=[Evidence("x.json", "made up")],
            rationale="not an integer",
            created_at=NOW,
        )


def test_in_band_proposal_carries_band_flag_and_evidence() -> None:
    s = make_suggestion(
        knob="pbt.exploit_frac",
        proposed=0.15,
        evidence=[Evidence("pbt.json", "coverage fell")],
        rationale="slow the copying",
        created_at=NOW,
    )
    assert s.status == STATUS_PENDING
    assert s.flag == "--exploit-frac"
    assert s.band == (0.05, 0.5)
    assert s.current == 0.25  # the config default
    assert s.id.startswith("pm-")


def test_every_declared_band_brackets_its_default() -> None:
    for band in KNOB_BANDS.values():
        assert band.lo <= band.default <= band.hi, band.knob
        assert band.flag.startswith("--"), band.knob


# ---------------------------------------------------------------------------
# Findings arithmetic + suggestion rules on synthetic runs
# ---------------------------------------------------------------------------


def test_improvements_after_seed() -> None:
    assert improvements_after_seed([1.0, 1.0, 2.0, 2.0, 2.0]) == (1, 2)
    assert improvements_after_seed([5.0]) == (0, 0)
    assert improvements_after_seed([1.0, 2.0, 3.0]) == (2, 0)


def test_pbt_coverage_collapse_yields_bounded_exploit_frac_suggestion(tmp_path: Path) -> None:
    _write(tmp_path, "pbt.json", _telemetry_doc(
        run_id="pbt-x", algo="pbt",
        coverages=[0.667, 0.667, 0.5, 0.333], bests=[10, 20, 30, 40],
    ))
    _write(tmp_path, "me.json", _telemetry_doc(
        run_id="me-x", algo="map_elites",
        coverages=[0.8, 1.0, 1.0, 1.0], bests=[10, 20, 30, 40],
    ))
    runs = load_runs(tmp_path)
    suggestions = build_suggestions(runs, created_at=NOW)
    assert [s.knob for s in suggestions] == ["pbt.exploit_frac"]
    s = suggestions[0]
    assert s.band[0] <= s.proposed <= s.band[1]
    assert any("pbt.json" in e.file for e in s.evidence)
    assert s.created_at == NOW


def test_widespread_stagnation_yields_mutation_sigma_suggestion(tmp_path: Path) -> None:
    flat = [10.0] * 9  # one improvement never happens after gen 0
    for i in range(3):
        _write(tmp_path, f"me{i}.json", _telemetry_doc(
            run_id=f"me-{i}", algo="map_elites", coverages=[1.0] * 9, bests=flat,
        ))
    runs = load_runs(tmp_path)
    suggestions = build_suggestions(runs, created_at=NOW)
    assert [s.knob for s in suggestions] == ["map_elites.mutation_sigma"]
    assert suggestions[0].proposed == 0.08
    assert len(suggestions[0].evidence) == 3


def test_healthy_runs_yield_zero_suggestions(tmp_path: Path) -> None:
    _write(tmp_path, "me.json", _telemetry_doc(
        run_id="me-x", algo="map_elites",
        coverages=[0.5, 0.8, 1.0, 1.0, 1.0, 1.0, 1.0],
        bests=[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0],  # improving every generation
    ))
    runs = load_runs(tmp_path)
    assert build_suggestions(runs, created_at=NOW) == []


# ---------------------------------------------------------------------------
# Queue: append-only emission, idempotence, accept/reject round trip
# ---------------------------------------------------------------------------


def _one_suggestion() -> Any:
    return make_suggestion(
        knob="map_elites.mutation_sigma",
        proposed=0.08,
        evidence=[Evidence("me.json", "flat best for 11 generations")],
        rationale="raise displacement odds",
        created_at=NOW,
    )


def test_queue_append_is_idempotent_and_decisions_round_trip(tmp_path: Path) -> None:
    queue = tmp_path / "queue.jsonl"
    s = _one_suggestion()
    assert [x.id for x in append_suggestions(queue, [s])] == [s.id]
    assert append_suggestions(queue, [s]) == []  # same id -> not re-queued

    other = make_suggestion(
        knob="pbt.exploit_frac", proposed=0.15,
        evidence=[Evidence("pbt.json", "coverage fell 0.667 -> 0.333")],
        rationale="slow the copying", created_at=NOW,
    )
    append_suggestions(queue, [other])

    accepted = decide(queue, s.id, status=STATUS_ACCEPTED, reason=None, decided_at=NOW)
    assert accepted["status"] == STATUS_ACCEPTED
    rejected = decide(queue, other.id, status=STATUS_REJECTED, reason="not yet", decided_at=NOW)
    assert rejected["reason"] == "not yet"

    records = {rec["id"]: rec for rec in load_queue(queue)}
    assert records[s.id]["status"] == STATUS_ACCEPTED
    assert records[other.id]["status"] == STATUS_REJECTED
    assert records[other.id]["decided_at"] == NOW


def test_decide_refuses_missing_and_already_decided(tmp_path: Path) -> None:
    queue = tmp_path / "queue.jsonl"
    s = _one_suggestion()
    append_suggestions(queue, [s])
    with pytest.raises(KeyError):
        decide(queue, "pm-nope", status=STATUS_ACCEPTED, reason=None, decided_at=NOW)
    decide(queue, s.id, status=STATUS_ACCEPTED, reason=None, decided_at=NOW)
    with pytest.raises(ValueError, match="already decided"):
        decide(queue, s.id, status=STATUS_REJECTED, reason="flip", decided_at=NOW)
