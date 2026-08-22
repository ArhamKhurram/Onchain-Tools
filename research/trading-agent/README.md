# OCT Trading-Agent R&D Workspace

**Mission (one line):** Determine — rigorously and safely — whether a durable, capacity-respecting predictive edge in new-pair memecoins survives realistic execution costs and survivorship correction out-of-sample across regimes, and if so, capture it with an autonomous RL agent bred as a diverse population of profitable archetypes.

This directory is the isolated research and specification workspace for OCT's autonomous
reinforcement-learning trading agent (internally: **Model N**, the new-pair agent, alongside
the extended **Model R** revival policy). It is documentation and scaffolding only — no app
code lives here yet, and nothing here touches any build.

---

## ⚑ Decision pending — this shapes everything

The operator has **not** chosen what this program is *for*. Three mutually-exclusive end-states,
each of which changes scope, risk posture, and success criteria:

| Path | One-liner | What it implies |
|---|---|---|
| **Ship as a feature** | An autonomous-trading product inside OCT for users | Highest bar: consumer-financial-product duties, disclosures, no personalized-advice framing, hardest safety caps, the ethics stance in §9.9 of the paper becomes binding. |
| **Publish as research** | A paper + open findings; no live money at scale | Emphasis shifts to scientific rigor, reproducibility, and the honest yes/no on the open question. Live trading stays a minimal validation pilot, not a product. |
| **Trade own capital** | OCT/operator runs it privately on its own funds | Narrowest surface; no user-protection duties, but the full catastrophic-risk profile (§9.8) lands squarely on the operator's own balance. |

Until this is chosen, treat all three as live. Every charter, plan, and gate below is written to
serve whichever path is picked; where a document had to assume, it says so.

---

## Reading order

1. **[`00-paper.md`](./00-paper.md)** — the source-of-truth research paper. Read fully first; everything else operationalizes it. (Also intended for publication as a shareable artifact.)
2. **[`01-charter.md`](./01-charter.md)** — Project Charter: mission, scope, success criteria, the single go/no-go empirical question, constraints, and the ship/publish/trade decision framing.
3. **[`02-technical-design.md`](./02-technical-design.md)** — Technical Design Doc: architecture, components, interfaces, tech stack, OCT-infra integration, proposed module layout.
4. **[`03-experiment-plan.md`](./03-experiment-plan.md)** — Experiment Plan / research roadmap: Phases 0→4 with hypotheses, methods, datasets, metrics, go/no-go gates, and effort/compute.
5. **[`04-data-spec.md`](./04-data-spec.md)** — Data Specification: every dataset, schema, sources, the point-in-time feature store, leakage rules, and a have-vs-build table.
6. **[`05-evaluation-plan.md`](./05-evaluation-plan.md)** — Evaluation & Benchmarks: metrics, the backtest→paper→live promotion gate, ablation protocol, and statistical-rigor rules.
7. **[`06-risk-register.md`](./06-risk-register.md)** — Risk Register: the paper's §9 threats as a tracked table, the safety envelope, and the ethics stance.

---

## Current status

**Phase: pre-Phase-0 (documentation and scoping).** No code, no data pipeline, no simulator yet.
The first real work item is **Phase 0** — build the high-fidelity replay simulator and prove an
edge survives realistic costs (see [`03-experiment-plan.md`](./03-experiment-plan.md)). Nothing
proceeds to a learned policy until Phase 0's exit milestone is met.

| Artifact | State |
|---|---|
| Research paper | Drafted (v0.1), copied in as `00-paper.md` |
| Document set (this workspace) | Drafted |
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
