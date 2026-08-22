# OCT Trading-Agent R&D Workspace

**Mission (one line):** Determine — rigorously and safely — whether a durable, capacity-respecting predictive edge in new-pair memecoins survives realistic execution costs and survivorship correction out-of-sample across regimes, and if so, capture it with an autonomous RL agent bred as a diverse population of profitable archetypes.

This directory is the isolated research and specification workspace for OCT's autonomous
reinforcement-learning trading agent (internally: **Model N**, the new-pair agent, alongside
the extended **Model R** revival policy). It is documentation and scaffolding only — no app
code lives here yet, and nothing here touches any build.

---

## ✔ Decision — signal-first (resolved 2026-08-22)

**The primary deliverable is a *signal*, not a live trader** (paper §4.2; charter §6). The agent
emits a calibrated, explainable decision into OCT's convergence layer and as an API; live
autonomous execution through `/sniper/v1` is an **optional, separately-gated extension that
defaults off and may never be enabled.** A system that never custodies funds cannot be tilted into
ruin — so the largest danger in the whole program (§9.8) is opt-in, not default.

What remains is a lighter **business-packaging** choice — how the *signal* reaches the world — which
no longer changes the safety architecture and can be made later:

| Packaging | One-liner | What it implies |
|---|---|---|
| **Signal as an OCT feature** | The console surfaces the agent's calls as one more convergence signal | Consumer-product care (disclosures, no personalized-advice framing, §9.9 ethics) still applies — but no fund-custody liability by default. |
| **Signal published as research + API** | A paper + open findings + the calibrated signal | Rigor, reproducibility, and the honest yes/no on the open question dominate. Any live trading stays a minimal internal pilot. |
| **Signal used privately** | The operator consumes it by hand / own tooling | Narrowest surface; only if live-execution mode is later switched on does the full §9.8 profile land on the operator's own funds. |

Documents are still written to the **most demanding** packaging so nothing has to be re-scoped
upward later. What is *no longer* assumed is default live execution — that is now opt-in by construction.

---

## Reading order

1. **[`00-paper.md`](./00-paper.md)** — the source-of-truth research paper. Read fully first; everything else operationalizes it. (Also intended for publication as a shareable artifact.)
2. **[`01-charter.md`](./01-charter.md)** — Project Charter: mission, scope, success criteria, the single go/no-go empirical question, constraints, and the ship/publish/trade decision framing.
3. **[`02-technical-design.md`](./02-technical-design.md)** — Technical Design Doc: architecture, components, interfaces, tech stack, OCT-infra integration, proposed module layout.
4. **[`03-experiment-plan.md`](./03-experiment-plan.md)** — Experiment Plan / research roadmap: Phases 0→4 with hypotheses, methods, datasets, metrics, go/no-go gates, and effort/compute.
5. **[`04-data-spec.md`](./04-data-spec.md)** — Data Specification: every dataset, schema, sources, the point-in-time feature store, leakage rules, and a have-vs-build table.
6. **[`05-evaluation-plan.md`](./05-evaluation-plan.md)** — Evaluation & Benchmarks: metrics, the backtest→paper→live promotion gate, ablation protocol, and statistical-rigor rules.
7. **[`06-risk-register.md`](./06-risk-register.md)** — Risk Register: the paper's §9 threats as a tracked table, the safety envelope, and the ethics stance.

**Living documents (updated as work proceeds):**
- **[`PROGRESS.md`](./PROGRESS.md)** — running, reverse-chronological log of decisions, findings, and progress. Start here to see *what's changed*.
- **[`subprojects/trade-flow-attention.md`](./subprojects/trade-flow-attention.md)** — full standalone development of the trade-flow attention model (companion to paper §4.4 / §9.10).

---

## Current status

**Phase: pre-Phase-0 (documentation and scoping).** No code, no data pipeline, no simulator yet.
The first real work item is **Phase 0** — build the high-fidelity replay simulator and prove an
edge survives realistic costs (see [`03-experiment-plan.md`](./03-experiment-plan.md)). Nothing
proceeds to a learned policy until Phase 0's exit milestone is met.

| Artifact | State |
|---|---|
| Research paper | Drafted + reviewed; attention model integrated (§4.4/§9.10); signal-first locked. Synced as `00-paper.md` |
| Attention sub-project | Drafted as `subprojects/trade-flow-attention.md` |
| Document set (this workspace) | Drafted; charter + README updated for the signal-first decision |
| Progress log | Started (`PROGRESS.md`) |
| Simulator / data pipeline | Not started (Phase 0) |
| Any learned policy | Not started |
| Any live money | Not permitted until the full backtest→paper→live gate is cleared |

---

## How this branch works

- This lives on the **long-lived `research/trading-agent` branch**, isolated from production —
  in the same spirit as the `video` branch. It is a **standing R&D workspace, not a feature
  branch queued for merge.**
- It is **not** merged into `main` wholesale. Production cannot host this experiment (it can't
  be safely tested in prod), so vetted pieces graduate to `main` **individually** through the
  normal PR flow *only* once they meet their own gate — e.g. a data-pipeline connector or the
  eventual `/sniper/v1` integration, each landing as its own reviewed PR. The research scaffolding
  and training code stay here.
- Per repo convention, **no direct pushes to `main`**, and nothing here adds a `## <date>` heading
  to `CHANGELOG.md` (this workspace is not a user-facing release).
- The one production coupling that already exists by design: any eventual live action routes
  through OCT's existing **`/sniper/v1`** control plane as the actuator and safety envelope
  (caps + kill switch). The agent only ever *proposes*; it never spends directly. See
  [`02-technical-design.md`](./02-technical-design.md) and the sniper section of the root
  `CLAUDE.md`.

---

## Relationship to the rest of OCT

Model N is designed to become **one more independent signal** in OCT's existing
convergence/ensemble layer — fused at the score level, never at the detection level, consistent
with OCT's "signals stay independent" principle. It reuses OCT's Pinax new-pair firehose, the
labeled-wallet DB, the Discord/Telegram chatter ingestion, and the `/sniper/v1` actuator. It does
**not** replace or merge with the revival detector; the two are trained separately and share only
the RL scaffolding.
