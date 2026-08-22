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

## 2026-08-22 (f) — Pinax key live; live WS firehose discovered

**Findings**
- **`PINAX_API_KEY` populated and verified** — REST `/v1/networks` → HTTP 200 (auth works; the 400 on
  `/v1/svm/swaps?limit=1` is just missing query params, not auth). Key + JWT now in `backend/.env`
  (`PINAX_API_KEY` for REST `X-Api-Key` / Substreams gRPC bearer; `PINAX_API_TOKEN` = JWT for WS).
  Live ingestion + real fill-reproduction calibration are unblocked.
- **Pinax exposes a live decoded-swap WebSocket firehose** — `wss://ws.pinax.network/ws/solana@swaps?token=<JWT>`
  — cleaner than Substreams gRPC for the live tail (no spkg, just `<network>@<table>` + token). Intended
  split now: **REST `/v1/svm/swaps` for historical backfill, WS `solana@swaps` for live.** Sent this to
  Agent A mid-build as an additive augmentation (keep the stream name parameterized).
- **Broader Pinax surface (PRO plan), noted for later — NOT in Phase-0 scope:** Token API, Prediction
  Markets, Perp Exchanges, Blobs, RPC, Firehose; WS streams incl. `solana@spl_transfer`,
  `bsc@erc20_transfers`, `robinhood@erc20_transfers` (maps onto the operator's own Sol/BNB/Robinhood
  trading surfaces), `mainnet@swaps`, hyperliquid/polymarket. A real multi-chain experimentation surface
  for after the new-pair agent proves out.

---

## 2026-08-22 (e) — Scaffold merged (#160); Wave 1 (all four) launched

**Changes / status**
- **Scaffold merged — PR #160** (`99f618d`). Python package `oct_trading_agent` with typed core
  contracts (tape events, `Feature`+enforced-missingness, `Order`/`Fill`, `AgentDecision`,
  `AttentionState`+mandatory authenticity channel, leakage-audit hook). Gates were green
  (ruff/mypy-strict/pytest). Nested-namespace deviation accepted (good call). Reviewed the core
  contracts directly before merge — they're high quality (realized-only walling on `mark_price`,
  leakage audit = append-future-invariance, discriminated-union tape w/ dual slot/block_time).
- **Wave 1 launched — four parallel worktree agents, disjoint module ownership, PRs into the branch:**
  - **A · data/** — Pinax REST/gRPC client → append-only Parquet log; backfill; trader-labeling
    pipeline (fixture schema, real DB deferred). Tests on the revival spike's cached real responses.
  - **B · sim/ + ledger/** — constant-product AMM fills (slippage/impact/fees), execution realism
    (latency/MEV/failed-txn), rug absorbing states, replay driver (`Simulator` protocol), paper
    ledger, and the calibration harness (held-out real swaps → fill-reproduction error = the GO metric).
  - **C · featurestore/** — point-in-time store (explicit missingness), tier-A raw-chart features,
    the standing leakage audit (catches a deliberately-leaky feature).
  - **D · agent/encoders/** — Hawkes estimator (λ, branching ratio n) + manipulation-suspicion channel
    (both pure-numpy, mandatory) + causal-attention transformer w/ SSL head + the §6.4 two-head
    (stop-gradient public / task-coupled private) structure. Torch optional; suite green without it.

**Open / blocker for the GO gate (not for building)**
- **`PINAX_API_KEY` is EMPTY in `backend/.env`.** All four build+test on fixtures/synthetic, so this
  does not block the wave — but live historical backfill (Agent A) and therefore the real
  fill-reproduction calibration (Agent B) can't RUN until the key is populated. Need the value from
  the operator (revival spike must have sourced it from an env that's since been cleared).

---

## 2026-08-22 (d) — Phase-0 gate sharpened: tape is self-sufficient; labeled DB deferred

**Decisions (operator, correcting my over-flagging)**
- **The Pinax tape is the ground truth for the Phase-0 gate — no external validation set.** Every
  real swap already encodes executed price, slippage, and fees on-chain. Calibration = hold out real
  swaps, reconstruct pool state as-of the instant before each, sim predicts the fill, compare to what
  actually executed. Cleaner and fully self-contained. (03-experiment-plan Phase 0 Dataset + Primary
  metric updated accordingly.)
- **Labeled-wallet DB is NOT a Phase-0 dependency.** It feeds imitation warm-start (Phase 1) and
  traders-as-opponents (Phase 3), not the GO gate (sim reproduces fills + leakage audit + trivial
  baseline). Phase 0 builds the labeling *pipeline* against a fixture schema; the real DB is wired at
  Phase 1. Removes both prior "needs you" data blockers — Phase 0 needs only the tape.

---

## 2026-08-22 (c) — Phase 0 build launched (scaffold agent running)

**Decisions**
- **Language: Python-first, native-kernel-ready.** Build correct in Python (Phase-0 doc: correctness
  > cleverness), vectorized with numpy/polars. Keep the simulator hot loop behind a clean interface
  so it can be swapped to a **Rust** kernel (PyO3/maturin — preferred over C++ for Python bindings +
  Solana-ecosystem fit) *only where profiling proves it's needed*. No premature native code. (Operator
  asked for "fastest/most efficient for non-Python parts"; this is the honest answer — memory-bandwidth-
  bound vectorized replay gets most of the way in polars before any native kernel earns its keep.)
- **Data access resolved.** Pinax creds already exist in the monorepo `backend/.env` as `PINAX_API_KEY`.
  Proven access (from the revival spike, `oct-revival/spike/revival-scanner/src/`): REST
  `https://api.pinax.network` (`X-Api-Key`); Substreams gRPC `https://solana.substreams.pinax.network:443`
  (bearer = raw `PINAX_API_KEY`, NOT a JWT — verified 2026-08-04); package `dex-swaps-v0.5.2.spkg`
  (pinax-network/substreams-svm), same data as REST `/v1/svm/swaps`. Creds read at runtime from
  backend/.env, never hardcoded/committed. Still TBD for the GO gate: a validation set of *known real
  fills* to calibrate the sim against, and the labeled-wallet DB in queryable form.

**Changes / status**
- **Step 0 (scaffold + shared contracts) agent launched** — worktree-isolated, PRs into
  `research/trading-agent`. Establishes the Python package + the typed contracts (tape events, feature
  bundle w/ explicit missingness, Order/Fill, AgentDecision, AttentionState w/ authenticity channel,
  leakage-audit hook) that Wave 1 builds against. Wave 1 (Data+labeling · Simulator+ledger ·
  Feature-store+leakage-audit · Attention-pretrainer) fires once the scaffold PR merges.

---

## 2026-08-22 (b) — Codependence decision; Phase 0 build kicking off

**Decisions**
- **The attention model and the agent are codependent — trained side by side, not in sequence**
  (operator's call, reading the attention paper). New pairs *are* attention markets (price ≈ the
  derivative of crowd attention), so an agent trading here trades *within* the attention system the
  model estimates; the two are one jointly-optimized system with two heads. Folded into paper §4.4
  ("Codependent training") and companion §6.4 (mechanics). Key points: (a) encoder is co-trained
  end-to-end with the policy — pretraining is a warm start, not a freeze; joint loss
  `L_RL + β·L_SSL` with β annealed; (b) the reflexive coupling (the agent's own flow inflates the
  branching ratio it reads) is *why* joint training is mandatory, not just convenient — an encoder
  frozen on passive-observer flow misreads the tape the moment the agent acts; (c) a **stop-gradient
  copy** of the SSL representation feeds the convergence layer / standalone alert, so the shared
  signal stays flow-derived and independent even as the agent's private view specializes.
- **Attention-as-independent-signal survives** — the model can still be *born alone* (pretrained,
  shipped as an alert before the agent exists). Standalone-first is the delivery hedge; codependence
  is the mature state.

**Changes**
- Paper §4.4: new "Codependent training" paragraph; wire-in point 1 now says "warm start, not a freeze."
- Companion sub-project: new §6.4 "Codependent training with the agent (mechanics)."

**Open / next**
- **Phase 0 build is being scoped for a multi-agent launch** (simulator + data pipeline + feature
  store + attention pretrainer + eval harness) — pending operator's go. Ground truth for the scope:
  `03-experiment-plan.md` Phase 0 and `02-technical-design.md` §6 module layout. Phase 0 is
  engineering-heavy, near-zero training compute; the deliverable is a *fidelity-measurable simulator*,
  not a trained agent. Hard gate: sim reproduces real fills within tolerance + leakage audit passes.

---

## 2026-08-22 (a) — Attention model folded in; signal-first locked; workspace synced to the paper

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
