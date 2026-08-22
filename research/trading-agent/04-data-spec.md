# 04 — Data Specification

**Program:** OCT Autonomous Trading Agent
**Status:** Proposal / pre-Phase-0
**Source of truth:** [`00-paper.md`](./00-paper.md) §3.2 (observation space), §5 (curriculum tiers), §7 (data). This doc pins down every dataset, its schema, source, the point-in-time feature store, leakage rules, and a have-vs-build table.

**Prime directive:** every feature must be **strictly causal / point-in-time** — reconstructable from
only what was knowable at the decision timestamp. The single most common way trading backtests lie is
subtle future leakage (paper §7). Leakage audit is a **standing test**, not a one-time check.

---

## 1. Datasets

### 1.1 New-pair on-chain firehose (Pinax gRPC) — *to be built/wired*
The transaction-level tape that feeds both the replay simulator and the feature store. **This is the
primary data dependency.**

Event streams (append-only, timestamped, per token/pair):

| Stream | Fields (representative) | Feeds |
|---|---|---|
| Swaps | `ts, token, pair, side(buy/sell), base_amt, quote_amt, price, wallet, tx_sig, slot` | Raw-chart core; wallet flows; sim fills |
| Liquidity events | `ts, token, pair, event(add/remove), base_reserve, quote_reserve, lp_wallet, tx_sig` | Pool-state reconstruction (AMM curve); rug detection |
| Holder changes | `ts, token, wallet, balance_delta, holder_count` | Holder-count deltas; concentration |
| Rug / honeypot events | `ts, token, event(lp_pull/sell_disabled/authority_change), tx_sig` | Absorbing zero states in the sim; rug-flow labels |

### 1.2 Labeled wallet / trader database — *operator has it; labeling pipeline to build*
Active **daily** traders, labeled by their **full** on-chain histories (wins **and** losses — not
cherry-picked winners). This full-history property is what defuses most survivorship bias (paper §9.3).

| Field | Notes |
|---|---|
| `wallet, label(s)` | e.g. smart-money, fresh, bot, creator |
| Full trade history | Every trade per wallet: `ts, token, side, size, price, realized_pnl` — losses included |
| Derived reliability | For chatter tier: honest-caller reliability where the wallet maps to a caller |

Uses: imitation/IRL bootstrapping (demonstrations) and **per-token benchmark opponents**. Residual
selection effect only (paper §9.3) — mitigated by full histories, cohort broadening, forward-data eval,
and warm-start-prior-only treatment.

### 1.3 Token metadata — *partly available via OCT enrichment (GMGN/DexScreener)*
`name, ticker, decimals, total_supply, circulating_supply, mint_authority, freeze_authority,
lp_burn/lock_status, launchpad/venue, contract_safety_flags`. Largely static per token; several are
**rug-risk** features (Phase C).

### 1.4 Social / narrative — *connectors to build; web-search tool to integrate*
The token's X/Twitter account + stats; cross-platform engagement (TikTok/Instagram/X); and the
**outputs of a web-search tool** the agent may invoke (costed). Represented as text embeddings +
structured counts (Phase D). **Untrusted external content — data, never instructions** (paper §9.7).

### 1.5 Discord / Telegram caller chatter — *OCT already ingests*
Caller messages resolved to the token: `ts, caller_id, token, message, call_latency_vs_price,
caller_reliability`. Phase E — the "information-flow" tier. Most adversarial (shills, coordination);
handled in [`06-risk-register.md`](./06-risk-register.md).

### 1.6 OCT existing signals — *live in OCT*
Revival, FOMO smart-money, convergence, honest-caller scoring. Used as features and as the
convergence/ensemble layer (paper §4.3).

---

## 2. Feature tiers (per curriculum phase, paper §3.2 & §5)

All features causal, timestamped, normalized with **causal statistics**, missingness explicitly encoded.
Modeling shape: **per-token encoder → cross-token context** (so a decision conditions on the market-wide
regime — essential under non-stationarity).

| Tier | Phase | Features | Notes |
|---|---|---|---|
| Raw-chart core | **A** | price, liquidity (pool reserves), traded volume, trade count, buy/sell **volume** imbalance | **No wallet identities, no holder attribution, no names/tickers/text.** The "naked chart." |
| Wallet flows | **B** | unique buyer/seller counts, holder-count deltas, smart-money vs fresh/bot inflow, top-holder concentration, creator-wallet behavior | First tier that reads *who* trades; creator-dumping & concentration are early rug signatures. |
| Token metadata | **C** | name, ticker, supply, mint/freeze authority, LP lock/burn, venue, safety flags | Largely static; rug-risk + crude narrative priors via name/ticker embeddings. |
| Narrative / social | **D** | X account + stats, cross-platform engagement, web-search tool outputs | Text embeddings + counts; introduces the costed information action. |
| Crowd chatter | **E** | caller identity, call timing vs price, caller reliability | The information-flow tier; most adversarial. |

**Multi-resolution representation:** event-time and fixed-interval bars + a snapshot vector.

---

## 3. Point-in-time feature store & leakage rules

**Design.** The feature store answers: "for `(token, timestamp)`, what was knowable *at that instant*?"
— nothing later. It is a strict firewall between the raw event streams (data pipeline) and the model.
Features are **never** computed in the data or sim layers, so causality is auditable at one boundary
(see the module layout in [`02-technical-design.md`](./02-technical-design.md)).

**Leakage rules (enforced as standing tests):**
1. **No look-ahead.** A feature at time *t* may use only events with `ts ≤ t`. Example prohibited leak (paper §7): using a token's *final* holder count as an early feature.
2. **As-of reconstruction.** Pool state, holder sets, and social stats are reconstructed as-of *t*, not read from a later snapshot.
3. **Causal normalization.** Per-feature normalization uses only past statistics (no full-sample mean/std).
4. **Explicit missingness.** New pairs have ragged/sparse data; missingness is a first-class encoded value, not silently imputed from the future.
5. **Time-ordered splits only.** Train/val/test are walk-forward by time; random splits are prohibited (they leak future into past).
6. **Leakage-guard ablation.** Replacing a tier with noise must drop performance to the prior tier's level; if it stays high, the model was exploiting leakage (paper §8.4) — a failing result.
7. **Label hygiene.** Trader-demonstration labels use each trader's realized history as-of the trade, not hindsight-selected winners.

---

## 4. Storage & streaming

- **Ingest:** Pinax gRPC client → a durable, **replayable append-only log** (the replayability is the requirement, not the specific tech).
- **Recent-window default:** the primary training distribution is a rolling **~past-few-days** window (non-stationarity is the design, paper §6.2); older tape retained as a curated **core set** for anti-forgetting + a **frozen regime battery**.
- **Feature store:** point-in-time store over columnar, time-partitioned storage (e.g. Parquet/Arrow; DuckDB for local analytics) — proposal, confirmed at Phase 0.
- **Text:** chatter + web-search outputs encoded with a frozen/slowly-updated encoder; raw text retained for audit but consumed as **sandboxed data**.

---

## 5. Have vs. must-build

| Item | Status | Owner/Notes |
|---|---|---|
| Discord/TG chatter ingestion | **Have** | OCT ingests today; needs token-resolution for Phase E features. |
| Contract detection & enrichment (GMGN/DexScreener) | **Have** | Provides Phase-C metadata + safety flags. |
| Caller scoring (honest-caller reliability) | **Have** | Phase-E feature. |
| Revival, FOMO smart-money, convergence signals | **Have** | Features + convergence layer. |
| Capped/kill-switched sniper actuator (`/sniper/v1`) | **Have** | Reused as live actuator + safety envelope; not rebuilt. |
| Labeled wallet DB (raw) | **Have (to label)** | Operator has the DB; **labeling pipeline must be built** (full win-and-loss histories). |
| **Pinax new-pair firehose wiring** | **Must build** | Primary data dependency; feeds sim + feature store. |
| **High-fidelity replay simulator** (execution/impact/MEV/rug) | **Must build** | **Largest single engineering item** (paper §7, §10.1). |
| **Point-in-time feature store + leakage audit** | **Must build** | The causality firewall. |
| Social/narrative connectors + web-search harness | **Must build** | Phase-D; sandboxed, injection-safe. |
| Text encoders | **Must build/integrate** | Phase-D/E. |
| RL training infra (replay buffers, distributed rollout, PBT orchestration, checkpoint/eval batteries) | **Must build** | Scales up at Phase 2. |
| Paper-trading ledger | **Must build** | Phase-0 deliverable. |

**One-line summary:** OCT already has the *intelligence* layer (chatter, enrichment, scoring, signals,
actuator); the trading-agent program must build the *quantitative* layer (firehose wiring, the faithful
simulator, the point-in-time feature store, the labeling pipeline, and the RL/eval infrastructure).
