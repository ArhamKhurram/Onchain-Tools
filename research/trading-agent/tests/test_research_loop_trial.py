"""Trial harness: spec validation, mechanical KEEP/REVERT on mocked telemetry, dry-run CLI."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from oct_trading_agent.research_loop.trial import (
    Clause,
    TrialSpec,
    apply_criterion,
    arm_command,
    extract_telemetry_metrics,
    main,
    parse_ladder_metrics,
    validate_spec,
)


def _spec(**overrides: Any) -> TrialSpec:
    doc: dict[str, Any] = {
        "name": "mutation-sigma-0.08",
        "trainer": "map_elites",
        "base_args": ["--dataset", "data/market_dataset_snap800", "--tokens", "120", "--seed", "0"],
        "knob_flag": "--mutation-sigma",
        "incumbent": "0.05",
        "challenger": "0.08",
        "out_dir": "data/postmortem/trials/mutation-sigma-0.08",
        "criterion": [
            {"metric": "best_pnl_bps", "op": ">", "margin": 0.0},
            {"metric": "coverage", "op": ">=", "margin": 0.0},
        ],
        "criterion_text": "keep iff challenger best_pnl_bps beats incumbent AND coverage >= incumbent",
    }
    doc.update(overrides)
    return TrialSpec.from_dict(doc)


# ---------------------------------------------------------------------------
# Spec validation
# ---------------------------------------------------------------------------


def test_valid_spec_passes() -> None:
    assert validate_spec(_spec()) == []


def test_identical_arms_rejected() -> None:
    problems = validate_spec(_spec(challenger="0.05"))
    assert any("identical" in p for p in problems)


def test_knob_flag_in_base_args_rejected() -> None:
    spec = _spec(base_args=["--dataset", "d", "--mutation-sigma", "0.1"])
    assert any("ONLY via the arms" in p for p in validate_spec(spec))


def test_unknown_metric_rejected_per_trainer() -> None:
    spec = _spec(criterion=[{"metric": "edge_vs_hold_sol_mean", "op": ">"}])
    assert any("not readable" in p for p in validate_spec(spec))
    ladder = _spec(trainer="train_market", criterion=[{"metric": "edge_vs_hold_sol_mean", "op": ">"}])
    assert validate_spec(ladder) == []


def test_missing_criterion_rejected() -> None:
    assert any("pre-registered" in p for p in validate_spec(_spec(criterion=[])))


# ---------------------------------------------------------------------------
# Arm commands
# ---------------------------------------------------------------------------


def test_arm_commands_differ_only_in_knob_value_and_out() -> None:
    spec = _spec()
    inc = arm_command(spec, "incumbent", python="py")
    cha = arm_command(spec, "challenger", python="py")
    assert inc[:3] == ["py", "-m", "oct_trading_agent.agent.population.map_elites"]
    assert inc[inc.index("--mutation-sigma") : inc.index("--mutation-sigma") + 2] == ["--mutation-sigma", "0.05"]
    assert cha[cha.index("--mutation-sigma") : cha.index("--mutation-sigma") + 2] == ["--mutation-sigma", "0.08"]
    assert "--out" in inc and "--out" in cha
    assert "--torch-threads" in inc  # cap injected when the base flags don't carry it


# ---------------------------------------------------------------------------
# Metric extraction + the mechanical verdict
# ---------------------------------------------------------------------------


def _telemetry(best: float, mean: float, coverage: float) -> dict[str, Any]:
    return {
        "generations": [
            {"gen": 0, "best_pnl_bps": 0.0, "mean_pnl_bps": -1.0, "coverage": 0.5},
            {"gen": 1, "best_pnl_bps": best, "mean_pnl_bps": mean, "coverage": coverage},
        ]
    }


def test_extract_telemetry_metrics_reads_final_generation() -> None:
    metrics = extract_telemetry_metrics(_telemetry(90.4, 21.4, 1.0))
    assert metrics == {"best_pnl_bps": 90.4, "mean_pnl_bps": 21.4, "coverage": 1.0}


def test_parse_ladder_metrics_reads_last_rung() -> None:
    text = (
        "  edge vs hold_sol     : mean=+0.6000  beaten= 55.0%\n"
        "...\n"
        "  edge vs hold_sol     : mean=+0.0023  beaten= 50.1%\n"
        "  edge vs buy_and_hold : mean=-0.0100  beaten= 48.0%\n"
    )
    metrics = parse_ladder_metrics(text)
    assert metrics["edge_vs_hold_sol_mean"] == 0.0023  # last occurrence wins
    assert metrics["edge_vs_buy_and_hold_beaten"] == 0.48


def test_criterion_keep_case() -> None:
    spec = _spec()
    verdict, clauses = apply_criterion(
        spec.criterion,
        extract_telemetry_metrics(_telemetry(50.0, 10.0, 1.0)),
        extract_telemetry_metrics(_telemetry(60.0, 5.0, 1.0)),
    )
    assert verdict == "KEEP"
    assert all(c["holds"] for c in clauses)


def test_criterion_revert_when_any_clause_fails() -> None:
    spec = _spec()
    # Better pnl but coverage regressed -> the coverage clause fails -> REVERT.
    verdict, clauses = apply_criterion(
        spec.criterion,
        extract_telemetry_metrics(_telemetry(50.0, 10.0, 1.0)),
        extract_telemetry_metrics(_telemetry(60.0, 5.0, 0.833)),
    )
    assert verdict == "REVERT"
    assert [c["holds"] for c in clauses] == [True, False]


def test_criterion_margin_and_op_are_mechanical() -> None:
    clause = Clause(metric="best_pnl_bps", op=">=", margin=5.0)
    assert clause.holds(15.0, 10.0)
    assert not clause.holds(14.9, 10.0)
    with pytest.raises(KeyError):
        apply_criterion([Clause(metric="coverage", op=">")], {"best_pnl_bps": 1.0}, {"best_pnl_bps": 2.0})


# ---------------------------------------------------------------------------
# CLI dry-run (validates without executing anything)
# ---------------------------------------------------------------------------


def test_dry_run_validates_and_runs_nothing(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(_spec(out_dir=str(tmp_path / "arms")).to_dict()), encoding="utf-8")
    assert main(["--spec", str(spec_path), "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "spec valid" in out
    assert "nothing executed" in out
    assert not (tmp_path / "arms").exists()


def test_dry_run_reports_invalid_spec(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(
        json.dumps(_spec(challenger="0.05").to_dict()), encoding="utf-8"
    )
    assert main(["--spec", str(spec_path), "--dry-run"]) == 1
    assert "INVALID" in capsys.readouterr().out
