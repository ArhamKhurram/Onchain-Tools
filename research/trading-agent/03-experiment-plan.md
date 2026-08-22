# 03 — Experiment Plan / Research Roadmap

**Program:** OCT Autonomous Trading Agent
**Status:** Proposal / pre-Phase-0
**Source of truth:** [`00-paper.md`](./00-paper.md) §10 (phased roadmap) and §5–§8. This is the executable version — each phase as a runnable experiment with a hypothesis, method, dataset, primary metric, go/no-go gate, exit milestone, and rough effort/compute.

**Governing rules (apply to every phase):**
- **Pre-register** metrics and bars *before* running; no post-hoc goalpost moves.
- **Walk-forward only** — time-ordered splits, never random. Held-out **time periods** and held-out tokens.
- A **"no" at any gate is a valid, reportable outcome** — it answers the go/no-go question (charter §2) and can end the program honestly.
- Live real money is gated behind paper and hard caps, always.

---

## Phase map at a glance

| Phase | Curriculum | Core deliverable | Gate question |
|---|---|---|---|
| **0** | — | Replay simulator + data pipeline + ledger | Does the sim faithfully reproduce real fills, leakage-free? |
| **1** | A (raw chart) | First learned policy, "naked chart" baseline | Does *any* edge survive realistic costs, out-of-sample? |
| **2** | B→E (flows→chatter) | Per-tier ablations + diverse archetype population | Does each information tier add measurable marginal edge? |
| **3** | — | Traders-as-opponents + paper-live + safety bridge | Does it beat labeled traders on forward data and reproduce backtest in paper? |
| **4** | — | Convergence integration + optional revival unification | Does Model N improve OCT's ranking in a clean A/B? |

---

## Phase 0 — Foundations (simulator + data) — **the first real work item, detailed most**

Everything downstream is worthless if the simulator's exploits don't transfer (paper §6.1). This phase
is **engineering-heavy, not compute-heavy**, and it is where the program's credibility is won or lost.

**Hypothesis.** A replay simulator built from the Pinax new-pair tape, with an explicit
execution/impact/MEV/rug model, can reproduce known historical fills within a calibrated slippage
tolerance — i.e. it is faithful enough that exploits found in it will transfer to the chain.

**Method.**
1. Wire the **Pinax new-pair firehose** into a durable, replayable append-only log (swaps, liquidity events, holder changes, rug/honeypot events).
2. Build the **point-in-time feature store** with explicit missingness encoding and a **standing leakage audit** (as-of reconstruction; a feature that "knows the future" must fail the audit).
3. Build the **replay simulator**: fills against reconstructed AMM pool state; slippage vs pool depth; own-order price impact; latency/inclusion delay; MEV as a stochastic slippage/failure penalty; fees/priority fees/failed txns; rugs & honeypots as absorbing zero states. Default to **conservative own-impact-only** counterfactual assumptions.
4. Build the **paper-trading ledger** with correct cost accounting.
5. Build the **trader-labeling pipeline**: reconstruct labeled traders' *full* win-and-loss histories into demonstration trajectories.
6. Calibrate the simulator against a **validation set of tokens** with known real fills; measure reproduction error.
7. Run a **trivial baseline** (buy-and-hold, random) end-to-end: firehose → feature store → sim → ledger, with correct costs.

**Dataset.** Historical Pinax new-pair tape — **self-sufficient for this gate.** Every real swap already encodes its executed price, slippage, and fees on-chain, so the tape *is* the ground truth: no external validation set is needed. Calibration holds out real swaps, reconstructs pool state as-of the instant before each, has the sim predict the fill, and compares to what actually executed. The **labeled-wallet DB is NOT a Phase-0 dependency** — it feeds imitation warm-start (Phase 1) and traders-as-opponents (Phase 3). In Phase 0 we build the labeling *pipeline* against a fixture schema; the real DB is wired when Phase 1 begins. See [`04-data-spec.md`](./04-data-spec.md).

**Primary metric.** Simulator fill-reproduction error vs a calibrated slippage tolerance on **held-out real swaps** (the fill the sim predicts from pre-swap pool state vs the fill that actually executed in the tape).

**Go/no-go gate.**
- **GO** if: sim reproduces validation fills within the pre-registered slippage tolerance **AND** the leakage audit passes **AND** the trivial baseline runs end-to-end with correct costs.
- **NO-GO** if: reproduction error exceeds tolerance and cannot be closed with a richer (still conservative) execution model — this means we cannot trust *any* downstream result, and Phase 1 must not start.

**Exit milestone (paper §10.1).** Simulator reproduces known historical fills within calibrated tolerance; leakage audit passes; trivial baseline runs sim → paper ledger with correct costs.

**Effort / compute.** Largest single engineering item in the program. Modest GPU (encoders only); substantial storage/streaming for the tape. Weeks-to-months of engineering; near-zero training compute.

---

## Phase 1 — Raw-chart agent (Curriculum Phase A)

**Hypothesis.** From **nothing but the chart** (price, liquidity, volume, trade count, buy/sell volume imbalance — no wallet data, no metadata, no text), a learned policy can beat hold-SOL and buy-and-hold **after realistic costs** on held-out time periods. This is the cleanest possible test of whether *any* edge exists.

**Method.** Offline-RL pretrain (IQL/CQL) on historical tape + trader demonstrations → distributional critic → PPO online fine-tune against the sim. Short-horizon scalper episode (seconds-to-minutes). Build the evaluation battery ([`05-evaluation-plan.md`](./05-evaluation-plan.md)) and the walk-forward harness. Run the **leakage-guard ablation** (replace the tier with noise; performance must collapse to the prior/no-information level).

**Dataset.** Raw-chart-core features only, point-in-time; walk-forward time splits.

**Primary metric.** Risk-adjusted performance (Sharpe/Sortino, CVaR) **after realistic costs** vs hold-SOL and buy-and-hold baselines, on held-out periods.

**Go/no-go gate (the program's first decisive answer to charter §2).**
- **GO** if: the raw-chart agent clears the pre-registered risk-adjusted bar **AND** beats both baselines after realistic costs on held-out periods **AND** the leakage-guard ablation passes.
- **NO-GO** if: no edge survives costs, or performance vanishes under the leakage guard (it was exploiting leakage). A genuine "no" here is a legitimate program-ending result and should be reported as such.

**Exit milestone (paper §10.2).** As the GO gate.

**Effort / compute.** Meaningful but single-node-feasible RL training; distributed rollout optional.

---

## Phase 2 — Information tiers B→E + the archetype population (Curriculum Phases B–E)

**Hypothesis.** Each added information tier — wallet flows, then metadata, then narrative/social, then crowd chatter — adds **measurable marginal edge** on top of the naked chart; and a **diverse population of individually edge-positive archetypes** can be bred rather than a single brittle optimum. (Wallet flows are isolated *first* to price what "who is trading" is worth before any metadata/narrative confounds it.)

**Method.** Add tiers one at a time behind the mastery gate (paper §5.6): B wallet-flow features (smart-money/fresh-bot tagging, concentration, creator behavior) → C metadata → D social connectors + sandboxed, injection-safe web-search harness + text encoders → E chatter attribution + honest-caller reliability. Stand up **PBT + evolution strategies + MAP-Elites** over the behavioral-descriptor space for the archetype population. Per-gate ablation reporting; leakage-guard ablation at every tier; use privileged-critic → distill to smooth transitions.

**Dataset.** Progressively richer feature bundles per tier; social/narrative connectors; chatter attribution. Walk-forward throughout.

**Primary metric.** Marginal risk-adjusted edge **per tier** (with-vs-without ablation), plus out-of-sample behavioral spread and per-member edge for the population.

**Go/no-go gate.**
- **GO** if: at least the early tiers show a **statistically credible** marginal edge (multiple-comparison-disciplined) **AND** an out-of-sample-validated, diverse population of **individually edge-positive** archetypes exists.
- **Partial / honest-null:** a tier that does **not** help is *reported and dropped* — that is a valid scientific result, not a failure. The population must still contain individually edge-positive members; "diverse but unprofitable" does not pass.
- **NO-GO** if: no tier adds credible edge and the population is a set of correlated overfits (100 ways to fail together).

**Exit milestone (paper §10.3).** Each gate's ablation shows credible marginal edge (or an honest tier-dropped report); an OOS-validated diverse population of individually edge-positive archetypes exists.

**Effort / compute.** Higher — text encoders, retrieval, and the population multiply cost. Distributed rollout / PBT orchestration becomes necessary here.

**Decision checkpoint.** The **ship/publish/trade decision** (charter §6) should be resolved no later than this gate — it sets the required safety/ethics rigor for Phase 3.

---

## Phase 3 — Traders-as-opponents + paper-live + safety envelope

**Hypothesis.** The agent can move from solo competence to **benchmark-relative outperformance** vs the labeled-trader cohort on **forward** data, and a sustained paper run reproduces backtest within tolerance.

**Method.** Switch on the **benchmark-relative reward** (per-token edge vs the cohort, controlling for entry/exit timing) with an **opponent curriculum** (median trader → top decile). Stand up the **online continual-learning loop** (prioritized recency buffer + core set, regime detection, fast meta-adaptation, EWC-style anti-forgetting, frozen-regime re-eval). Integrate the **actuator bridge to `/sniper/v1`** (propose-only; caps + kill switch reused, not rebuilt). Run sustained paper trading on live new pairs.

**Dataset.** Live new-pair stream (paper fills via the sim's execution model); labeled cohort per-token actions for the benchmark; forward data the labels never touched.

**Primary metric.** Per-token edge vs labeled traders on forward data (distribution, fraction beaten, edge vs top decile), discounted for the residual selection effect (paper §9.3); and the **paper-vs-backtest reproduction gap**.

**Go/no-go gate.**
- **GO to a minimal-size live pilot** if: sustained paper reproduces backtest within tolerance **AND** per-token forward edge is positive after the selection-effect discount **AND** the safety envelope (caps, kill switch, human-approval-for-scale-up, hard absolute loss limit) is wired and verified.
- **NO-GO / demote** if: a large paper-vs-backtest gap appears (overfitting/leakage — halt), or forward edge is not positive after discounting.

**Exit milestone (paper §10.4).** Sustained paper run reproduces backtest within tolerance; forward per-token edge positive after the residual-selection discount; paper→live criteria formally defined; only then a minimal-size live pilot under caps.

**Effort / compute.** Sustained online infrastructure; live paper run over a real-time window. The safety bridge is small but must be verified rigorously (it is the money boundary).

---

## Phase 4 — Ensemble/convergence integration + optional revival unification

**Hypothesis.** Model N as one more independent convergence signal **measurably improves** OCT's ranking/decisions; and the shared RL scaffolding extends to **Model R** (revival) as a policy.

**Method.** Convergence integration (score-level fusion, signals kept independent); train the revival policy reusing the stack; run the combined A/B (convergence with vs without N).

**Dataset.** OCT's live ranking pipeline; the revival candidate stream.

**Primary metric.** Convergence-with-N vs convergence-without-N A/B on OCT ranking/decision quality; the revival policy's own gated battery.

**Go/no-go gate.**
- **GO** if: convergence-with-N measurably improves ranking in a clean A/B **AND** (if pursued) the revival policy clears its own gated battery.
- **NO-GO / ship-narrower** if: N adds no measurable convergence lift — it may still stand alone but does not get fused.

**Exit milestone (paper §10.5).** Convergence-with-N measurably improves OCT's ranking in a clean A/B; revival policy clears its own gate (if pursued — revival unification is explicitly optional).

**Effort / compute.** Moderate; mostly integration and a second training run on the same scaffolding.

---

## Cross-cutting hard rules (paper §10.6)

- Live real-money trading is gated behind paper performance and hard caps — **always**, no overrides that bypass caps or the kill switch.
- The 1→100 SOL goal is an **evaluation north-star, never the training reward**.
- Walk-forward only; pre-registered metrics; no post-hoc goalpost moves.
- Every fidelity gap and every discount for the residual trader-selection effect is documented, with headline numbers carrying those caveats.
