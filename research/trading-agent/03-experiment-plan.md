# 03 — Experiment Plan / Research Roadmap

**Program:** OCT Autonomous Trading Agent
**Status:** In execution — Phase-1 gate answered **NO-GO** and is now CLOSED (final rung 2026-08-28); Phase 2 has its first positive tier-B result (earliness). Outcome notes inline; results detail in paper §12 and `PROGRESS.md`.
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

**Outcome (2026-08-24): NO-GO, at every scale tested.** First run: 3 seeds × 24 live bonding-curve
tokens, agent −24 to −47 bps/episode vs hold-SOL, leakage guard passed (so the null is honest).
Escalation converged from two independent directions: the single-agent PPO **token-count ladder**
(10 → 100 → 149 tokens — the 1k rung truncated to every trainable token the dataset held) saw the
held-out edge vs hold-SOL shrink toward zero (+0.60 noise → +0.074 → +0.0023) and go negative vs
buy-and-hold at 149 tokens; independently, **MAP-Elites populations of 12 → 400 agents on
131 → ~2,600 tokens** produced champion win rates of 0.00–0.22 (mostly ≤0.10) in every niche of every
run, with best-PnL bouncing trendlessly (+130 → +7 → +3 → +90 bps) on lottery variance — the win-rate
shape, not the PnL, is the read (see `05-evaluation-plan.md` §1.1). Two methods, same verdict: no
durable chart-only edge after 125 bps modeled costs. Reported per the governing rules as a valid gate
answer; per the curriculum's design the program proceeds to Phase 2 (wallet flows first) rather than
ending — the chart tier is priced at ~zero and dropped as an edge source. Full detail: paper §12.1.

**Closing rung (2026-08-28): 1000 tokens, 1500 PPO iterations, 300 held-out. NO-GO, and the most
legible of the three** — because the baseline table names what the policy learned *instead* of an
edge:

| policy | mean_ret | sharpe | maxDD | hit% | trades | fees |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| learned_agent | -0.0001 | -0.08 | **0.031** | 1.0% | **2,549** | **0.01274** |
| tracked_traders | **+0.0002** | **+0.04** | 0.049 | 1.3% | **51** | 0.00026 |
| hold_sol | 0.0000 | 0.00 | 0.000 | 0.0% | 0 | 0 |
| buy_and_hold | -0.0166 | -0.53 | 5.005 | 4.0% | 300 | 0.00150 |

`edge vs hold_sol: -0.0001 (beaten 1.0%)` · `vs buy_and_hold: +0.0165 (82.7%)` ·
`vs tracked_traders: -0.0003 (3.0%)`.

The agent learned **risk avoidance, not edge**: the lowest max drawdown in the table by two orders
of magnitude, and the largest fee bill, to land a hair below the policy that trades nothing.
Beating buy-and-hold on 82.7% of tokens is not an edge — it is the value of *not holding a dying
asset*, which `hold_sol` gets free and without fees.

**The decisive line is the human one.** The 40 tracked wallets are the only positive policy in the
table, on 51 trades, and beat the agent on 97% of held-out tokens while trading 50x less. The
window was not unwinnable; the chart-only agent could not find what they found. Those 40 were
selected by SOL balance — by size, not skill — which is what makes Phase 2's selection question
sharp rather than academic.

**Tier A is closed.** Three rungs, two methods, one verdict. No further chart-only scaling is
justified, and the highest achievable rung on this dataset has been run.

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

**Status (2026-08-28): tier B has its first positive result — and it is the first feature in the
program with a monotone link to outcome that survives a split-sample test.**

*Earliness* (`data/census/earliness.py`) is a wallet's first-BUY price as a fraction of the token's
exitable peak. Across **552,916 ranked wallet-token pairs** it orders outcome without inversion
below the top bucket — win rate **0.606 → 0.063**, median PnL positive to negative — and reproduces
within ~0.02 per bucket on an independently captured, 2.5x smaller dataset.

**It predicts out of sample.** Splitting at the median first-buy timestamp, ranking wallets on the
first half only, and measuring them on the second (6,471 wallets qualifying on both sides, and
**zero of 100,715 wallet-token pairs recurring across the halves**): Q1 earliest returns +0.0147
median with a 0.403 win rate, Q5 latest −0.0204 and 0.350, monotone throughout. **Q1 is the only
quintile with positive median PnL**, which makes the usable form a top-quintile filter rather than
a continuous score.

Two findings attach to it, and both matter more than the headline:

* **Earliest is not best.** The 0–10% bucket underperforms 10–20% in both datasets. The
  wallet-level cut explains it: the 0–20% band carries a **21x higher wash/bot flag rate** (0.064
  vs 0.003). The absolute earliest cohort is disproportionately snipers buying everything,
  including the ~95% that die. The target is *early and selective*; the best band by median PnL is
  20–40%.
* **It is a wallet LABEL, not a live feature.** The peak is computed over the whole tape, so using
  it as an observation would be plain lookahead leakage. Its clean use is ranking who repeatedly
  arrives early, then following those wallets forward — which is the tier-B channel this phase was
  written for. Anyone wiring it into an observation vector should read this paragraph first.

**Next gate — the cohort ladder** (`scripts/cohort_ladder.py`). Phase 1 showed a balance-selected
cohort beating the agent, and earliness shows selection carries signal, so the open question splits
in two: does cohort **size** matter, and does cohort **selection** matter? The ladder runs rungs at
10/20/30/... wallets with an earliness-ranked arm and a size-matched PnL-ranked control, behavioural
cloning against each, seeds in parallel, entirely from data on disk. Without the control arm it
could only say "more is better", never "better-chosen is better" — and the second is the claim
worth testing.

*Prior status (2026-08-24), retained for the record:*
The imitation warm-start is live — 85.0% held-out-by-token intent accuracy cloning a first 8-wallet
tracked-trader cohort (2,006 swaps → 2,058 demos); it clones *behaviour*, not proven profit, and the
selection-bias caveat (paper §9.3) stays attached. The population stack shipped and produced its
predicted result pair: plain PBT climbed fitness (+692 → +996 bps best) while collapsing coverage
0.67 → 0.33 — the correlated-collapse failure this phase's gate warns against — and MAP-Elites held
coverage (0.667 small-run; 1.000 in every scaled run), proving the anti-collapse mechanism the
archetype deliverable depends on. Note the standing caveat from Phase 1: the archive currently
preserves a diverse set of *lottery-shaped* chart-only players; diversity is proven, edge is not.
Detail: paper §12.2–§12.3.

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
