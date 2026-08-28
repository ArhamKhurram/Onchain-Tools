# 01 — Project Charter

**Program:** OCT Autonomous Trading Agent (Model N — new-pair; Model R — revival policy extension)
**Status:** Proposal / pre-Phase-0
**Source of truth:** [`00-paper.md`](./00-paper.md) — this charter operationalizes it and must not contradict it.

---

## 1. Mission

Determine — rigorously, honestly, and safely — whether a durable, capacity-respecting predictive
edge exists in newly launched ("new-pair") memecoins, and if it does, capture it with an
autonomous reinforcement-learning agent that:

- learns primarily from real on-chain data and a database of labeled full-history traders (not from-scratch self-play);
- is trained against a **high-fidelity replay simulator** whose exploits transfer to the chain;
- is bred as a **diverse population of profitable archetypes**, not a single optimum;
- optimizes **risk-adjusted, benchmark-relative** rewards under **hard risk constraints**, never the literal 1→100 SOL goal;
- adapts **continually online** to a non-stationary meta;
- **ships its output as a signal/API by default** — a calibrated, explainable decision routed to the console and to consumers, *not* a fund-holding autopilot (paper §4.2); and
- can only ever *propose* trades to OCT's existing `/sniper/v1` actuator and safety envelope, and only in the opt-in, separately-gated live-execution mode.

The 1 SOL → 100 SOL run is an **evaluation north-star**, never a training reward (paper §3.5, §8.1).

---

## 2. The single go/no-go empirical question

Everything in this program is instrumental to answering **one** question (paper §11):

> **After realistic execution costs (slippage, price impact, MEV, fees, latency) and after honestly
> correcting for survivorship/selection bias in the labeled-trader benchmark, does a durable,
> capacity-respecting predictive edge in new-pair memecoins actually exist and persist
> out-of-sample across regime shifts?**

- If **yes**: the curriculum, the population, and the online loop are how we capture it safely.
- If **no**: the same rigorous gating is what stops us from burning real capital to find out the hard way.

This question is answered incrementally at the phase gates (see [`03-experiment-plan.md`](./03-experiment-plan.md)),
first and most decisively at **Phase 0 / Phase 1**, where a raw-chart agent must beat buy-and-hold and
hold-SOL baselines *after realistic costs* on held-out time periods. A "no" at that gate is a valid,
reportable, program-ending outcome — and a success of the process, not a failure.

---

## 3. Scope

### In scope

- A **replay simulator** with an explicit execution/impact/MEV/rug model, built from OCT's Pinax new-pair firehose.
- A **point-in-time feature store** with enforced leakage audits.
- Offline/imitation bootstrapping from the **labeled-trader DB** (full win-and-loss histories).
- **Model N** — the new-pair RL policy — across the five-tier progressive-information curriculum (raw chart → wallet flows → metadata → narrative/social → crowd chatter).
- **Population/evolutionary + quality-diversity** training (PBT, evolution strategies, MAP-Elites) producing a diverse ensemble of individually edge-positive archetypes.
- A **paper-trading ledger** and the strict **backtest → paper → live** promotion gate.
- Integration as **one independent signal** into OCT's convergence layer.
- **Model R** revival policy extension — reusing the same RL scaffolding — as a *later, optional* item (Phase 4).
- Live trading **only** through the existing `/sniper/v1` caps + kill switch, at minimal size, gated behind paper.

### Explicitly out of scope

- **From-scratch self-play RL as a data-generation strategy** — the paper shows it does not transfer (markets aren't self-playable). We borrow the *algorithms*, not the paradigm.
- **The literal 1→100 SOL goal as a training reward** — it trains ruin-seeking lottery behavior (paper §3.5).
- **Shorting / short infrastructure** — new-pairs are effectively long-only in the alpha (paper §3.3).
- **Re-architecting the sniper.** The `/sniper/v1` control plane is reused as-is as the actuator and safety envelope; it is not modified, "tidied," or bypassed.
- **Fusing Model N's detections with any other OCT signal.** Fusion happens only at the score/convergence layer (OCT's "signals stay independent" principle).
- **Any live money before the paper gate is cleared**, and any bypass of caps or the kill switch — no exceptions.
- **A multi-agent market simulator that reproduces real order flow** — acknowledged as an unsolved research problem; we proceed with conservative counterfactual-impact assumptions and treat the paper→live gap as ground truth.
- **LP automation** — retired repo-wide (per `CLAUDE.md`); unrelated and not revived here.

---

## 4. Success criteria

Success is defined **primarily by the honesty and rigor of the answer**, not by hitting 100 SOL.

**Process success (required regardless of path):**
1. A Phase-0 simulator that reproduces known historical fills within a calibrated slippage tolerance, with a passing leakage audit.
2. Walk-forward, pre-registered evaluation with no post-hoc goalpost moves.
3. A defensible, documented yes/no on the go/no-go question at each gate, caveats attached.

**Outcome success (if edge exists):**
4. A raw-chart agent beating hold-SOL and buy-and-hold **after realistic costs** on held-out periods (Phase 1 gate). — **ANSWERED NO (2026-08-28), and the gate is closed.** Three rungs, two independent methods. The closing run beat buy-and-hold on 82.7% of held-out tokens and `hold_sol` on 1.0%; it learned risk avoidance (lowest max drawdown in the table) rather than edge, and paid the largest fee bill to land below doing nothing. Criterion 3 — an honest documented no — is what this satisfies.
5. Per-tier ablations showing statistically credible marginal edge for at least the first information tiers, or an honest report that a tier does not help (Phase 2 gate). — **IN PROGRESS.** Tier B has its first positive result: earliness orders outcome monotonically in sample and survives a split-sample test on unseen tokens. It is a wallet *label*, not an observation — the peak is hindsight — so the marginal-edge ablation this criterion asks for still has to be run against a point-in-time feature derived from it.
6. An out-of-sample-validated, diverse population of **individually edge-positive** archetypes.
7. Positive per-token edge vs the labeled-trader cohort on **forward** data, discounted for the residual selection effect (paper §9.3).
8. A sustained paper run reproducing backtest within tolerance, and — only then — a minimal-size live pilot inside the sniper caps.

**North-star (report card, not teacher):** the distribution of 1→100 SOL paper runs across seeds/periods,
judged jointly with the risk metrics — a 100× reached only via near-ruin drawdowns is a **failure**, not a success.

---

## 5. Constraints

- **Safety is structural, not behavioral** (paper §9.8). Risk enters as hard CMDP constraints and CVaR/distributional objectives; live action passes through the sniper's per-fire/per-trigger/daily caps, max-open-positions, and kill switch, which the agent cannot modify. Human approval is required for any cap scale-up, plus a hard absolute loss limit that halts regardless of confidence.
- **Time ordering is sacred** — walk-forward evaluation only, never random splits.
- **Point-in-time causality** — all features reconstructed as-of decision time; leakage audit is a standing test.
- **Non-stationarity is the design premise**, not a caveat — recent-window replay + continual adaptation from the start.
- **Simulator fidelity is the whole ballgame** — exploits are the goal; only *artifact* exploits are worthless. The paper→live gap is the primary fidelity meter.
- **Compute/engineering reality:** Phase 0 is engineering-heavy, not compute-heavy; cost climbs with text encoders, retrieval, and the population in Phase 2+.
- **Prompt-injection surface** (Phase D+): all external text is data, never instructions; it can never alter caps, safety settings, or control flow.
- **Repo conventions:** isolated on `research/trading-agent`; no direct pushes to `main`; vetted pieces graduate individually via PR; no `CHANGELOG.md` date heading for this workspace.

---

## 6. The deliverable decision (resolved: signal-first)

**Resolved (2026-08-22): the program's primary deliverable is a *signal*, not a live trader** (paper §4.2).
Model N and the trade-flow attention model emit a calibrated, explainable decision into OCT's
convergence layer and, for consumers, as an API. Live autonomous execution — the agent actually
spending through `/sniper/v1` — is an **optional, separately-gated extension that OCT may never
enable**; it is strictly downstream of the signal and defaults *off*. This is the single most
important safety property in the program, because a system that never custodies funds cannot be
tilted into ruin (§5, paper §9.8).

This resolves the *technical* end-state and collapses most of the old three-way risk fork: the
catastrophic-risk profile (paper §9.8) applies only to the opt-in live mode. What remains is a
lighter **business-packaging** choice — how the *signal* itself reaches the world — which no longer
changes the safety architecture and can be made later:

| Packaging | Implies |
|---|---|
| **Signal as an OCT feature** | The console surfaces the agent's calls as one more convergence signal / alert. Consumer-product care still applies (loss disclosures, no personalized-advice framing, the §9.9 ethics stance), but there is no fund-custody liability by default. |
| **Signal published as research + API** | The finding and the calibrated signal are the deliverable; rigor, reproducibility, and the honest open-question answer dominate. Any live trading stays a minimal internal validation pilot. |
| **Signal used privately for own trading** | The operator consumes the signal by hand or via their own tooling. Narrowest external surface; if they later flip on live-execution mode, the full §9.8 profile lands on their own funds and the structural caps become the only guardrail. |

**Assumption made in this document set (flagged):** documents are still written to satisfy the
**most demanding** packaging (feature-grade disclosures + ethics) so nothing has to be re-scoped
upward later; a narrower packaging can relax requirements deliberately, never the reverse. What is
*no longer* assumed is default live execution — that is now opt-in by construction. See
[`README.md`](./README.md) and the ethics item in [`06-risk-register.md`](./06-risk-register.md).
