# Revival Scanner — project context & architecture

**Status:** pre-spike (see `Sprint 1.md`, Workstream C)
**Chains:** Solana + BNB Chain + Robinhood Chain — the top-3 memecoin DEX venues
by volume, and where the operator actually trades.
**Last verified:** 2026-08-04

A multi-chain scanner that detects **early revivals in dormant risky tokens**
(primarily memecoins) before they're obvious. It is a real-time analytics and
alerting system — **not** an execution bot, not MEV, not HFT. Latency budget is
seconds, not milliseconds.

This document is the hand-off brief: vision, decisions already made, constraints,
and open questions. Read it before proposing architecture — several obvious
alternatives were already considered and rejected.

**Companion doc:** [`TRAINING_ARCHITECTURE.md`](TRAINING_ARCHITECTURE.md) —
the learning loop (signal inventory + ≤24h operator ratings), the full signal
catalog, model strategy (hand gates → GBT scorer → quality-diversity genetic
detector population), the attention-economy layer, and the
accumulation-vs-bundle-rug discrimination problem. Decision 2026-08-04: **both
alert tiers push-notify**, Tier 1 under a ranked top-N/day budget.

---

## Core philosophy: own the pipeline

```
Blockchain → swap events → normalize → database → candles → indicators
          → revival detection → alerts
```

Everything downstream of ingestion operates from **our own database**. We do not
poll third-party APIs for live prices or indicators (rate limits, cost, latency,
no custom analytics, no reproducibility). Ingestion is chain-specific; everything
after the normalizer is chain-agnostic.

## Data ingestion: two technologies, one normalizer

| Chain | Technology | Notes |
| --- | --- | --- |
| Solana | Pinax Substreams gRPC | `dexes` v0.5.2, indexed at head |
| BNB (`bsc`) | Pinax Substreams gRPC | `dexes` v0.5.0, indexed at head |
| Robinhood Chain | **Custom EVM RPC adapter** | Not on Pinax. Arbitrum Orbit L2, chain id 4663, standard JSON-RPC at `rpc.mainnet.chain.robinhood.com` + WSS sequencer feed; Blockscout explorer; QuickNode/Chainstack/Alchemy all serve it. Adapter = WSS/`eth_getLogs` subscription decoding AMM Swap/Mint/Burn logs into the same normalized events. |

The normalizer seam is what makes a third ingestion path cheap: everything
downstream of `SwapEvent` is chain-agnostic and does not change.

Pinax credentials (in `backend/.env`):

| Product | Role | Credential |
| --- | --- | --- |
| **Substreams gRPC** (per-chain endpoints) | The live spine — streaming DEX events | `PINAX_API_TOKEN` (JWT, expires 2036) |
| **REST** `api.pinax.network` | Backfill + slow metadata only | `PINAX_API_KEY` |

**Robinhood adapter research (open, spike-adjacent):** enumerate the AMMs and
launchpads to decode — the launchpad scene is churning (NOXA drove the initial
boom then shut down mid-July 2026; Flap / hood.fun / Bankr / Openfair compete
now), and launchpad→AMM migrations (the "M" moment on GMGN charts) matter
because ignition often clusters around them. REST-side pagination limits found
on Pinax (~10s query deadline on pool-filtered scans, serial-only) reinforce:
REST is for bootstrap, never the spine.

Verified 2026-08-03:

- REST is live: `/v1/svm/swaps?network=solana` returns rich, near-real-time swap
  payloads (pool, AMM/program name, tokens with symbol+decimals, signers,
  block+timestamp) — already close to our normalized schema. Use for **backfill**
  (baselines) and metadata; its OHLC endpoints only go down to 1h, so it is
  **never** a live price source.
- Networks with `dexes` indexed at head include **`solana` (v0.5.2)** and
  **`bsc` (v0.5.0)** — our two launch chains. Also available: arbitrum-one,
  avalanche, base, hyperevm, mainnet, optimism, polygon, unichain.
- **Robinhood Chain is NOT on Pinax** (checked the full network list). It was in
  the original vision; it cannot be a launch chain. Revisit if/when a provider
  supports it.

## Normalized event model

The normalizer emits chain-agnostic events; nothing downstream knows the chain
beyond a field.

```
SwapEvent:      timestamp · chain · dex · pool · token0 · token1 · price
                amountBase · amountUsd · side · wallet · txHash
LiquidityEvent: timestamp · chain · pool · kind(add|remove) · amountUsd
PairCreated:    timestamp · chain · pool · token0 · token1
```

Three streams, not one: liquidity add/remove is itself a first-class revival
signal (and rug guard), and per-pool reserve state gives a **mid-price** that's
cleaner than single-swap execution prices.

## Storage: Postgres + TimescaleDB

- **Raw normalized events are canonical** — hypertables, compressed, kept.
- **Derived data (candles, indicators) is rebuildable, not unstored.** Candles
  are materialized (continuous aggregates); recomputing seven timeframes on read
  does not survive contact with millions of events. The principle is
  *disposable/rebuildable*, not *never persisted*.

## Candles: resolution follows token state (the cost governor)

Candle fields per timeframe: OHLC, volume, buyVolume, sellVolume, tradeCount,
uniqueBuyers, uniqueSellers.

| Token state | Resolution | Where |
| --- | --- | --- |
| Dormant (most tokens, most of the time) | 1m only, volume+liquidity focus | DB continuous aggregate |
| Watching / Reviving (dozens at a time) | + 5s/15s + full indicator suite | in-memory ring buffer |

Compute scales with *active* tokens, not *tracked* tokens. This is the single
most important cost decision — without it, per-second candles across every token
on two chains blows the "predictable monthly cost" constraint immediately.

## Indicators (computed locally, incrementally)

**Core: ATR — with memecoin-specific mechanics:**

- Use **ATR% (ATR/close)**, never raw ATR (scale-dependent across tokens).
- Wilder smoothing (ATR14), computed **incrementally** — O(1) per candle, no
  recompute jobs.
- Candle price = per-candle **VWAP or pool mid-price from reserves**, not raw
  execution prices — kills sandwich-wick pollution at the source.
- Sparse data: forward-fill closes on zero-trade candles (TR→~0 in dormancy is
  the *point* — expansion from near-zero is the signal) but **floor the
  denominator** in expansion ratios or they explode.
- The trigger metric is **expansion**: current ATR% vs the token's own trailing
  24h baseline, as a z-score.

**Supporting:** volume, RVOL, buy/sell volume + ratio, unique buyers/sellers,
returning buyers, liquidity level/added/removed/growth%, EMA/VWAP. Lower
priority: MACD, RSI. Market cap velocity + holder growth: see open questions.

## Detection: one trigger, hard gates — NOT a blended score (v1)

First, before any code: **define "revival" operationally** (e.g. *price sustains
≥ +X% for ≥ Y min on ≥ Z unique buyers after ≥ D hours of dormancy*). Without a
written target event there is no precision/recall, and tuning is vibes.

```
TRIGGER   ATR% expansion z-score > k        (volatility wake-up)
GATE 1    RVOL > threshold                  (volume confirms it's real)
GATE 2    unique buyers ≥ N                 (a crowd, not one wallet)
GATE 3    buy/sell ratio > r                (accumulation, not distribution)
GATE 4    liquidity flat-or-growing         (rug guard)
```

All gates must pass. AND-logic is interpretable, debuggable, and each gate's
marginal precision is measurable by toggling it in backtests. A weighted
composite score is a **later** refinement fitted on labeled data from our own
stored history — not a day-one guess. (Rejected: single-indicator alerts, and
day-one blended scores.)

## Revival archetypes — expect several patterns, not one

Interim spike data and trading experience both say revivals come in flavors.
Two archetypes are established; the labeled set will likely reveal more:

**A — Crowd ignition** (what the current detector targets): ATR% explodes,
unique buyers explode, volume confirms. By the time all gates pass, the move
has started — measured median lead was ~0 to −2 min. High confidence, late.

**B — Quiet accumulation → coordinated push** (the PIPECAT pattern): hours or
minutes *before* ignition, someone gathers supply. The footprint is nearly the
**inverse** of the crowd gates:

- buy-skewed flow with **few** unique wallets (a cluster absorbing, not a crowd)
- elevated volume with **low price displacement** (absorption: sells get eaten
  without the price moving)
- a **micro ATR% blip** off a near-zero dormancy baseline — far below the main
  z=3 trigger, but statistically distinct because the baseline is dead flat
- then, later: launchpad→AMM migration and/or the coordinated social push, and
  archetype A fires

**Consequence — two alert tiers, mapped to the state machine:**

| Tier | Fires on | Lead time | Confidence |
| --- | --- | --- | --- |
| **1 · Stirring** | accumulation footprint (inverted gates: low buyers + buy skew + absorption + micro-ATR blip) | minutes–hours | low — "someone might be gathering this" |
| **2 · Confirmed revival** | the full trigger+gates | ~0 min | high |

Tier 1 is the answer to the measured negative-lead problem: precision gates
inherently confirm rather than predict; the accumulation tier predicts.

## Labeled examples (golden set — grow this list)

- **PIPECAT** — Robinhood Chain, `0x9d98f99b0b6b2b7f99ab8bc187e1c59793eccb2c`,
  2026-08-03/04 (GMGN 30s chart): dormant ~27K MC → small wallet-cluster buys
  with a barely-visible ATR uptick (~03:15) → migration marker → ignition to
  ~$1.0M MC in ~15 min → distribution back to ~170K. Textbook archetype B
  feeding archetype A.

## State machine (anti-spam + cost gate)

```
Dormant → [Accumulating] → Watching → Reviving → Alerted → Cooling → Dormant
```

`Accumulating` is a tagged sub-state of Dormant entered on the Tier-1
footprint: it promotes candle resolution early and may emit a Tier-1 alert,
but does not touch the Tier-2 path.

- Promotion to Watching on a soft trigger; full gates fire alerts.
- **Hysteresis**: exit thresholds sit below entry thresholds.
- **Cooling** enforces a cooldown before the same token can re-alert.
- State also selects candle resolution (see above).

## Universe: two tiers

- **Tier A (hot):** tokens surfaced by OCT — contract-feed detections, FOMO-held
  tokens, manual watches. Full treatment from the start.
- **Tier B (broad):** every pool above a liquidity floor on Solana + BNB. Coarse
  1m aggregation only; auto-promote to Tier A on soft trigger.

Tier B preserves the premise (catch revivals *before* anyone talks); Tier A is
where the OCT integration pays off — a feed call plus an on-chain revival on the
same token is a new convergence dimension.

## Service shape & OCT integration

- A separate always-on worker (**`revival-worker`**, fomo-worker pattern: VPS,
  stateful, survives redeploys) — *not* inside the Railway request/response
  backend. The backend consumes its output.
- Revival is a **new independent signal** alongside convergence / FOMO buys /
  missed-runner, delivered through OCT's existing alert plumbing (WS broadcast,
  Pushover, Discord bot DM). Per ADR-004: signals stay independent at the
  source; cross only at the convergence layer. Never fuse revival *into* the
  social signals.

## Backtesting: same code path

The replay harness feeds historical candles (built from stored raw swaps, or
REST-backfilled history) through the **same** candle→indicator→detector code
that runs live. No parallel backtest implementation — divergence between
backtest and prod code is the classic quant-infra failure and the main reason we
store raw events at all. Output: precision/recall per gate combination against
labeled revivals.

## Constraints (hold the line)

- No polling APIs for live prices; indicators from raw events only.
- Chain-specific ingest, chain-agnostic analytics.
- Seconds-level latency; boring infra; predictable monthly cost.
- Design for millions of events and more chains later (base/arbitrum/etc. are
  already indexed on Pinax when we want them).
- Alert quality over alert volume.

## Phase 2 (roadmap, explicitly out of spike scope)

- **Bundling / wallet-graph detection** — assess whether the accumulation
  cluster is one operator: same-block/slot clustered buys, wallets funded from
  a common source (requires a **native-transfer stream**, not just swaps),
  fresh-wallet age (first-seen), an insider-cluster score attached to Tier-1
  alerts. High value ("is this a team loading up, or organic?"), real data
  cost — parked to phase 2 by explicit decision.
- **Learning evolution** — once the platform accumulates tape: extract every
  dormancy episode, label outcomes per C0, snapshot decision-time features,
  train gradient-boosted trees. Evaluation law: **out-of-time splits only**
  (memecoin meta is non-stationary), precision@k not accuracy, every feature
  computable at alert time. SHAP/feature importances answer "which pattern
  dominates"; cluster pre-revival windows to discover archetypes beyond A/B.
  The hand gates remain the benchmark to beat and stay as hard vetoes
  (e.g. liquidity draining = never alert) even after a model wins. Substreams
  historical replay builds the training corpus with the same normalizer —
  the training set is a byproduct of infrastructure we're building anyway.

## Open questions

1. **Holder count & market cap** are *not derivable from swaps* (need supply +
   balance indexing). Pinax REST has balances/holders endpoints — low-frequency
   polling of a slow-moving stat may be an acceptable exception to the no-poll
   rule. Decide when wiring market stats; don't block the spike on it.
2. **BNB DEX coverage** — enumerate which AMMs Pinax's `bsc` dexes package
   covers (PancakeSwap v2/v3 at minimum) during the spike.
3. **Substreams package selection** — identify the exact svm/evm DEX packages
   and their message schemas (spike task C1; `dex-swaps-v0.5.2.spkg` already
   fetched for Solana).
4. **Robinhood adapter specifics** — which AMMs/launchpads to decode, WSS vs
   polled `eth_getLogs` cadence, and a provider choice (public RPC vs
   QuickNode/Chainstack/Alchemy) once the spike graduates.
5. **Tier-1 threshold discipline** — the accumulation footprint is subtle;
   backtest it with the same rigor as Tier-2 before ever alerting on it
   (an over-eager Tier 1 destroys trust in the whole system).
