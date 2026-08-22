# Progress Log — OCT Trading-Agent R&D

A running, reverse-chronological log of findings, decisions, and progress on this
program. This is the "what changed and what we learned" ledger; the design lives in
[`00-paper.md`](./00-paper.md) and the docs it anchors. Newest entry on top.

**Entry format:** a dated `## <YYYY-MM-DD> — <headline>` heading, then some mix of
**Decisions** (what we committed to and why), **Findings** (what we learned — from data,
experiments, or reasoning), **Changes** (what moved in the docs/code), and **Open**
(what's now unresolved or newly surfaced). Distill, don't transcribe. A pre-Phase-0
program logs reasoning and scoping; once Phase 0 starts, entries carry real numbers
(sim-fidelity error, cost-adjusted edge, ablation deltas) with the eval discipline of
[`05-evaluation-plan.md`](./05-evaluation-plan.md).

---

## 2026-08-22 — Attention model folded in; signal-first locked; workspace synced to the paper

**Decisions**
- **Signal-first is now the program's committed deliverable** (paper §4.2, §9.8, §1.3; charter §6;
  README banner). The primary product is a *calibrated signal / API*, not a fund-holding autopilot.
  Live autonomous execution through `/sniper/v1` is an **optional, separately-gated extension that
  defaults off**. Rationale: widest product surface, least liability, and — decisively — a system
  that never custodies funds cannot be tilted into ruin, so the §9.8 catastrophic-risk profile
  becomes opt-in rather than default. This collapses the old three-way ship/publish/trade fork into
  a lighter business-packaging choice that no longer changes the safety architecture.
- **Paper review declared done** for now. It stays a living document — refined as data and findings
  arrive, via this log.

**Changes**
- **Trade-flow attention model promoted into the main paper as §4.4** (System Architecture), with
  the identification limit as §9.10 and the old feasibility-honesty section renumbered to §9.11.
  Dual backbone (multivariate Hawkes → interpretable λ_buy(t) "attention chart" with branching
  ratio *n* as an attention-momentum scalar; causal self-attention transformer as the cross-token
  learned encoder), a mandatory manipulation-suspicion channel, and three wire-in points (flow-tier
  encoder, independent convergence signal, standalone alert). Full standalone development retained
  as the companion [`subprojects/trade-flow-attention.md`](./subprojects/trade-flow-attention.md).
- Charter §6 and README banner rewritten from "decision pending" to "resolved: signal-first."
- Workspace re-synced to the live paper: `00-paper.md` refreshed, `subprojects/` added.

**Findings (reasoning, not yet data)**
- The attention model's core honest limit is structural: **self-excitation is not identifiable from
  a common exogenous driver using flow alone** (§9.10) — a rising base rate μ(t) and a high
  branching ratio *n* are near-substitutes in the Hawkes likelihood, and wash trading manufactures
  exactly the self-exciting tape the model reads as attention (Cong et al. estimate >70% of reported
  volume on unregulated venues is wash). Hence the mandatory authenticity channel; hence "attention
  intensity is measured, genuine-crowd interpretation is corroboration-dependent, never an identity."

**Open**
- Business-packaging choice (signal-as-feature vs published-research+API vs private) — now lower-stakes,
  can wait until ~Phase-2 gate.
- Everything downstream of Phase 0 still gated on the one empirical question (charter §2): does a
  durable, cost-surviving, out-of-sample edge in new pairs actually exist?
