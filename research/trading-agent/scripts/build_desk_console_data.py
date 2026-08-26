"""Regenerate the Desk Console's embedded data block from the program's real artifacts.

``scripts/desk-console.html`` is deliberately ONE self-contained file — no fetch, no build step,
no server — so every number it shows has to be inlined. Inlining by hand is how a dashboard goes
stale and starts lying, so the inlining is done here instead: this script reads ``data/`` and
rewrites the region of the HTML between the ``@generated:begin desk-console-data`` and
``@generated:end`` markers. Re-run it after any run finishes and the console is current again.

Five literals are emitted, in this order:

``RUNS``          the four archive-telemetry exports the floor animates, verbatim from
                  ``data/desk_telemetry/*.json`` (contract: ``desk-telemetry-schema.md``).
``SCALE_SWEEP``   the map-elites escalation sweep, derived from those same files — final-generation
                  best PnL and champion win-rate spread per run. The console builds its "best-PnL
                  bounces, win rates stay flat" caption out of this rather than out of a hardcoded
                  string, so the caption cannot drift from the files.
``LADDER``        the vs-tracked-traders PPO ladder: which rungs are done and which is mid-run,
                  read out of ``data/checkpoints_vs_traders/ladder.ckpt.pt`` itself, plus the
                  rung reports (see PROVENANCE below).
``IMPROVEMENT``   the post-mortem suggestion queue and the trial-runner verdicts, straight from
                  ``data/postmortem/{queue,trials}.jsonl``.
``PROGRAM``       the standing substrate: wallet-census totals, replay-trace actor counts, audit
                  round 1 — the "what is actually on disk behind this page" strip.

PROVENANCE — the one thing that is NOT machine-read. ``format_rung`` in
``agent/train_market.py`` prints each rung's metric battery to stdout and persists nothing but the
policy weights, so a completed rung's numbers exist only in the run's console output and in the
PROGRESS.md entry that recorded them. Those numbers are therefore declared below as
:data:`RUNG_REPORTS`, tagged ``source: "PROGRESS.md"``, and — so a transcription cannot rot
silently — every figure is re-checked against PROGRESS.md at build time by
:func:`verify_transcription`, which raises if a quoted fragment is no longer in the file. The
console labels these panels as transcribed; everything else it shows is read from disk here.

Run with the repo venv:  .venv\\Scripts\\python.exe scripts\\build_desk_console_data.py
"""

from __future__ import annotations

import json
import sys
from collections.abc import Iterator
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
HTML = ROOT / "scripts" / "desk-console.html"
PROGRESS = ROOT / "PROGRESS.md"

BEGIN = "/* @generated:begin desk-console-data"
END = "/* @generated:end desk-console-data */"


# ---------------------------------------------------------------------------
# Archive telemetry — the four runs the floor animates
# ---------------------------------------------------------------------------

# Console run key -> telemetry export. The four are a progression, not a "best of": fitness-only
# PBT collapsing, quality-diversity holding its niches, the lucky 131-token run, and the largest
# run we have. The segmented control walks them left to right in this order.
FLOOR_RUNS: dict[str, str] = {
    "pbt": "pbt-2026-08-23-seed0.json",
    "mapelites": "mapelites-2026-08-23-seed0.json",
    "mapelites_scaled": "mapelites-gpu-large-seed0.json",
    "mapelites_scale": "mapelites-gpu-800-seed0.json",
}

# The escalation sweep, oldest first. `mapelites-gpu-seed0.json` is deliberately NOT here and the
# exclusion is stated rather than silent: it is the first GPU smoke run on a tiny token slice and
# reports +22,829 bps, three orders of magnitude off every later run — a scale artefact, not a
# result, and averaging it into the sweep would flatter the story it is used to tell.
SWEEP_FILES: tuple[str, ...] = (
    "mapelites-gpu-large-seed0.json",
    "mapelites-gpu-huge-seed0.json",
    "mapelites-gpu-mega-seed0.json",
    "mapelites-gpu-400-seed0.json",
    "mapelites-gpu-800-seed0.json",
)


# The PBT export predates the role rename and still carries the old functional vocabulary. Per
# `desk-telemetry-schema.md` the names are pure niche LABELS — behaviour is defined by the
# descriptor cell (trade_frequency x mean_hold_secs) a name maps to — and both vocabularies list
# their six roles in the same cell order, so this is a positional relabel and nothing else: no
# number moves, no desk changes cell. Doing it here rather than by hand in the HTML keeps the
# console on one vocabulary without an un-regenerable edit sitting in the data.
LEGACY_ROLE_RENAME: dict[str, str] = {
    "SNIPER": "GOBLIN",
    "SCAN": "GREMLIN",
    "WHALE": "GIZMO",
    "RUG": "NOODLE",
    "SHILL": "PICKLE",
    "EXIT": "GECKO",
}


def load_telemetry(name: str) -> dict[str, Any]:
    """Load one desk-telemetry export, relabelling a pre-rename role vocabulary if it has one."""
    payload: dict[str, Any] = json.loads((DATA / "desk_telemetry" / name).read_text(encoding="utf-8"))
    if not set(payload["roles"]) & LEGACY_ROLE_RENAME.keys():
        return payload
    payload["roles"] = [LEGACY_ROLE_RENAME.get(r, r) for r in payload["roles"]]
    for generation in payload["generations"]:
        for desk in generation["desks"]:
            desk["role"] = LEGACY_ROLE_RENAME.get(desk["role"], desk["role"])
    return payload


def build_runs() -> dict[str, dict[str, Any]]:
    return {key: load_telemetry(name) for key, name in FLOOR_RUNS.items()}


def build_scale_sweep() -> list[dict[str, Any]]:
    """Final-generation headline per escalation run: best PnL and the champion win-rate spread.

    Win-rate SPREAD, not mean, because the sweep's finding is a shape: the best-PnL column bounces
    with scale while every run's champions keep winning a small minority of their trades. A mean
    would hide exactly the invariant the panel exists to show.
    """
    sweep: list[dict[str, Any]] = []
    for name in SWEEP_FILES:
        telemetry = load_telemetry(name)
        last = telemetry["generations"][-1]
        wins = [d["champion"]["win_rate"] for d in last["desks"] if d["champion"] is not None]
        sweep.append(
            {
                "file": name,
                "run_id": telemetry["run_id"],
                "generations": len(telemetry["generations"]),
                "coverage": last["coverage"],
                "best_pnl_bps": last["best_pnl_bps"],
                "mean_pnl_bps": last["mean_pnl_bps"],
                "win_rate_min": min(wins) if wins else None,
                "win_rate_max": max(wins) if wins else None,
            }
        )
    return sweep


# ---------------------------------------------------------------------------
# The ladder — structure read from the checkpoint, reports transcribed
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Baseline:
    """One rung's result against one baseline.

    ``beaten`` is deliberately tri-state. ``None`` means the comparison did not happen — which is a
    different claim from "lost", and the rung-100 ``tracked_traders`` line is exactly that case: a
    rate-limited cohort left a baseline with no overlap on the held-out tokens, so its "0% beaten"
    was undefined, not zero. Rendering that as a loss would be the single most misleading thing
    this page could do, so the shape refuses to.
    """

    name: str
    beaten: bool | None
    mean_edge: float | None
    fraction_beaten: float | None
    note: str | None = None


@dataclass(frozen=True)
class RungReport:
    """One completed rung's printed metric battery, transcribed with its citation.

    ``quotes`` are verbatim fragments of the PROGRESS.md entry that recorded this rung. They are
    the transcription's checksum: :func:`verify_transcription` fails the build if any of them stops
    appearing in the file, so editing the log without editing this table cannot pass unnoticed.
    """

    rung: int
    verdict: str
    mean_return: float
    sharpe: float
    trades: int
    baselines: tuple[Baseline, ...]
    notes: tuple[str, ...]
    source: str
    quotes: tuple[str, ...]


# NOTE the minus signs in `quotes`: PROGRESS.md sets negatives with U+2212 MINUS SIGN, so the
# fragments must too or the check would fail on a purely typographic difference.
RUNG_REPORTS: tuple[RungReport, ...] = (
    RungReport(
        rung=100,
        verdict="NO-GO",
        mean_return=-0.0001,
        sharpe=-2.01,
        trades=283,
        baselines=(
            Baseline("buy_and_hold", beaten=True, mean_edge=0.0121, fraction_beaten=0.767),
            Baseline("hold_sol", beaten=False, mean_edge=None, fraction_beaten=None),
            Baseline(
                "tracked_traders",
                beaten=None,
                mean_edge=None,
                fraction_beaten=None,
                note="absent, not 0% — the cohort pull was rate-limited to ~8 of 40 wallets and "
                "those survivors had traded none of the held-out tokens, leaving the baseline "
                "degenerate: undefined rather than zero",
            ),
        ),
        notes=(
            "Beating buy_and_hold but not hold_sol means beating the worse of two do-nothing "
            "baselines — which is not an edge.",
            "The two do-nothing baselines diverge sharply on this data, so every headline has to "
            "name which one it is against.",
        ),
        source="PROGRESS.md § 2026-08-26 (b) — “Ladder status — honest”",
        quotes=(
            "**Rung 10: complete. Rung 100: complete, verdict NO-GO.**",
            "mean_ret **−0.0001**",
            "Sharpe **−2.01**, 283 trades",
            "beat `buy_and_hold` by +0.0121 on 76.7% of tokens",
            "could not beat **`hold_sol`**",
            "**Rung 1000 has produced no verdict.**",
        ),
    ),
)

# Rungs that finished but whose printed report was not captured anywhere we can cite. Shown as
# complete-without-numbers rather than back-filled from a neighbouring rung.
UNREPORTED_RUNGS: dict[int, str] = {
    10: "completed before the report battery was being logged — checkpoint on disk, numbers not captured",
}


def verify_transcription() -> None:
    """Fail the build if any transcribed fragment no longer appears in PROGRESS.md."""
    log = PROGRESS.read_text(encoding="utf-8")
    missing = [q for report in RUNG_REPORTS for q in report.quotes if q not in log]
    if missing:
        raise SystemExit(
            "PROGRESS.md no longer contains these transcribed fragments — the ladder table in "
            f"{Path(__file__).name} is stale and must be re-read from the log:\n  "
            + "\n  ".join(missing)
        )


def load_ladder_checkpoint() -> dict[str, Any]:
    """Read rung completion straight out of the live ladder checkpoint.

    The checkpoint was pickled by ``python -m oct_trading_agent.agent.train_market``, so its
    dataclasses are recorded under ``__main__`` rather than under their defining module. Binding
    them onto this process's ``__main__`` is what lets the unpickler resolve them here; without it
    torch raises ``AttributeError: Can't get attribute 'LadderCheckpoint'``.
    """
    sys.path.insert(0, str(ROOT / "src"))
    import torch

    import __main__
    from oct_trading_agent.agent import train_market

    for symbol in ("LadderCheckpoint", "RungTrainState", "TrainedPolicy"):
        setattr(__main__, symbol, getattr(train_market, symbol))

    path = DATA / "checkpoints_vs_traders" / "ladder.ckpt.pt"
    ckpt = torch.load(path, map_location="cpu", weights_only=False)
    in_progress = ckpt.in_progress
    return {
        "checkpoint": path.relative_to(ROOT).as_posix(),
        "seed": int(ckpt.seed),
        "rungs": [int(r) for r in ckpt.rungs],
        "completed": [int(r) for r in ckpt.completed_rungs],
        "in_progress_rung": None if ckpt.in_progress_rung is None else int(ckpt.in_progress_rung),
        "in_progress_iter": None if in_progress is None else int(in_progress.iter_done),
    }


def build_ladder() -> dict[str, Any]:
    """Assemble the ladder panel: machine-read status, then the report (or an honest gap) per rung."""
    verify_transcription()
    state = load_ladder_checkpoint()
    reports = {r.rung: r for r in RUNG_REPORTS}

    rungs: list[dict[str, Any]] = []
    for rung in state["rungs"]:
        done = rung in state["completed"]
        running = rung == state["in_progress_rung"]
        entry: dict[str, Any] = {
            "rung": rung,
            "status": "complete" if done else ("running" if running else "queued"),
            "iter_done": state["in_progress_iter"] if running else None,
            "checkpoint": _rung_checkpoint(rung),
            "report": None,
            "pending_reason": None,
        }
        report = reports.get(rung)
        if report is not None:
            entry["report"] = {
                "verdict": report.verdict,
                "mean_return": report.mean_return,
                "sharpe": report.sharpe,
                "trades": report.trades,
                "baselines": [asdict(b) for b in report.baselines],
                "notes": list(report.notes),
                "source": report.source,
            }
        elif done:
            entry["pending_reason"] = UNREPORTED_RUNGS.get(rung, "report not captured")
        elif running:
            entry["pending_reason"] = "mid-run — no verdict exists yet; nothing here should be quoted"
        rungs.append(entry)

    return {
        "name": "vs tracked traders",
        "dataset": "market_dataset_large",
        "checkpoint": state["checkpoint"],
        "seed": state["seed"],
        "rungs": rungs,
        "prior_line": (
            "The earlier chart-only ladder (rungs 10 / 100 / 149) closed NO-GO at every rung: "
            "held-out edge vs hold-SOL shrank +0.60 → +0.074 → +0.0023 as tokens grew."
        ),
        "prior_source": "PROGRESS.md § 2026-08-24 (ii)",
    }


def _rung_checkpoint(rung: int) -> str | None:
    path = DATA / "checkpoints_vs_traders" / f"rung_{rung}.pt"
    return path.relative_to(ROOT).as_posix() if path.exists() else None


# ---------------------------------------------------------------------------
# The improvement loop — suggestion queue + trial verdicts
# ---------------------------------------------------------------------------


def read_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            yield json.loads(line)


def build_improvement() -> dict[str, Any]:
    """The closed loop's own record: what it proposed, and what the trial harness decided.

    Only the fields the panel renders are carried over — the full rationale/evidence prose stays in
    the queue file. `evidence` is reduced to a count plus the run files it cites, because the point
    on screen is "this suggestion is backed by N runs", not the paragraph.
    """
    queue = [
        {
            "id": item["id"],
            "trainer": item["trainer"],
            "knob": item["knob"],
            "flag": item["flag"],
            "current": item["current"],
            "proposed": item["proposed"],
            "band": item["band"],
            "status": item["status"],
            "created_at": item["created_at"],
            "decided_at": item.get("decided_at"),
            "evidence_count": len(item.get("evidence", [])),
            "rationale": item["rationale"],
        }
        for item in read_jsonl(DATA / "postmortem" / "queue.jsonl")
    ]
    trials = [
        {
            "name": item["spec"]["name"],
            "trainer": item["spec"]["trainer"],
            "knob_flag": item["spec"]["knob_flag"],
            "incumbent": item["spec"]["incumbent"],
            "challenger": item["spec"]["challenger"],
            "verdict": item["verdict"],
            "created_at": item["created_at"],
            "criterion_text": item["criterion_text"],
            "clauses": item["clauses"],
            "metrics": item["metrics"],
        }
        for item in read_jsonl(DATA / "postmortem" / "trials.jsonl")
    ]
    return {"queue": queue, "trials": trials}


# ---------------------------------------------------------------------------
# Program substrate — census, replay traces, audit rounds
# ---------------------------------------------------------------------------


def build_program() -> dict[str, Any]:
    """The standing artifacts behind the page, so its claims have a visible denominator."""
    import polars as pl

    census = json.loads((DATA / "wallet_census" / "summary.json").read_text(encoding="utf-8"))

    actors_dir = DATA / "replay_traces" / "actors"
    groups: list[dict[str, Any]] = []
    for path in sorted(actors_dir.glob("*.parquet")):
        frame = pl.read_parquet(path, columns=["actor_kind", "group_id"])
        groups.append(
            {
                "file": path.name,
                "group_id": frame["group_id"][0],
                "kind": frame["actor_kind"][0],  # one kind per group file, by construction
                "actors": frame.height,
            }
        )
    mint_index = pl.read_parquet(DATA / "replay_traces" / "mint_index.parquet")

    audit = json.loads((DATA / "audit" / "round1_fifo_recheck.json").read_text(encoding="utf-8"))

    return {
        "census": {
            "source": census["source"],
            "wallets": census["n_wallets"],
            "pairs": census["n_pairs"],
            "tokens": census["n_tokens"],
            "tokens_ranked": census["n_tokens_ranked"],
            "winners": census["n_winners"],
            "losers": census["n_losers"],
            "suspects": census["n_suspects"],
            "one_token_wonders": census["n_one_token_wonders"],
        },
        "replay": {
            "actors": sum(g["actors"] for g in groups),
            "groups": groups,
            "mints_indexed": mint_index.height,
        },
        "audit": {
            "round": audit["round"],
            "subsystem": audit["subsystem"],
            "wallets": len(audit["wallets"]),
            "closed_pairs": audit["n_closed_pairs"],
            "pairs": audit["n_pairs"],
            "discrepancies": len(audit["discrepancies"]),
        },
    }


def build_champions() -> list[dict[str, Any]]:
    """Every niche champion from every telemetry export — the full agent roster.

    The animated floor only ever shows one run's six niches at the playback frame. This is the
    flat, sortable version: every agent the program has ever elected champion of a niche, with
    the run it came from.

    ``mapelites-gpu-seed0.json`` IS included here — unlike SCALE_SWEEP, which averages and would
    be flattered by it — but every one of its rows is tagged ``artefact: True`` and carries the
    reason. A roster that silently omits a run is a roster you cannot trust to be complete; one
    that shows it unlabelled at +22,829 bps is worse. Showing it with the caveat attached is the
    only option that is both complete and honest.
    """
    ARTEFACT = "mapelites-gpu-seed0.json"
    out: list[dict[str, Any]] = []
    for path in sorted((DATA / "desk_telemetry").glob("*.json")):
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        gens = doc.get("generations") or []
        if not gens:
            continue
        last = gens[-1]
        for desk in last.get("desks", []):
            champ = desk.get("champion")
            if not champ:
                continue
            out.append({
                "agent_id": champ.get("agent_id"),
                "role": desk.get("role"),
                "run": path.name.replace("-seed0.json", "").replace(".json", ""),
                "algo": doc.get("algo"),
                "gens": len(gens),
                "cost_bps": doc.get("cost_bps"),
                "pnl_bps": champ.get("pnl_bps"),
                "trades": champ.get("trades"),
                "win_rate": champ.get("win_rate"),
                "hold_s": champ.get("hold_s"),
                "median_pnl_bps": desk.get("median_pnl_bps"),
                "occupancy": desk.get("occupancy"),
                "artefact": path.name == ARTEFACT,
                "artefact_reason": (
                    "first GPU smoke run on a tiny token slice; ~3 orders of magnitude off every "
                    "later run — a scale artefact, not a result"
                ) if path.name == ARTEFACT else None,
            })
    # Best first, but artefact rows always sort last so they cannot head the table.
    out.sort(key=lambda r: (r["artefact"], -(r["pnl_bps"] if r["pnl_bps"] is not None else -1e9)))
    return out


# ---------------------------------------------------------------------------
# Emit
# ---------------------------------------------------------------------------


def js_const(name: str, value: object, *, indent: int | None = None) -> str:
    """One `const NAME = <json>;` line. JSON is a valid JS expression, so no escaping games."""
    return f"const {name} = {json.dumps(value, indent=indent, ensure_ascii=False)};"


def render_block(ladder: dict[str, Any]) -> str:
    lines = [
        BEGIN + " — DO NOT EDIT BY HAND.",
        "   Regenerate with:  .venv\\Scripts\\python.exe scripts\\build_desk_console_data.py",
        "   Every literal below is read out of data/ (or cited to PROGRESS.md) by that script. */",
        "",
        "/* Four archive-telemetry exports, verbatim (contract: desk-telemetry-schema.md). */",
        js_const("RUNS", build_runs()),
        "",
        "/* The map-elites escalation sweep, derived from those same exports. */",
        js_const("SCALE_SWEEP", build_scale_sweep(), indent=2),
        "",
        "/* The vs-tracked-traders PPO ladder. Rung completion is read from the live checkpoint;",
        "   a completed rung's metric battery is transcribed from PROGRESS.md (stdout-only output)",
        "   and carries its citation, which the build re-verifies against the log. */",
        js_const("LADDER", ladder, indent=2),
        "",
        "/* The improvement loop's own record: the post-mortem queue and the trial verdicts. */",
        js_const("IMPROVEMENT", build_improvement(), indent=2),
        "",
        "/* The standing substrate: wallet census, replay traces, audit rounds. */",
        js_const("PROGRAM", build_program(), indent=2),
        "",
        "/* Every niche champion from every run — the flat agent roster. Rows from the first GPU",
        "   smoke run are tagged `artefact` and sort last; see build_champions(). */",
        js_const("CHAMPIONS", build_champions(), indent=2),
        "",
        END,
    ]
    return "\n".join(lines)


def main() -> int:
    ladder = build_ladder()  # built once: it loads a torch checkpoint, and it is also the summary
    html = HTML.read_text(encoding="utf-8")
    start = html.index(BEGIN)
    end = html.index(END) + len(END)
    HTML.write_text(html[:start] + render_block(ladder) + html[end:], encoding="utf-8", newline="\n")

    status = " ".join(f"rung{r['rung']}={r['status']}" for r in ladder["rungs"])
    print(
        f"{HTML.name}: {len(FLOOR_RUNS)} floor runs, {len(SWEEP_FILES)} sweep runs, {status}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
