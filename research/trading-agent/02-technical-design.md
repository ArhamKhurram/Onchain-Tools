# 02 — Technical Design Document

**Program:** OCT Autonomous Trading Agent
**Status:** Partly built — the data pipeline, feature store, simulator, RL core, ledger and evaluation battery exist under `src/oct_trading_agent/`; the convergence adapter (5) and the actuator bridge (6) exist only as interface stubs. Sections still marked *proposal* remain uncommitted.
**Source of truth:** [`00-paper.md`](./00-paper.md) (architecture in §4, training in §6, data in §7). This doc operationalizes it into components, interfaces, a stack, and a module layout. Where it goes beyond the paper it says so.

---

## 1. System overview

Six subsystems, plus the existing OCT infra they attach to:

```
                         ┌─────────────────────────────────────────────────────┐
   OCT existing infra    │            Trading-Agent R&D subsystem               │
 ┌──────────────────┐    │                                                      │
 │ Pinax new-pair   │───►│  (1) Data pipeline ──► (2) Point-in-time feature     │
 │ firehose (gRPC)  │    │        + labeling         store (leakage-audited)    │
 ├──────────────────┤    │            │                     │                    │
 │ Labeled wallet DB│───►│            ▼                     ▼                    │
 ├──────────────────┤    │  (3) Replay simulator  ◄──►  (4) RL training core     │
 │ Discord/TG        │───►│      (execution/impact/       (offline→online,       │
 │ chatter ingest    │    │       MEV/rug model)           PBT/ES/MAP-Elites,    │
 ├──────────────────┤    │            │                    distributional critic)│
 │ GMGN/DexScreener  │───►│            ▼                     │                    │
 │ enrichment        │    │  (paper-trading ledger)          ▼                   │
 ├──────────────────┤    │                          (5) Policy ensemble /        │
 │ /sniper/v1        │◄───│──── proposes only ────    convergence adapter        │
 │ caps + killswitch │    │                                  │                    │
 │  = ACTUATOR       │    │                                  ▼                    │
 └──────────────────┘    │                          (6) Safety/actuator bridge  │
                         └─────────────────────────────────────────────────────┘
                                                              │
                                                    OCT convergence layer
                                                     (score-level fusion)
```

Two trained models share this scaffolding: **Model N** (new-pair, this paper's subject) and, later,
**Model R** (revival policy — an extension of OCT's existing revival detector from alerter to policy).
They are trained separately (different candidate streams, horizons, failure modes) and fuse only at
the convergence layer.

---

## 2. Components & responsibilities

### (1) Data pipeline & labeling
- Wire the **Pinax new-pair firehose** (transaction-level swaps, liquidity events, holder changes, rug/honeypot events) into a durable, replayable store.
- Run the **trader-labeling pipeline** over the wallet DB: reconstruct each labeled trader's *full* on-chain history (wins **and** losses) into demonstration trajectories.
- Ingest token metadata (GMGN/DexScreener), social/narrative connectors, and Discord/TG chatter attribution.
- **Responsibility boundary:** produces raw, timestamped, append-only event streams. It does *not* compute features (that is the feature store's job) — this separation is what makes leakage auditable.

### (2) Point-in-time feature store
- Reconstructs, for any `(token, timestamp)`, exactly the features knowable *at that instant* — no look-ahead.
- Encodes missingness explicitly (new pairs have ragged, sparse data).
- Serves the five curriculum tiers' feature bundles (paper §3.2, §5): raw-chart core, wallet flows, metadata, narrative/social, chatter.
- **Standing leakage audit** as a first-class test (paper §7 "Data hygiene").

### (3) Replay simulator (the single largest engineering item)
- Simulates fills against **reconstructed pool state (AMM curve)** at the decision timestamp: realistic slippage as a function of size vs pool depth, price impact on the agent's own fills.
- **Counterfactual impact:** conservative default — apply impact to the agent's own execution, do **not** assume it changes others' behavior (a documented lower bound on adversariality). Richer agent-based calibration is a later research option, flagged as unsolved.
- **Latency & ordering:** models decision→inclusion delay and MEV (back-run/sandwich) as a stochastic slippage/failure penalty early, explicit MEV model later.
- **Fees, failed txns, priority fees.**
- **Rugs/honeypots as absorbing zero states** from the tape — avoidance is a first-class learned objective.
- **Recent-window replay is the default** (rolling ~past few days), with a retained older core set for anti-forgetting and a frozen regime battery.
- **The paper→live gap is the simulator's fidelity meter** and is monitored continuously.

### (4) RL training core
- **Offline pretraining:** IQL/CQL on historical tape + trader demonstrations (conservative about OOD actions since data can't be regenerated).
- **Imitation/IRL:** behavioral cloning + GAIL/AIRL to warm-start from labeled traders, then RL to surpass via the benchmark-relative reward.
- **Online fine-tune:** PPO against the sim, with a prioritized, recency-weighted replay buffer + curated core set.
- **Distributional critic** (C51/QR-DQN/IQN) for fat-tailed returns and CVaR/risk-sensitive objectives.
- **Population/evolutionary + quality-diversity:** PBT, evolution strategies, MAP-Elites over a behavioral-descriptor space (holding time, risk appetite, turnover, narrative sensitivity, wallet-flow reliance). Deliverable is the **archive of individually edge-positive archetypes**, not one champion.
- **Continual learning:** regime detection (always-on), fast meta-adaptation, EWC-style anti-forgetting, frozen-regime re-eval battery.
- **Algorithm-plural by design** — a pre-registered bake-off, not a single committed algorithm (paper §6.3).

**Rollout collection — as built (`agent/online/collect.py`, vectorized 2026-08-26).** Collection, not
the gradient step, is this program's training budget, so its mechanics are pinned here rather than
left to implementation:

- **One batched forward per timestep, not per env-step.** All active envs are stepped in lockstep:
  one `np.stack` of their observations → ONE forward → ONE fused device→host transfer carrying
  (intent, size, log-prob, quantiles) for the whole batch → the per-env `env.step` bookkeeping. Envs
  drop out of the active set as their episodes end, so a long tail costs only the envs still running;
  truncation bootstraps are batched the same way. Semantics are identical to the sequential loop (one
  episode per env in env order, per-env step cap, `last_value` 0 on a natural terminal vs the critic's
  value of the next state on truncation, train-only normalizer updates, sampled actions).
- **Why: the per-step forward was latency-bound, never compute-bound.** The policy is small (a 15-dim
  observation through a ≤128-wide two-layer torso into small heads), so a batch-size-1 forward buys no
  compute and pays a full host↔device round trip, plus a forced sync at every `.item()` /
  `.cpu().numpy()`. Measured on this model: **461 µs per env-step on CPU vs 2474 µs on CUDA** — the
  accelerator was 5.4x *slower*. Batching removes 68x of the CUDA collector's cost and 2.6x of the
  CPU's, after which the collector is ~10–12% of collection and **`env.step` is the remaining
  88–90%**. Device choice is therefore no longer the throughput decision at this model scale —
  `env.step` is.
- **Two honest caveats — vectorized runs are NOT bit-identical to sequential ones.** (1) The running
  observation normalizer now sees observations *interleaved across envs, one timestep at a time*
  rather than one complete episode at a time: the same multiset is folded in, but it is read while
  being written, so the standardized vectors — and hence the actions — diverge numerically. (2) RNG
  consumption differs: drawing B samples in one call advances the generator differently from B single
  draws. Neither is an approximation; a run remains **fully deterministic for a fixed seed**, it just
  walks a different, equally valid trajectory. With exactly one env the batch is size 1, the RNG lines
  up, and the two paths agree exactly — which is how the rewrite is unit-tested. The sequential loop
  is retained (`vectorized=False`) solely to reproduce pre-vectorization runs.

### (5) Policy ensemble / convergence adapter
- Wraps the surviving population into **one calibrated, independent signal** for OCT's convergence layer.
- Emits a *typed decision*: intent, size, confidence/value distribution, and a **rationale trace** (which features/tools drove it).
- Convergence-with-N vs convergence-without-N is a clean A/B (paper §4.3, §8.4).
- **Never fuses detections** — only exposes a score.

### (6) Safety / actuator bridge
- The **only** path to real funds. Translates a promoted policy's proposal into a `/sniper/v1` request.
- The agent may only **propose**; the sniper independently enforces per-fire/per-trigger/daily caps, max-open-positions, auth, and the kill switch. The agent cannot modify caps or disable the kill switch.
- Adds a **human-in-the-loop approval** for any cap scale-up and a hard absolute loss limit (paper §9.8, §10.4).

---

## 3. Interfaces

**Model → rest of OCT (common to Model N and Model R):**
- **Input:** a candidate token + its causal feature bundle (assembled by OCT ingestion/enrichment + the feature store).
- **Output:** typed decision `{ intent, size, value_distribution, confidence, rationale_trace }` + a `signal_contribution` for convergence.

**Action space (paper §3.3):** hybrid discrete-continuous per decision step, per candidate token:
- Discrete intent: `{ no-op, open-long, add, trim, close, hold }` (long-only in the alpha).
- Continuous size: fraction of a risk budget in `[0, f_max]` with a hard per-token cap.
- Phase-D+ information action: `{ web-search query, no query }` (costed).
- Optional later execution params: slippage tolerance / limit offset, order-splitting.

**Actuator interface (live only):** proposal → `/sniper/v1` (existing control plane, its own auth, not behind wildcard CORS). Agent never holds the venue token; it never spends directly.

**Episode interface (paper §3.4):**
- Per-token episodes (default, short-horizon scalper — seconds-to-minutes; earlier termination on full exit, token death, or liquidity floor).
- Per-session portfolio episodes (later — shared balance, max concurrent positions, total exposure; where the 1→100 trajectory lives).

---

## 4. Proposed tech stack

*Proposal — to be confirmed at Phase 0; nothing here is committed.*

| Layer | Proposed | Notes |
|---|---|---|
| Language | **Python 3.11+** for training/sim; TypeScript only at the OCT integration seams | The RL ecosystem is Python; the actuator bridge speaks to the existing TS `/sniper/v1`. |
| RL algorithms | PyTorch + a vetted RL lib (e.g. CleanRL-style explicit implementations, or Stable-Baselines3 for PPO baselines; d3rlpy for offline CQL/IQL) | Prefer explicit, auditable implementations over heavy frameworks for the core loop. |
| Distributional critics | Custom C51/QR-DQN/IQN heads on the shared encoder | Fat-tailed returns require this (paper §6.3). |
| Population / QD | Ray Tune (PBT), a lightweight ES loop, and a MAP-Elites archive (e.g. pyribs) | Embarrassingly parallel; naturally fits Ray. |
| Sequence models | A Decision-Transformer variant (cautious return-conditioning on *risk-adjusted* targets) | Alternative framing for the multi-modal numeric+text stream. |
| Simulator | Custom Python core over reconstructed AMM pool state; vectorized replay | The largest build; correctness > cleverness. |
| Feature store | Point-in-time store over columnar storage (e.g. Parquet/Arrow; DuckDB for local analytics; time-partitioned) | Causality-first; missingness explicit. |
| Streaming/ingest | Pinax gRPC client → durable append-only log (e.g. object storage + a message queue) | Replayability is the requirement. |
| Text encoding | A frozen or slowly-updated sentence/text encoder for chatter + web-search outputs | Sandboxed; outputs are data, never instructions (paper §9.7). |
| Experiment tracking | A run tracker + a pre-registration record (metrics/bars fixed before runs) | Enforces "no post-hoc goalpost moves." |
| Orchestration | Ray for distributed rollout/PBT; single-node feasible for Phase 1 | Scale up only when the population arrives (Phase 2). |

---

## 5. Integration with OCT's existing infrastructure

Three concrete couplings (paper §4, §7, §10.4; root `CLAUDE.md` sniper section):

1. **Pinax new-pair firehose** — the transaction-level tape that feeds the replay simulator and the feature store. *To be wired* (per the paper's data table). This is the primary data dependency.
2. **Labeled wallet DB** — the operator's database of active daily traders, labeled by full win-and-loss histories. Feeds imitation bootstrapping and the per-token benchmark opponents. The full-history labeling is what defuses most survivorship bias (paper §9.3).

   **Census + earliness (`data/census/`).** The DB is now derived from the captured tape itself
   rather than only supplied: `crawler.py` reduces the swap frame to one row per (wallet, token)
   with FIFO-realized PnL, and `earliness.py` adds how early into a token's life the wallet bought.
   At `market_dataset_large` scale that is 832,606 pairs over 94k wallets and 31,085 tokens, on
   disk, with no vendor call — which is what makes wallet-selection experiments reproducible and
   rate-limit-free. Earliness is a **label, not an observation**: its denominator is a hindsight
   peak, so it must never reach the feature store (see `04-data-spec.md` §2.1a).
3. **`/sniper/v1` control plane as the live actuator + safety envelope** — reused, **not rebuilt**. Per `CLAUDE.md`: it mounts on its own hardened control plane (its own body parser, rate limit, auth, strict Origin/Host check), *before* `app.use(cors())`, deliberately **not** under `/api`. `executeFire` is the only function that spends, with every control (kill switch, caps, max open positions) a step inside it. The agent integrates by **proposing** to this plane — it does not touch `executeFire`, does not read the venue token (read late, never escapes the call frame), and cannot alter any cap. This boundary is a hard architectural rule, not a convention.

Also reused as features / signal context: GMGN/DexScreener enrichment (metadata, safety flags), Discord/TG chatter ingestion + honest-caller reliability scoring, and OCT's existing signals (revival, FOMO smart-money, convergence). Model N becomes **one more independent input** to the convergence layer — score-level fusion only.

---

## 6. Repo / module layout

Under `research/trading-agent/` (code lands only when a piece is being built; this was the target
shape and the package now largely follows it, rooted at `src/oct_trading_agent/`):

```
research/trading-agent/
├── 00-paper.md ... 06-risk-register.md      # this doc set (present now)
└── src/oct_trading_agent/
    ├── data/
    │   ├── pinax_client/                     # firehose ingest → append-only log
    │   ├── labeling/                         # trader-DB full-history → demonstrations
    │   └── connectors/                       # social/narrative + web-search harness (sandboxed)
    ├── featurestore/
    │   ├── pointintime/                      # as-of reconstruction, missingness encoding
    │   ├── tiers/                            # A raw-chart · B wallet-flows · C metadata · D social · E chatter
    │   └── leakage_audit/                    # standing causality tests
    ├── sim/
    │   ├── amm/                              # pool-state reconstruction, slippage/impact
    │   ├── execution/                        # latency, MEV, fees, failed-txn model
    │   ├── rug/                              # honeypot/rug absorbing states
    │   └── replay/                           # recent-window replay + frozen regime battery
    ├── agent/
    │   ├── encoders/                         # per-token encoder → cross-token context; text encoder
    │   ├── policies/                         # actor heads; hybrid discrete-continuous action
    │   ├── critics/                          # distributional (C51/QR-DQN/IQN), CVaR objectives
    │   ├── offline/                          # IQL/CQL pretraining
    │   ├── imitation/                        # BC, GAIL/AIRL, DAgger corrections; cohort demos
    │   ├── online/                           # PPO fine-tune, prioritized recency buffer
    │   ├── population/                        # PBT, ES, MAP-Elites archive
    │   └── continual/                        # regime detection, meta-adaptation, anti-forgetting
    ├── eval/
    │   ├── metrics/                          # Sharpe/Sortino/CVaR/drawdown/per-token edge
    │   ├── walkforward/                      # time-ordered splits only
    │   ├── ablations/                        # per-tier + leakage-guard + convergence A/B
    │   └── gate/                             # backtest→paper→live promotion ladder
    ├── ledger/                               # paper-trading ledger
    ├── bridge/                               # actuator bridge → /sniper/v1 (propose-only)
    └── convergence/                          # calibrated single-signal adapter for OCT
```

Rationale for the split: **data → featurestore → sim → agent → eval** is the dependency order and
the leakage firewall — features are never computed in the data or sim layers, so causality is
auditable at one boundary. `bridge/` is the *only* module allowed to reference `/sniper/v1`, keeping
the "propose-only, never spend" rule enforceable by code review at a single seam.

---

## 7. Open technical decisions the paper left to implementation (flagged)

- **Counterfactual-impact model depth** — the paper mandates "start conservative," but the exact impact curve and when (if ever) to move to agent-based calibration is a Phase-0 call. *Assumed: conservative own-impact-only for Phase 0–1.*
- **Exact behavioral-descriptor axes for MAP-Elites** — the paper lists candidates (holding time, risk appetite, turnover, narrative sensitivity, wallet-flow reliance); the final axis set is an experimental choice at Phase 2.
- **Which encoder / whether Decision-Transformer becomes primary** — left to the pre-registered bake-off (paper §6.3). *Assumed: PPO+distributional critic as the default spine, DT as a tracked alternative.*
- **Storage/streaming concrete tech** — the paper says "substantial storage/streaming"; specific choices (queue, columnar format) are a Phase-0 decision above and not binding.
