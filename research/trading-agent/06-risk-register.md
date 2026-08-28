# 06 — Risk Register

**Program:** OCT Autonomous Trading Agent
**Status:** Proposal / pre-Phase-0
**Source of truth:** [`00-paper.md`](./00-paper.md) §9 (threats to validity). This doc renders those threats as a tracked table, then details the safety envelope and the ethics stance. Several risks are, in the paper's own assessment, **potentially fatal to the strong form of the vision** — this register does not soften that.

**Severity** = impact if it materializes. **Likelihood** = probability given the current design.
**Status** = `open` (identified, mitigation planned) · `mitigated-by-design` (the architecture already
addresses it, residual remains) · `monitored` (a standing metric watches it).

---

## 1. Risk table

| # | Risk | Category | Severity | Likelihood | Mitigation | Status |
|---|---|---|---|---|---|---|
| R1 | **Catastrophic risk of an autonomous, money-spending agent aimed at a 100× goal** — the EV-optimal way to hit a fixed multiple is bold, ruinous play; an online agent can drift into pathology between evals (paper §9.8) | Safety / existential-to-capital | **Critical** | Med (if unmitigated: High) | 1→100 never the training reward; risk as **hard CMDP constraints** + CVaR/distributional objectives; live gated behind paper; **all** live action through the sniper caps + kill switch the agent cannot modify; human approval for cap scale-up; hard absolute loss limit halts regardless of confidence | **mitigated-by-design** (residual: drift between evals) — see §2 |
| R2 | **Sim-to-real fidelity gap** — naive replay omits impact/slippage/MEV/liquidity, which *are* much of the game; an agent trained on fill-at-mid looks brilliant and is worthless (paper §6.1, §9.4) | Methodology | **Critical** | High (without work) | High-fidelity replay + explicit execution/impact/MEV/rug model; **paper→live gap as the fidelity meter**; conservative counterfactual-impact; the whole of Phase 0 | **open** (Phase 0 is exactly this) |
| R3 | **No durable edge exists** — after realistic costs and survivorship correction, new-pairs may have no capacity-respecting edge at all (the open question, paper §11) | Existential-to-program | **High** | Unknown (the point) | Rigorous gating answers it early (Phase 1); a defensible "no" is a *valid, program-ending* result | **partially answered (2026-08-28)** — the RAW-CHART tier has no durable edge: three rungs, two methods, `hold_sol` never beaten. That is the "valid, program-ending result" this row anticipated, scoped to tier A. The program continues only because the curriculum prices tiers separately, and tier B has since returned its first positive signal. |
| R14 | **Optimising for the appearance of correctness** — variance minimisation, drawdown floors and hit rate are all locally rewardable and all uncorrelated with edge here. Rung 1000 produced the pathology directly: the smallest max drawdown in the table (0.031) and the largest fee bill (2,549 trades) landing *below* the policy that trades nothing, while the highest hit rate (22.0%) belonged to `random`. The human analogue — overtrading and an inability to accept losses a correct strategy generates by design — is the same failure with a different substrate | Methodology / objective design | Med–High | **Observed** | Judge process, not outcome: pre-registered gates (§4), walk-forward only, and no single-metric promotion. A drawdown floor is never on its own evidence of quality — always read it against fees and turnover. Loss periods are expected output (see R5), so a policy that avoids them is suspect rather than reassuring | **observed 2026-08-28, mitigated-by-protocol** — see `05-evaluation-plan.md` §1.3a |
| R4 | **Reward hacking** — the agent optimizes what we measure, not what we mean: sim artifacts, gaming the benchmark term (only trading where the cohort did nothing), churn-farming shaping, impossible DT return prompts (paper §9.2) | Methodology | High | Med–High | Conservative offline objectives; adversarial red-teaming of the reward; leakage-guard ablations; **hard constraints** not soft penalties for worst behaviors; human review of rationale traces | **mitigated-by-design** |
| R5 | **Non-stationarity / regime shift** — an edge this month inverts next month; adaptation always *lags* the shift (paper §9.1) | Market | High | **High (certain over time)** | Treated as the design premise: recent-window replay, continual adaptation, fast meta-adaptation, regime-context inputs, frozen-regime re-eval, fast fallback to conservative policy on detected shift | **mitigated-by-design** (residual: lumpy performance, loss periods are *expected*, not anomalous) |
| R6 | **Adversarial market — MEV, rugs, honeypots, manipulation** — the environment is engineered to extract from newcomers; danger is both losing to it *and* the agent learning to *imitate manipulators* (pump-then-dump is locally rewarded) (paper §9.5) | Adversarial | High | High | Rug/honeypot avoidance as a first-class learned objective **and** a hard safety filter; MEV modeled in the sim; explicit policy constraint against detectable manipulation-following; shades into ethics (§3) | **open / mitigated-by-design** |
| R7 | **Overfitting to a meta / backtest overfitting** — the most common way trading ML lies (paper §9.6) | Methodology | High | High | Strict walk-forward (never random splits); held-out time periods; paper→live gap monitor; population-based robustness selection; **pre-registered** metrics/bars | **mitigated-by-design** |
| R8 | **Residual selection bias in the labeled-trader DB** — *real but bounded*; full win-and-loss histories defuse the classic survivorship trap, leaving a milder "who was active enough to be labeled" effect (paper §9.3) | Data | Med | Med | Full-history (wins+losses) labeling as default; broaden cohort; evaluate on **forward** data labels never touched; imitation as **warm-start prior only**; luck-vs-skill persistence tests; discount headline outperformance modestly | **mitigated-by-design, and now MEASURED** (2026-08-28). Two results sharpen this row rather than closing it: (a) the wallets that beat the agent at rung 1000 were selected by SOL *balance*, so their outperformance is partly a selection artefact of exactly the kind this row names; (b) earliness survives a split-sample test with zero pair overlap, which is the persistence test this row asks for — but only over a 21-hour window, so it does not yet discharge the risk. The cohort ladder additionally found that a bigger cohort makes imitation *worse*, so "broaden the cohort" is no longer an unqualified mitigation. |
| R9 | **Prompt-injection via web-search & chatter tiers** — from Phase D the agent ingests untrusted external text designed to manipulate it ("safe 100× buy now") (paper §9.7) | Security | Med–High | Med | All external content is **data, never instructions**; policy consumes it as embedded features; tool outputs sandboxed; **no ingested text may alter caps, safety settings, or control flow**; coordinated shills also treated as training-signal poisoning (R6) | **mitigated-by-design** |
| R10 | **Counterfactual-impact problem** — the agent's order wasn't in the historical tape; estimating how its presence would alter subsequent fills has no perfect solution; multi-agent market sim is itself unsolved (paper §9.4) | Methodology | Med–High | High | Conservative own-impact-only default (documented lower bound); treat the live gap as ground truth; richer agent-based calibration flagged as later research, not assumed | **open (documented fidelity limit)** |
| R11 | **Catastrophic forgetting** — naive online fine-tuning overwrites competence on regimes that vanished but will return (paper §6.6) | Methodology | Med | Med–High | Experience replay/rehearsal with a curated core set; EWC-style regularization; periodic re-eval on a **frozen regime battery**; conservative gated updates | **mitigated-by-design** |
| R12 | **Population is correlated overfit** — 100 agents that all overfit one replay window is 100 ways to fail together, not robustness (paper §6.4) | Methodology | Med | Med | Validate behavioral diversity **out-of-sample and across regimes**; each retained archetype must be **individually edge-positive** after costs; agreement across independently-evolved archetypes used as a robustness signal | **mitigated-by-design** |
| R13 | **Ethics of releasing an autonomous trading agent "into the world"** — amplifies manipulation, harms over-trusting users, degrades market quality; memecoin markets are near zero-sum-minus-fees (extraction from retail) (paper §9.9) | Ethics / product | High | Depends on ship/publish/trade choice | Decide intended use explicitly (charter §6); if shipped, treat as a serious financial product: no personalized-advice framing, hard risk caps, transparent loss disclosure, **refuse manipulation-primary features**; scam-as-training-signal must not become scam-as-behavior | **open — gated on the pending decision** — see §3 |
| R14 | **Feasibility honesty** — the *strongest* form (from-scratch self-play reaching a reliable 100×) is **not achievable as literally stated** (paper §9.10, §6.1) | Framing | Med (to expectations) | **Certain** | Reframe to the achievable program (bootstrap + faithful sim + population + risk-adjusted rewards + online adaptation + strict gating); the 100× is a north-star, not a promise | **mitigated-by-design** (expectations managed in charter + README) |

---

## 2. The safety envelope (R1 — non-negotiable, structural)

Safety is **structural, not behavioral** (paper §9.8). The controls are properties of the system, not
things the agent is asked to respect:

- **The 1→100 goal is never the training reward** — it would train ruin-seeking lottery play (paper §3.5). It survives only as an evaluation north-star.
- **Risk as hard constraints, not soft penalties.** Per-token and per-session position caps and a max-drawdown circuit-breaker enter as **environment constraints / action masks** (a constrained-MDP framing), plus CVaR/distributional objectives — not tunable trade-offs.
- **The agent only ever *proposes*.** All live action passes through OCT's existing **`/sniper/v1`** control plane — per-fire, per-trigger, and daily caps, max-open-positions, and a **kill switch** — which the agent **cannot modify**. `executeFire` is the only function that spends; the agent never touches it and never reads the venue token (per root `CLAUDE.md`).
- **Human-in-the-loop for scale-up.** Any increase in caps requires human approval.
- **Hard absolute loss limit.** A small absolute loss limit halts the agent **regardless of its confidence**.
- **Promotion gate.** Live is gated behind sustained paper performance; a freshly updated online policy must clear the evaluation battery before it may size up, and always stays inside the caps.

**Residual risk (kept open):** an online-learning agent can *drift* into pathology **between**
evaluations. The frozen-regime re-eval battery (R11), regime-shift detection (R5), and the hard loss
limit bound this, but it cannot be driven to zero — hence R1 stays `mitigated-by-design`, never `closed`.

---

## 3. Ethics stance (R13 — gated on the pending ship/publish/trade decision)

The paper (§9.9) is explicit: shipping autonomous trading agents raises real harm questions —
amplifying market manipulation, harming inexperienced users who over-trust automation, and degrading
market quality at scale. Memecoin markets are already near zero-sum-minus-fees, so an "edge" is largely
**extraction from other participants, many of them retail.**

**Stance carried by this program:**
- The **ship/publish/trade decision (charter §6) must be made explicitly** — it sets how binding this section is. Until then, documents assume the most demanding path (ship-as-feature).
- **If shipped:** treat it with the seriousness of any financial product — no personalized-advice framing, hard risk caps, transparent disclosure that it *can and will lose money*, and a **refusal to build features whose primary function is manipulation**.
- **Scam/manipulation as *training signal* (learning from rugs and shills) must not become scam/manipulation as *learned behavior*** (ties to R6). An agent that learns to trigger and ride pumps is a manipulation participant, and that is out of scope by charter.

---

## 4. Fatal-risk summary (the paper's honesty, preserved)

The paper states plainly that several risks are potentially fatal to the *strong* form of the vision.
For decision-making, the three that most determine whether the program should proceed:

1. **R2 (sim fidelity)** — if the simulator's exploits don't transfer, nothing downstream is trustworthy. Phase 0 exists to resolve this first.
2. **R3 (does an edge even exist)** — the single open empirical question; answered at the Phase-1 gate. A "no" is a legitimate, valuable, program-ending outcome.
3. **R1 (catastrophic capital risk)** — the risk the operator should weigh most heavily; mitigated only by the structural safety envelope in §2, never by the agent's good behavior.

Everything else in this register is a threat to *validity or performance*; these three are threats to
whether the program should exist in its strong form at all.
