"""Trial-runner harness — incumbent vs challenger on ONE knob, verdict pre-registered (§07 rung 2).

Formalizes the config-A/B discipline of 07-improvement-loop.md §3: any config change that claims to
help runs head-to-head against the incumbent on a bounded slice — same dataset snapshot, same seed,
same budget flags — and the keep/revert criterion is written into the spec BEFORE the run, then
applied mechanically to both arms' outputs. The verdict is a recommendation record appended to
``data/postmortem/trials.jsonl``; nothing is auto-applied.

A trial spec is a small JSON file::

    {
      "name": "mutation-sigma-0.08",
      "trainer": "map_elites",                       // map_elites | pbt | train_market
      "base_args": ["--dataset", "data/market_dataset_snap800", "--tokens", "120",
                     "--seed", "0", "--init-population", "12", "--iterations", "48",
                     "--device", "cuda", "--torch-threads", "2"],
      "knob_flag": "--mutation-sigma",               // the ONE difference between the arms
      "incumbent": "0.05",
      "challenger": "0.08",
      "out_dir": "data/postmortem/trials/mutation-sigma-0.08",
      "criterion": [                                  // KEEP iff EVERY clause holds
        {"metric": "best_pnl_bps", "op": ">", "margin": 0.0},
        {"metric": "coverage", "op": ">=", "margin": 0.0}
      ],
      "criterion_text": "keep iff challenger held-out best_pnl_bps beats incumbent AND coverage >= incumbent"
    }

Metric sources are trainer-specific: the population trainers (``map_elites``, ``pbt``) are read
from their desk-telemetry JSON's FINAL generation (``best_pnl_bps``, ``mean_pnl_bps``,
``coverage``); ``train_market`` has no machine-readable output, so its arms are read from the
captured stdout log's final rung report (metrics ``edge_vs_<baseline>_mean`` /
``edge_vs_<baseline>_beaten``, e.g. ``edge_vs_hold_sol_mean``).

``--dry-run`` validates a spec and prints both arm commands without running anything — use it
while a big run owns the machine.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Spec
# ---------------------------------------------------------------------------

TRAINER_MODULES: dict[str, str] = {
    "map_elites": "oct_trading_agent.agent.population.map_elites",
    "pbt": "oct_trading_agent.agent.population.pbt",
    "train_market": "oct_trading_agent.agent.train_market",
}

#: Metrics readable from the population trainers' desk-telemetry final generation.
TELEMETRY_METRICS = ("best_pnl_bps", "mean_pnl_bps", "coverage")
#: train_market metrics are parsed from the rung report text; names follow this shape.
_LADDER_METRIC_RE = re.compile(r"^edge_vs_[a-z0-9_]+_(mean|beaten)$")
#: The rung-report line the ladder metrics come from (train_market.py's report renderer).
_LADDER_LINE_RE = re.compile(
    r"edge vs (?P<baseline>\w+)\s*:\s*mean=(?P<mean>[+-]?[0-9.]+)\s+beaten=\s*(?P<beaten>[0-9.]+)%"
)

_OPS = (">", ">=")
#: Arms run with conservative thread caps so a trial never monopolizes a shared machine.
_THREAD_CAP_ENV = {"OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2"}


@dataclass(frozen=True)
class Clause:
    """One pre-registered criterion clause: challenger.metric OP incumbent.metric + margin."""

    metric: str
    op: str  # ">" or ">="
    margin: float = 0.0

    def holds(self, challenger: float, incumbent: float) -> bool:
        target = incumbent + self.margin
        return challenger > target if self.op == ">" else challenger >= target

    def describe(self) -> str:
        margin = f" + {self.margin}" if self.margin else ""
        return f"challenger.{self.metric} {self.op} incumbent.{self.metric}{margin}"


@dataclass(frozen=True)
class TrialSpec:
    """The whole pre-registration: arms, shared flags, the single knob delta, and the criterion."""

    name: str
    trainer: str
    base_args: tuple[str, ...]
    knob_flag: str
    incumbent: str
    challenger: str
    out_dir: str
    criterion: tuple[Clause, ...]
    criterion_text: str

    @classmethod
    def from_dict(cls, doc: Mapping[str, Any]) -> TrialSpec:
        return cls(
            name=str(doc["name"]),
            trainer=str(doc["trainer"]),
            base_args=tuple(str(a) for a in doc.get("base_args", [])),
            knob_flag=str(doc["knob_flag"]),
            incumbent=str(doc["incumbent"]),
            challenger=str(doc["challenger"]),
            out_dir=str(doc["out_dir"]),
            criterion=tuple(
                Clause(
                    metric=str(c["metric"]),
                    op=str(c.get("op", ">")),
                    margin=float(c.get("margin", 0.0)),
                )
                for c in doc.get("criterion", [])
            ),
            criterion_text=str(doc.get("criterion_text", "")),
        )

    @classmethod
    def from_file(cls, path: Path) -> TrialSpec:
        return cls.from_dict(json.loads(path.read_text(encoding="utf-8")))

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "trainer": self.trainer,
            "base_args": list(self.base_args),
            "knob_flag": self.knob_flag,
            "incumbent": self.incumbent,
            "challenger": self.challenger,
            "out_dir": self.out_dir,
            "criterion": [
                {"metric": c.metric, "op": c.op, "margin": c.margin} for c in self.criterion
            ],
            "criterion_text": self.criterion_text,
        }


def _metric_valid(trainer: str, metric: str) -> bool:
    if trainer in ("map_elites", "pbt"):
        return metric in TELEMETRY_METRICS
    return bool(_LADDER_METRIC_RE.match(metric))


def validate_spec(spec: TrialSpec) -> list[str]:
    """All the ways a spec can be malformed; an empty list means it is runnable."""
    problems: list[str] = []
    if spec.trainer not in TRAINER_MODULES:
        problems.append(f"unknown trainer {spec.trainer!r} (know: {sorted(TRAINER_MODULES)})")
    if not spec.knob_flag.startswith("--"):
        problems.append(f"knob_flag {spec.knob_flag!r} must be a CLI flag (--...)")
    if spec.incumbent == spec.challenger:
        problems.append("incumbent and challenger values are identical — nothing to trial")
    if spec.knob_flag in spec.base_args:
        problems.append(
            f"base_args already carry {spec.knob_flag} — the knob must differ ONLY via the arms"
        )
    if "--out" in spec.base_args:
        problems.append("base_args must not carry --out; the harness assigns per-arm outputs")
    if not spec.criterion:
        problems.append("criterion is empty — the keep/revert rule must be pre-registered")
    if not spec.criterion_text.strip():
        problems.append("criterion_text is empty — write the rule down in words too")
    for clause in spec.criterion:
        if clause.op not in _OPS:
            problems.append(f"clause {clause.metric}: op must be one of {_OPS}, got {clause.op!r}")
        if spec.trainer in TRAINER_MODULES and not _metric_valid(spec.trainer, clause.metric):
            problems.append(
                f"clause metric {clause.metric!r} not readable from {spec.trainer} output "
                f"(telemetry metrics: {TELEMETRY_METRICS}; ladder metrics: edge_vs_<baseline>_mean/_beaten)"
            )
    if not spec.name.strip():
        problems.append("name is empty")
    return problems


# ---------------------------------------------------------------------------
# Arm commands + metric extraction
# ---------------------------------------------------------------------------


def arm_command(spec: TrialSpec, arm: str, *, python: str = sys.executable) -> list[str]:
    """The exact subprocess command for one arm (``incumbent`` or ``challenger``)."""
    value = {"incumbent": spec.incumbent, "challenger": spec.challenger}[arm]
    cmd = [python, "-m", TRAINER_MODULES[spec.trainer], *spec.base_args, spec.knob_flag, value]
    if spec.trainer in ("map_elites", "pbt"):
        cmd += ["--out", str(Path(spec.out_dir) / f"{arm}.json")]
        if "--torch-threads" not in spec.base_args:
            cmd += ["--torch-threads", "2"]
    return cmd


def extract_telemetry_metrics(doc: Mapping[str, Any]) -> dict[str, float]:
    """Final-generation metrics from a desk-telemetry document (population trainers)."""
    gens = doc.get("generations")
    if not isinstance(gens, list) or not gens:
        raise ValueError("telemetry document has no generations")
    final = gens[-1]
    if not isinstance(final, dict):
        raise ValueError("telemetry final generation is not an object")
    return {name: float(final[name]) for name in TELEMETRY_METRICS}


def parse_ladder_metrics(text: str) -> dict[str, float]:
    """Ladder metrics from captured ``train_market`` stdout — the LAST rung's edge lines win."""
    metrics: dict[str, float] = {}
    for match in _LADDER_LINE_RE.finditer(text):
        baseline = match.group("baseline")
        metrics[f"edge_vs_{baseline}_mean"] = float(match.group("mean"))
        metrics[f"edge_vs_{baseline}_beaten"] = float(match.group("beaten")) / 100.0
    if not metrics:
        raise ValueError("no 'edge vs <baseline>' lines found in the captured ladder report")
    return metrics


def arm_metrics(spec: TrialSpec, arm: str) -> dict[str, float]:
    """Read one finished arm's metrics from its output artifact."""
    out_dir = Path(spec.out_dir)
    if spec.trainer in ("map_elites", "pbt"):
        doc = json.loads((out_dir / f"{arm}.json").read_text(encoding="utf-8"))
        if not isinstance(doc, dict):
            raise ValueError(f"{arm}.json is not a telemetry object")
        return extract_telemetry_metrics(doc)
    return parse_ladder_metrics((out_dir / f"{arm}.log").read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# The mechanical verdict
# ---------------------------------------------------------------------------


def apply_criterion(
    criterion: Sequence[Clause],
    incumbent: Mapping[str, float],
    challenger: Mapping[str, float],
) -> tuple[str, list[dict[str, Any]]]:
    """Apply the pre-registered clauses to both arms' metrics. KEEP iff every clause holds.

    Purely mechanical: no judgment enters here — that is the point. Missing metrics are an error,
    never a silent pass.
    """
    results: list[dict[str, Any]] = []
    all_hold = True
    for clause in criterion:
        if clause.metric not in incumbent or clause.metric not in challenger:
            raise KeyError(f"criterion metric {clause.metric!r} missing from an arm's metrics")
        inc = float(incumbent[clause.metric])
        cha = float(challenger[clause.metric])
        holds = clause.holds(cha, inc)
        all_hold = all_hold and holds
        results.append(
            {
                "clause": clause.describe(),
                "incumbent": inc,
                "challenger": cha,
                "holds": holds,
            }
        )
    return ("KEEP" if all_hold else "REVERT"), results


# ---------------------------------------------------------------------------
# Running a trial (sequential subprocesses, bounded, thread-capped)
# ---------------------------------------------------------------------------


def _run_arm(cmd: Sequence[str], log_path: Path) -> None:  # pragma: no cover - subprocess IO
    env = dict(os.environ)
    env.update(_THREAD_CAP_ENV)
    with log_path.open("w", encoding="utf-8") as log:
        subprocess.run(
            list(cmd), stdout=log, stderr=subprocess.STDOUT, env=env, check=True, text=True
        )


def run_trial(
    spec: TrialSpec,
    *,
    trials_path: Path,
    python: str = sys.executable,
    now: str | None = None,
) -> dict[str, Any]:  # pragma: no cover - subprocess IO (verdict logic is unit-tested pure)
    """Run both arms sequentially, apply the criterion, append + return the verdict record."""
    problems = validate_spec(spec)
    if problems:
        raise ValueError("spec invalid: " + "; ".join(problems))
    out_dir = Path(spec.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    commands: dict[str, list[str]] = {}
    for arm in ("incumbent", "challenger"):
        cmd = arm_command(spec, arm, python=python)
        commands[arm] = cmd
        print(f"[trial:{spec.name}] running {arm}: {' '.join(cmd)}")
        _run_arm(cmd, out_dir / f"{arm}.log")
    incumbent = arm_metrics(spec, "incumbent")
    challenger = arm_metrics(spec, "challenger")
    verdict, clauses = apply_criterion(spec.criterion, incumbent, challenger)
    record = {
        "created_at": now or datetime.now(UTC).isoformat(timespec="seconds"),
        "spec": spec.to_dict(),
        "commands": commands,
        "metrics": {"incumbent": incumbent, "challenger": challenger},
        "clauses": clauses,
        "verdict": verdict,
        "criterion_text": spec.criterion_text,
        "note": "recommendation record only — the operator applies or discards it by hand",
    }
    trials_path.parent.mkdir(parents=True, exist_ok=True)
    with trials_path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, sort_keys=True) + "\n")
    print(f"[trial:{spec.name}] verdict: {verdict}  ({spec.criterion_text})")
    return record


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", type=str, required=True, help="trial spec JSON path")
    parser.add_argument("--dry-run", action="store_true", help="validate + print commands, run nothing")
    parser.add_argument("--trials-out", type=str, default="data/postmortem/trials.jsonl")
    parser.add_argument("--python", type=str, default=sys.executable, help="interpreter for the arms")
    parser.add_argument("--now", type=str, default=None, help="override the recorded timestamp (ISO 8601)")
    args = parser.parse_args(argv)

    spec = TrialSpec.from_file(Path(args.spec))
    problems = validate_spec(spec)
    if problems:
        print(f"[trial:{spec.name}] spec INVALID:")
        for p in problems:
            print(f"  - {p}")
        return 1
    if args.dry_run:
        print(f"[trial:{spec.name}] spec valid. criterion: {spec.criterion_text}")
        for clause in spec.criterion:
            print(f"  clause: {clause.describe()}")
        for arm in ("incumbent", "challenger"):
            print(f"  {arm}: {' '.join(arm_command(spec, arm, python=args.python))}")
        print("dry run — nothing executed.")
        return 0
    run_trial(spec, trials_path=Path(args.trials_out), python=args.python, now=args.now)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())


__all__ = [
    "TRAINER_MODULES",
    "TELEMETRY_METRICS",
    "Clause",
    "TrialSpec",
    "validate_spec",
    "arm_command",
    "extract_telemetry_metrics",
    "parse_ladder_metrics",
    "arm_metrics",
    "apply_criterion",
    "run_trial",
    "main",
]
