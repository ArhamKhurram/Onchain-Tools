"""Post-mortem module — read-only cross-run findings + a bounded, operator-gated suggestion queue.

The first rung of the §07 improvement-loop ladder (07-improvement-loop.md §1): a module that reads
the run artifacts this program already produces — the desk-telemetry JSONs under
``data/desk_telemetry/`` (contract: ``desk-telemetry-schema.md``) — computes cross-run findings
(coverage trajectories, champion stagnation, win-rate shape, admission-tally presence), and emits
**knob suggestions** into an append-only queue file. The discipline, carried over unchanged:

* **Bounded ranges only.** A suggestion moves an EXISTING config knob inside a band declared in
  :data:`KNOB_BANDS`; anything outside the band is refused at construction
  (:class:`OutOfBandError`). Mechanism proposals are structurally impossible here — the knob
  vocabulary is a closed set.
* **Evidence attached.** Every suggestion cites the telemetry files and the numbers that motivated
  it, so the operator reviews an argument, not a number.
* **Read-only, operator-gated.** This module writes ONLY the queue file. ``--accept`` /
  ``--reject`` record a decision in the queue and nothing else — no config file, trainer, or
  checkpoint is ever touched; an accepted knob is applied by hand in the next run's flags.

CLI (all paths default to the repo-layout locations)::

    python -m oct_trading_agent.research_loop.postmortem --emit      # analyze + queue suggestions
    python -m oct_trading_agent.research_loop.postmortem --list      # show the queue
    python -m oct_trading_agent.research_loop.postmortem --accept pm-xxxx
    python -m oct_trading_agent.research_loop.postmortem --reject pm-xxxx --reason "..."
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Knob bands — the closed vocabulary of what a suggestion may move, and how far
# ---------------------------------------------------------------------------

STATUS_PENDING = "pending"
STATUS_ACCEPTED = "accepted"
STATUS_REJECTED = "rejected"


class OutOfBandError(ValueError):
    """A proposed knob value fell outside its declared band (or the knob is unknown)."""


@dataclass(frozen=True)
class KnobBand:
    """One knob a suggestion is allowed to move: its trainer, CLI flag, default, and hard band."""

    knob: str  # canonical name, "<trainer>.<config_field>"
    trainer: str  # which entry point owns it (map_elites | pbt | shared admission)
    flag: str  # the existing CLI flag that applies it
    default: float  # the config default (the "current" when a run didn't override it)
    lo: float
    hi: float
    integer: bool = False

    def contains(self, value: float) -> bool:
        if self.integer and float(value) != float(int(value)):
            return False
        return self.lo <= float(value) <= self.hi


#: The declared bands — conservative on purpose. Every knob is an EXISTING config field with an
#: EXISTING CLI flag (map_elites.py / pbt.py); the band brackets the default without ever reaching
#: a regime the trainers weren't designed for. Widening a band is an operator edit, not a runtime one.
KNOB_BANDS: dict[str, KnobBand] = {
    band.knob: band
    for band in (
        KnobBand("map_elites.mutation_sigma", "map_elites", "--mutation-sigma", 0.05, 0.01, 0.15),
        KnobBand("map_elites.batch_size", "map_elites", "--batch-size", 8, 4, 32, integer=True),
        KnobBand("map_elites.init_population", "map_elites", "--init-population", 24, 8, 128, integer=True),
        KnobBand("map_elites.iterations", "map_elites", "--iterations", 96, 24, 512, integer=True),
        KnobBand("map_elites.train_steps_per_child", "map_elites", "--train-steps-per-child", 1, 0, 4, integer=True),
        KnobBand("pbt.exploit_frac", "pbt", "--exploit-frac", 0.25, 0.05, 0.5),
        KnobBand("pbt.population_size", "pbt", "--population", 24, 8, 64, integer=True),
        KnobBand("pbt.train_steps_per_gen", "pbt", "--train-steps-per-gen", 3, 1, 8, integer=True),
        KnobBand("admission.ruin_floor", "shared", "--ruin-floor", 0.2, 0.1, 0.4),
        KnobBand("admission.max_drawdown", "shared", "--max-drawdown", 0.5, 0.3, 0.7),
        KnobBand("admission.max_loss_escalation", "shared", "--max-loss-escalation", 3.0, 2.0, 5.0),
    )
}


# ---------------------------------------------------------------------------
# Telemetry loading — schema-tolerant read of the desk-telemetry contract
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RunSummary:
    """The per-run slice of the telemetry the findings need (aggregates only, O(generations))."""

    file: str  # basename, the evidence reference
    run_id: str
    algo: str
    n_generations: int
    coverage: tuple[float, ...]  # one per generation, oldest first
    best_pnl_bps: tuple[float, ...]
    mean_pnl_bps: tuple[float, ...]
    final_win_rates: tuple[tuple[str, float, int], ...]  # (role, win_rate, trades) per final champion
    has_admission_tallies: bool  # ruined/curve_rejected present in any generation


def load_run(path: Path) -> RunSummary | None:
    """Read one telemetry JSON into a :class:`RunSummary`; ``None`` if it isn't a telemetry doc."""
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(doc, dict) or "generations" not in doc or "roles" not in doc:
        return None
    gens_raw = doc.get("generations")
    if not isinstance(gens_raw, list) or not gens_raw:
        return None
    gens: list[dict[str, Any]] = [g for g in gens_raw if isinstance(g, dict)]
    if not gens:
        return None
    final = gens[-1]
    win_rates: list[tuple[str, float, int]] = []
    for desk in final.get("desks", []):
        champ = desk.get("champion") if isinstance(desk, dict) else None
        if isinstance(champ, dict):
            win_rates.append(
                (str(desk.get("role")), float(champ.get("win_rate", 0.0)), int(champ.get("trades", 0)))
            )
    return RunSummary(
        file=path.name,
        run_id=str(doc.get("run_id", path.stem)),
        algo=str(doc.get("algo", "unknown")),
        n_generations=len(gens),
        coverage=tuple(float(g.get("coverage", 0.0)) for g in gens),
        best_pnl_bps=tuple(float(g.get("best_pnl_bps", 0.0)) for g in gens),
        mean_pnl_bps=tuple(float(g.get("mean_pnl_bps", 0.0)) for g in gens),
        final_win_rates=tuple(win_rates),
        has_admission_tallies=any("ruined" in g or "curve_rejected" in g for g in gens),
    )


def load_runs(telemetry_dir: Path) -> list[RunSummary]:
    """Load every telemetry JSON in a directory (read-only), sorted by filename for stable output."""
    runs: list[RunSummary] = []
    for path in sorted(telemetry_dir.glob("*.json")):
        summary = load_run(path)
        if summary is not None:
            runs.append(summary)
    return runs


# ---------------------------------------------------------------------------
# Findings — cross-run facts, each carrying its evidence
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Evidence:
    """One evidence citation: which file, and the numbers read out of it."""

    file: str
    detail: str


@dataclass(frozen=True)
class Finding:
    """One cross-run fact. Findings are reported; only some of them justify a knob suggestion."""

    name: str
    summary: str
    evidence: tuple[Evidence, ...]


def improvements_after_seed(best: Sequence[float], *, eps: float = 1e-9) -> tuple[int, int]:
    """(number of generations after gen 0 where best improved, length of the trailing flat tail)."""
    improvements = 0
    trailing_flat = 0
    for g in range(1, len(best)):
        if best[g] > best[g - 1] + eps:
            improvements += 1
            trailing_flat = 0
        else:
            trailing_flat += 1
    return improvements, trailing_flat


#: Coverage is "collapsed" when the final generation lost at least this much vs generation 0.
COVERAGE_COLLAPSE_DROP = 0.25
#: A map-elites run is "stagnant" when best improved in <= this many post-seed generations ...
STAGNANT_MAX_IMPROVEMENTS = 2
#: ... AND the run ended with at least this many consecutive no-improvement generations.
STAGNANT_MIN_TRAILING_FLAT = 4
#: Champion win rates below this, across every niche, read as lottery-shaped (05-evaluation-plan).
LOTTERY_WIN_RATE = 0.25
#: Win-rate reads only count champions with at least this many held-out trades.
MIN_TRADES_FOR_WIN_RATE = 20


def coverage_finding(runs: Sequence[RunSummary]) -> Finding:
    """Coverage trajectory per run: PBT's exploit step erodes niches; the archive algos hold them."""
    evidence = [
        Evidence(
            r.file,
            f"algo={r.algo} coverage {r.coverage[0]:.3f} -> {r.coverage[-1]:.3f} "
            f"(min {min(r.coverage):.3f}) over {r.n_generations} generation(s)",
        )
        for r in runs
    ]
    collapsed = [r for r in runs if r.coverage[-1] <= r.coverage[0] - COVERAGE_COLLAPSE_DROP]
    held = [r for r in runs if r.coverage[-1] >= r.coverage[0]]
    return Finding(
        name="coverage_trajectory",
        summary=(
            f"{len(collapsed)} of {len(runs)} run(s) collapsed coverage by >= {COVERAGE_COLLAPSE_DROP} "
            f"({', '.join(r.file for r in collapsed) or 'none'}); {len(held)} held or grew it."
        ),
        evidence=tuple(evidence),
    )


def stagnation_finding(runs: Sequence[RunSummary]) -> Finding:
    """Champion progression in archive runs: how often best_pnl_bps actually moved after the seed."""
    evidence: list[Evidence] = []
    for r in runs:
        if r.algo != "map_elites" or r.n_generations < 6:
            continue
        improvements, flat = improvements_after_seed(r.best_pnl_bps)
        evidence.append(
            Evidence(
                r.file,
                f"best {r.best_pnl_bps[0]:+.1f} -> {r.best_pnl_bps[-1]:+.1f} bps; "
                f"{improvements} improvement generation(s) in {r.n_generations - 1} post-seed; "
                f"trailing flat tail {flat}",
            )
        )
    stagnant = sum(
        1
        for r in runs
        if r.algo == "map_elites"
        and r.n_generations >= 6
        and improvements_after_seed(r.best_pnl_bps)[0] <= STAGNANT_MAX_IMPROVEMENTS
        and improvements_after_seed(r.best_pnl_bps)[1] >= STAGNANT_MIN_TRAILING_FLAT
    )
    return Finding(
        name="champion_stagnation",
        summary=(
            f"{stagnant} of {len(evidence)} map-elites run(s) (>= 6 generations) are stagnant: "
            f"<= {STAGNANT_MAX_IMPROVEMENTS} post-seed improvements and a trailing flat tail "
            f">= {STAGNANT_MIN_TRAILING_FLAT} generations."
        ),
        evidence=tuple(evidence),
    )


def win_rate_finding(runs: Sequence[RunSummary]) -> Finding:
    """The 08-24 verdict's primary read: is any final champion's win rate above lottery shape?"""
    evidence: list[Evidence] = []
    for r in runs:
        rates = [(role, wr, n) for role, wr, n in r.final_win_rates if n >= MIN_TRADES_FOR_WIN_RATE]
        if not rates:
            continue
        top_role, top_wr, top_n = max(rates, key=lambda x: x[1])
        evidence.append(
            Evidence(
                r.file,
                f"final-gen champion win rates (>= {MIN_TRADES_FOR_WIN_RATE} trades): "
                f"max {top_wr:.2f} ({top_role}, {top_n} trades); "
                f"all: {', '.join(f'{role}={wr:.2f}' for role, wr, _ in rates)}",
            )
        )
    n_lottery = 0
    for r in runs:
        qualified = [wr for _, wr, n in r.final_win_rates if n >= MIN_TRADES_FOR_WIN_RATE]
        if qualified and max(qualified) < LOTTERY_WIN_RATE:
            n_lottery += 1
    return Finding(
        name="win_rate_shape",
        summary=(
            f"{n_lottery} of {len(evidence)} run(s) show every qualified champion win rate below "
            f"{LOTTERY_WIN_RATE} — the lottery-shaped profile behind the chart-only NO-GO. "
            "No knob fixes this; it gates which runs deserve knob tuning at all."
        ),
        evidence=tuple(evidence),
    )


def admission_finding(runs: Sequence[RunSummary]) -> Finding:
    """Whether the admission-gate tallies (ruined / curve_rejected) actually reached the telemetry."""
    missing = [r for r in runs if not r.has_admission_tallies]
    present = [r for r in runs if r.has_admission_tallies]
    evidence = [
        Evidence(r.file, f"admission tallies {'present' if r.has_admission_tallies else 'ABSENT'}")
        for r in runs
    ]
    return Finding(
        name="admission_tally_presence",
        summary=(
            f"{len(present)} of {len(runs)} run(s) carry ruined/curve_rejected tallies; "
            f"{len(missing)} do not (pre-gate builds or a writer path that drops them). "
            "Gate hit-rates cannot be audited from telemetry until a gated run reports them; "
            "instrumentation is a mechanism concern, so no knob suggestion is emitted for it."
        ),
        evidence=tuple(evidence),
    )


def compute_findings(runs: Sequence[RunSummary]) -> list[Finding]:
    """All cross-run findings, in report order."""
    if not runs:
        return []
    return [
        coverage_finding(runs),
        stagnation_finding(runs),
        win_rate_finding(runs),
        admission_finding(runs),
    ]


# ---------------------------------------------------------------------------
# Suggestions — bounded knob moves, each built from a finding's evidence
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Suggestion:
    """One bounded, evidence-cited knob move awaiting the operator's gate."""

    id: str
    created_at: str
    knob: str
    flag: str
    trainer: str
    current: float
    proposed: float
    band: tuple[float, float]
    evidence: tuple[Evidence, ...]
    rationale: str
    status: str = STATUS_PENDING

    def to_record(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "created_at": self.created_at,
            "knob": self.knob,
            "flag": self.flag,
            "trainer": self.trainer,
            "current": self.current,
            "proposed": self.proposed,
            "band": list(self.band),
            "evidence": [{"file": e.file, "detail": e.detail} for e in self.evidence],
            "rationale": self.rationale,
            "status": self.status,
            "decided_at": None,
            "reason": None,
        }


def suggestion_id(knob: str, proposed: float, files: Iterable[str]) -> str:
    """Deterministic id from (knob, proposed, evidence files) so re-emitting is idempotent."""
    digest = hashlib.sha256(f"{knob}|{proposed!r}|{'|'.join(sorted(files))}".encode()).hexdigest()
    return f"pm-{digest[:10]}"


def make_suggestion(
    *,
    knob: str,
    proposed: float,
    evidence: Sequence[Evidence],
    rationale: str,
    created_at: str,
    current: float | None = None,
) -> Suggestion:
    """Build a suggestion, enforcing the band. Raises :class:`OutOfBandError` outside it."""
    band = KNOB_BANDS.get(knob)
    if band is None:
        raise OutOfBandError(f"unknown knob {knob!r} — suggestions may only move declared knobs")
    if not band.contains(proposed):
        raise OutOfBandError(
            f"{knob}: proposed {proposed!r} outside declared band [{band.lo}, {band.hi}]"
            + (" (integer knob)" if band.integer else "")
        )
    if not evidence:
        raise ValueError(f"{knob}: a suggestion must cite evidence")
    return Suggestion(
        id=suggestion_id(knob, proposed, (e.file for e in evidence)),
        created_at=created_at,
        knob=knob,
        flag=band.flag,
        trainer=band.trainer,
        current=band.default if current is None else current,
        proposed=proposed,
        band=(band.lo, band.hi),
        evidence=tuple(evidence),
        rationale=rationale,
        status=STATUS_PENDING,
    )


def build_suggestions(runs: Sequence[RunSummary], *, created_at: str) -> list[Suggestion]:
    """The suggestion rules. Deliberately few: quality over quantity, zero is a legitimate output.

    Rule 1 — PBT coverage collapse -> lower ``pbt.exploit_frac``. The exploit step copies winners
    over losers, homogenizing behavioral descriptors; when a PBT run's coverage fell by
    >= COVERAGE_COLLAPSE_DROP while the archive algos held theirs, slower copy pressure is the
    smallest in-band response.

    Rule 2 — widespread map-elites champion stagnation -> raise ``map_elites.mutation_sigma``.
    When at least half the mature archive runs plateau (rarely displace any incumbent after the
    seed), the diversity injection is too small to produce competitive children.
    """
    suggestions: list[Suggestion] = []

    collapsed_pbt = [
        r
        for r in runs
        if r.algo == "pbt" and r.coverage[-1] <= r.coverage[0] - COVERAGE_COLLAPSE_DROP
    ]
    if collapsed_pbt:
        evidence = [
            Evidence(
                r.file,
                f"coverage {' -> '.join(f'{c:.3f}' for c in r.coverage)} over {r.n_generations} "
                f"generations while mean_pnl_bps rose {r.mean_pnl_bps[0]:+.1f} -> {r.mean_pnl_bps[-1]:+.1f} "
                "(homogenization, not failure to train)",
            )
            for r in collapsed_pbt
        ]
        held = [r for r in runs if r.algo == "map_elites" and r.coverage[-1] >= r.coverage[0]]
        if held:
            evidence.append(
                Evidence(
                    ", ".join(r.file for r in held),
                    f"contrast: {len(held)} map-elites run(s) held or grew coverage "
                    f"(final {', '.join(f'{r.coverage[-1]:.2f}' for r in held)}) — the collapse is "
                    "specific to PBT's exploit step, not the data",
                )
            )
        suggestions.append(
            make_suggestion(
                knob="pbt.exploit_frac",
                proposed=0.15,
                evidence=evidence,
                rationale=(
                    "PBT's exploit step reseeds the bottom quartile from the top quartile each "
                    "generation; the observed monotone coverage decay is descriptor homogenization "
                    "from that copying. Lowering exploit_frac 0.25 -> 0.15 keeps selection pressure "
                    "but roughly halves the per-generation copy volume, the smallest in-band move "
                    "that addresses the mechanism actually observed."
                ),
                created_at=created_at,
            )
        )

    mature = [r for r in runs if r.algo == "map_elites" and r.n_generations >= 6]
    stagnant = [
        r
        for r in mature
        if improvements_after_seed(r.best_pnl_bps)[0] <= STAGNANT_MAX_IMPROVEMENTS
        and improvements_after_seed(r.best_pnl_bps)[1] >= STAGNANT_MIN_TRAILING_FLAT
    ]
    if len(mature) >= 3 and len(stagnant) * 2 >= len(mature):
        evidence = [
            Evidence(
                r.file,
                f"best_pnl_bps {r.best_pnl_bps[0]:+.1f} -> {r.best_pnl_bps[-1]:+.1f}; "
                f"{improvements_after_seed(r.best_pnl_bps)[0]} improvement(s) in "
                f"{r.n_generations - 1} post-seed generations, trailing flat tail "
                f"{improvements_after_seed(r.best_pnl_bps)[1]}",
            )
            for r in stagnant
        ]
        suggestions.append(
            make_suggestion(
                knob="map_elites.mutation_sigma",
                proposed=0.08,
                evidence=evidence,
                rationale=(
                    f"{len(stagnant)} of {len(mature)} mature map-elites runs plateau: children "
                    "mutated at sigma=0.05 almost never displace an incumbent elite after the seed "
                    "generation, so the archive stops illuminating while compute keeps burning. A "
                    "modestly larger perturbation (0.08, inside the [0.01, 0.15] band) raises "
                    "displacement odds; validate via the trial harness before adopting — and note "
                    "the chart-only line is closed, so this applies to the next population pass "
                    "(e.g. the attention-features arm), not to more chart-only scaling."
                ),
                created_at=created_at,
            )
        )

    return suggestions


# ---------------------------------------------------------------------------
# Queue IO — append-only emissions; decisions update status in place, atomically
# ---------------------------------------------------------------------------


def load_queue(path: Path) -> list[dict[str, Any]]:
    """Read the queue (one JSON object per line). A missing file is an empty queue."""
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            loaded = json.loads(line)
            if isinstance(loaded, dict):
                records.append(loaded)
    return records


def append_suggestions(path: Path, suggestions: Sequence[Suggestion]) -> list[Suggestion]:
    """Append suggestions whose ids are not already queued; returns the ones actually appended."""
    existing = {str(rec.get("id")) for rec in load_queue(path)}
    fresh = [s for s in suggestions if s.id not in existing]
    if fresh:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            for s in fresh:
                fh.write(json.dumps(s.to_record(), sort_keys=True) + "\n")
    return fresh


def decide(
    path: Path, suggestion_ref: str, *, status: str, reason: str | None, decided_at: str
) -> dict[str, Any]:
    """Record the operator's decision on one pending suggestion (atomic rewrite of the queue).

    Recording is ALL this does — an accepted knob is applied by hand in the next run's flags.
    """
    if status not in (STATUS_ACCEPTED, STATUS_REJECTED):
        raise ValueError(f"status must be accepted/rejected, got {status!r}")
    records = load_queue(path)
    decided: dict[str, Any] | None = None
    for rec in records:
        if str(rec.get("id")) == suggestion_ref:
            if rec.get("status") != STATUS_PENDING:
                raise ValueError(f"{suggestion_ref} already decided ({rec.get('status')})")
            rec["status"] = status
            rec["decided_at"] = decided_at
            rec["reason"] = reason
            decided = rec
            break
    if decided is None:
        raise KeyError(f"no pending suggestion with id {suggestion_ref!r}")
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        "".join(json.dumps(rec, sort_keys=True) + "\n" for rec in records), encoding="utf-8"
    )
    os.replace(tmp, path)
    return decided


# ---------------------------------------------------------------------------
# Report + CLI
# ---------------------------------------------------------------------------


def format_report(
    runs: Sequence[RunSummary], findings: Sequence[Finding], emitted: Sequence[Suggestion]
) -> str:
    """Render the post-mortem: runs read, findings with evidence, then the emitted suggestions."""
    width = 96
    lines = [
        "=" * width,
        "OCT trading-agent — POST-MORTEM (read-only; suggestions queue for the operator's gate)",
        "=" * width,
        f"runs read: {len(runs)}",
    ]
    for r in runs:
        lines.append(
            f"  {r.file:<40} algo={r.algo:<10} gens={r.n_generations:<3} "
            f"coverage {r.coverage[0]:.2f}->{r.coverage[-1]:.2f} "
            f"best {r.best_pnl_bps[-1]:+8.1f} bps"
        )
    for finding in findings:
        lines.append("-" * width)
        lines.append(f"[{finding.name}] {finding.summary}")
        for e in finding.evidence:
            lines.append(f"    {e.file}: {e.detail}")
    lines.append("=" * width)
    if emitted:
        lines.append(f"emitted {len(emitted)} suggestion(s):")
        for s in emitted:
            lines.append(
                f"  {s.id}  {s.knob}: {s.current} -> {s.proposed}  (band [{s.band[0]}, {s.band[1]}], "
                f"flag {s.flag})"
            )
            lines.append(f"      rationale: {s.rationale}")
    else:
        lines.append("emitted 0 suggestions (nothing newly well-evidenced — a legitimate outcome).")
    lines.append("=" * width)
    return "\n".join(lines)


def format_queue(records: Sequence[dict[str, Any]]) -> str:
    """Render the queue for ``--list``."""
    if not records:
        return "queue is empty."
    lines = []
    for rec in records:
        lines.append(
            f"{rec.get('id')}  [{rec.get('status')}]  {rec.get('knob')}: "
            f"{rec.get('current')} -> {rec.get('proposed')}  (flag {rec.get('flag')}, "
            f"created {rec.get('created_at')})"
        )
        lines.append(f"    rationale: {rec.get('rationale')}")
        for e in rec.get("evidence", []):
            lines.append(f"    evidence [{e.get('file')}]: {e.get('detail')}")
        if rec.get("status") != STATUS_PENDING:
            lines.append(f"    decided {rec.get('decided_at')}  reason: {rec.get('reason')}")
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:  # pragma: no cover - CLI wiring
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--telemetry", type=str, default="data/desk_telemetry", help="telemetry dir (read-only)")
    parser.add_argument("--queue", type=str, default="data/postmortem/queue.jsonl")
    parser.add_argument("--emit", action="store_true", help="analyze runs and queue new suggestions")
    parser.add_argument("--list", action="store_true", help="print the queue")
    parser.add_argument("--accept", type=str, default=None, metavar="ID")
    parser.add_argument("--reject", type=str, default=None, metavar="ID")
    parser.add_argument("--reason", type=str, default=None, help="required with --reject")
    parser.add_argument("--now", type=str, default=None, help="override the recorded timestamp (ISO 8601)")
    args = parser.parse_args(argv)

    queue_path = Path(args.queue)
    now = args.now or datetime.now(UTC).isoformat(timespec="seconds")

    if args.accept and args.reject:
        parser.error("--accept and --reject are mutually exclusive")
    if args.accept:
        rec = decide(queue_path, args.accept, status=STATUS_ACCEPTED, reason=args.reason, decided_at=now)
        print(f"accepted {rec['id']} ({rec['knob']}: {rec['current']} -> {rec['proposed']})")
        print("recorded only — apply the knob by hand in the next run's flags.")
        return 0
    if args.reject:
        if not args.reason:
            parser.error("--reject requires --reason")
        rec = decide(queue_path, args.reject, status=STATUS_REJECTED, reason=args.reason, decided_at=now)
        print(f"rejected {rec['id']} ({rec['knob']}): {args.reason}")
        return 0
    if args.list:
        print(format_queue(load_queue(queue_path)))
        return 0
    if args.emit:
        runs = load_runs(Path(args.telemetry))
        findings = compute_findings(runs)
        suggestions = build_suggestions(runs, created_at=now)
        emitted = append_suggestions(queue_path, suggestions)
        print(format_report(runs, findings, emitted))
        skipped = len(suggestions) - len(emitted)
        if skipped:
            print(f"({skipped} suggestion(s) already queued — skipped.)")
        return 0
    parser.error("choose one of --emit / --list / --accept / --reject")
    return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())


__all__ = [
    "STATUS_PENDING",
    "STATUS_ACCEPTED",
    "STATUS_REJECTED",
    "OutOfBandError",
    "KnobBand",
    "KNOB_BANDS",
    "RunSummary",
    "load_run",
    "load_runs",
    "Evidence",
    "Finding",
    "improvements_after_seed",
    "compute_findings",
    "Suggestion",
    "suggestion_id",
    "make_suggestion",
    "build_suggestions",
    "load_queue",
    "append_suggestions",
    "decide",
    "format_report",
    "format_queue",
    "main",
]
