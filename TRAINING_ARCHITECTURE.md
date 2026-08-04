# Revival Scanner — training & signal architecture

**Companion to `PROJECT_CONTEXT.md`** (which owns ingestion/storage/detection).
This doc owns: how the system learns, what signals feed it, how weights come to
exist, and how attention — the market's and yours — is modeled.
**Last updated:** 2026-08-04

---

## 1 · The learning loop

```
                     live detectors (population, shadow + promoted)
                                      │ every would-be alert
                                      ▼
                        ┌── Daily Signal Inventory ──┐
                        │  every signal, both tiers,  │
                        │  incl. below-threshold ones │
                        └──────┬───────────┬─────────┘
                    auto label │           │ human rating (≤24h)
             (objective: what  │           │ (subjective: "was this
              did price/supply │           │  worth my attention?")
              actually do)     ▼           ▼
                        ┌── Labeled corpus ──┐
                        └────────┬───────────┘
                                 ▼
                 retrain / evolve  →  shadow-test  →  promote
```

Two label tracks, deliberately separate:

- **Outcome labels (automatic, objective).** For every logged signal: did the
  token revive per the C0 definition? Peak multiple? Time-to-peak? Did it rug
  (LP pulled / −90% with no recovery)? No human needed; computed by replaying
  the tape 24–48h later. This trains the *outcome model*.
- **Attention ratings (manual, ≤24h).** The operator rates each day's
  inventory: `worth-it / meh / noise / rug-bait`. This trains the *attention
  model* — because a signal can be "correct" (it pumped 40%) and still not
  worth a ping, or technically wrong but exactly the kind of thing you want
  shown. Outcome labels can't capture taste; ratings can. Rating is optional
  per day — unrated signals still carry outcome labels, so skipped days cost
  nothing.

Everything below alert threshold is logged too (shadow logging). Attention is
filtered; data never is.

## 2 · Signal catalog

Weights are **learned, not hand-set** — the v0 hand-gate thresholds in
`PROJECT_CONTEXT.md`/`config.js` are the bootstrap, not the destination.
Availability: ✅ spike-now (from swaps alone) · 🔷 platform (needs
transfers/balances stream) · 🔶 phase-2 (needs funding-graph).

**Volatility / price**
- ATR% (Wilder 14) and its expansion z-score vs own trailing baseline ✅
- Price displacement per unit volume ("absorption": volume high, movement low) ✅
- Distance from dormancy baseline price ✅

**Volume / flow**
- RVOL vs trailing baseline ✅ · buy/sell volume ratio ✅ · trade count ✅
- Net flow trajectory (rising buy-side persistence over hours) ✅

**Wallet / supply (the Rickey block)**
- Unique buyers/sellers per window ✅
- **Cluster retention:** per-wallet cumulative net position from swaps — have
  the accumulating wallets *held* (not sold for N hours)? ✅
- **Supply share gathered:** cluster net buys ÷ token supply — the ">0.5% of
  supply" heuristic. Needs supply (one-time metadata fetch) ✅
- Returning buyers (seen in prior episodes on this token) ✅
- Wallet age / first-seen (from our own history as it accumulates) 🔷
- Holder count & concentration trajectory 🔷

**Rug/bundle discriminators (adverse-selection block — see §5)**
- Cluster hold-duration (retention above) ✅
- LP events: liquidity added/removed during accumulation 🔷 (partial ✅ where
  the swap stream carries mint/burn)
- Creator/deployer wallet behavior (did dev wallets feed the cluster?) 🔶
- Same-block/slot clustered buys; common funding source; fresh-wallet ratio 🔶

**Attention (the OCT-native block — no competitor has this)**
- Mentions of this CA in the operator's Discord/Telegram feeds; which callers;
  their caller-quality bands ✅ (already in OCT)
- Tracked FOMO traders holding/buying it ✅ (already in OCT)
- Mention acceleration (15m/1h windows — Radar already computes this) ✅
- Cross-signal: on-chain stirring **before** any social mention = the highest-
  value state (you're earlier than attention itself)

**Context**
- Token age, prior revival count, time-of-day/day-of-week ✅
- Launchpad→AMM migration proximity (ignition clusters around it) 🔷

## 3 · Models — what learns, and how

**v0 (now): hand gates.** The AND-gates with provisional thresholds. They are
the benchmark every learned model must beat, and several stay as **immutable
vetoes** forever (liquidity actively draining ⇒ never alert, whatever a model
says).

**v1: gradient-boosted trees (scoring).** Once the corpus holds thousands of
episodes: features at decision time → P(revival) and P(worth-attention) as two
heads. GBTs because the data is tabular, they train in minutes, and SHAP
values show exactly which signals carry weight — the "what are the weights"
question gets a live, inspectable answer, not a config file.

**Considered and rejected/deferred (2026-08-04, don't re-propose):**
- **KNN** — rejected: breaks at ~1:1000 imbalance, uncalibrated, distance
  meaningless over 30+ mixed-scale features, matches to stale regimes.
- **Deep learning** — deferred, not rejected: trees beat NNs on engineered
  tabular data at our scale. Later slot: a small 1D-CNN/transformer encoding
  the raw pre-episode candle *shape* as a feature into the GBT (v3, needs
  10k+ episodes).
- **RL** — rejected for detection: our alerts don't act on the environment;
  this is classification, and RL buys sample-inefficiency for nothing. Only
  relevant if execution is ever automated (out of scope). The Tier-1 ranking
  is deliberately NOT a bandit either: shadow logging records outcomes for
  ALL candidates (full feedback), so supervised learning suffices.
- **Novel architectures from scratch** — no. Library GBTs trained from
  scratch on our own corpus; the data is the moat, not the architecture.
- Deployment shape: train offline in Python (LightGBM/XGBoost + SHAP,
  calibrated probabilities), export the artifact, score in `revival-worker`
  at alert time; retrain on cadence with out-of-time validation.

**The exploration layer: a genetic population of detectors.** The GA instinct
is right for this system, applied to the right object. Not evolving the
*scorer* (GBT does that better) — evolving **detector configurations**: each
genome = a full gate/threshold/window configuration. Gates are discrete and
non-differentiable, which is exactly where evolutionary search beats gradient
methods. Refinement: use **quality-diversity** (MAP-Elites style) rather than
a plain GA — instead of converging on one champion, it maintains an archive of
elites *across behavior dimensions* (lead time × alert frequency × precision).
The result is a **portfolio of diverse hunters**: one elite that's early-and-
noisy, one that's precise-and-late, one tuned to micro-caps, one to
migrations. Diversity is structural, not bolted on — this is the principled
version of "randomness catches the non-obvious."

- Fitness = replay performance on the corpus **plus** forward shadow
  performance (weighted toward forward; replay overfits).
- The whole population runs in **shadow** on live data, logging to the
  inventory. Only elites that beat the incumbent out-of-time for N consecutive
  weeks get promoted to alerting.
- Mutation/crossover on thresholds, window sizes, gate on/off masks, and
  feature choices within a bounded, auditable genome.

## 4 · The attention economy layer

Two meanings, both load-bearing:

**Market attention as signal.** Memecoins run on attention flows; OCT already
owns attention sensors (feed mentions, caller quality, FOMO buys). The revival
scanner is the *on-chain* sensor. The killer sequence is temporal:
`quiet accumulation → [stirring alert] → attention arrives (calls/pages/FOMO)
→ ignition`. Catching the first step means being positioned before attention —
that's the whole edge. Cross-signal timing (on-chain-first vs social-first) is
itself a feature and a display dimension.

**Operator attention as budget.** DECIDED 2026-08-04: **both tiers push-
notify.** Delivery discipline protects trust:

| Tier | Delivery | Budget |
| --- | --- | --- |
| 2 · Confirmed | push, always | effectively uncapped (rare by construction) |
| 1 · Stirring | push, **ranked top-N/day** + full ranked list in console | N set by operator; tune from inventory ratings |

The ranked-budget mechanism replaces a hard threshold: quiet days surface
weirder candidates (exploration for free), hot days only the strongest. The
attention model (human-ratings head) learns the operator's taste and improves
the ranking — the rating loop literally teaches the system what deserves your
attention.

## 5 · Adverse selection: accumulation vs bundle-rug setup

The Tier-1 footprint (few wallets quietly gathering supply) is **also the rug
setup footprint** — a bundler loading before a pump-and-dump looks identical
at swap level. This is the noise Rickey's question targets, and it can't be
hand-waved:

- **Primary discriminator (computable now): retention.** Rug bundles
  distribute fast; genuine accumulation holds. Cluster hold-duration + supply
  share (>0.5% held for hours, not minutes) separates most of them — and both
  come from swaps we already have.
- **Liquidity behavior:** accumulation into thin, unlocked LP is rug-shaped;
  LP adds during accumulation are bullish-shaped.
- **Funding graph (phase-2):** wallets funded from one source, same-block
  bundles, fresh-wallet ratio → an insider-cluster score attached to Tier-1
  alerts rather than a binary block — the operator sees "cluster looks
  coordinated (0.8)" and decides.
- Residual honesty: some sophisticated setups will pass every filter. The
  outcome labels catch them after the fact and the models learn; the veto
  gates cap the damage. Zero-rug-alerts is not an achievable spec; falling
  rug-rate per retrain cycle is.

## 6 · Evaluation law (restated from PROJECT_CONTEXT.md, applies to all of the above)

1. **Out-of-time splits only.** Memecoin meta is non-stationary; random splits
   produce beautiful fakes.
2. Metrics: precision@k, recall on labeled revivals, alerts/day, median lead
   time, rug-rate among alerts. Never bare accuracy.
3. Every feature computable at alert time. One future-peeking feature poisons
   the corpus.
4. Shadow before promote; incumbent beaten for N weeks before swap.
5. Vetoes are not learnable and not removable by any model.

## 7 · Phasing

| Phase | What runs | Needs |
| --- | --- | --- |
| Spike (now) | hand gates, replay measurement, retention/supply-share features | swaps only ✅ |
| Platform v1 | live shadow logging, signal inventory + rating UI, both-tier alerts | streaming spine + inventory store |
| Learn v1 | outcome labels → GBT scorer; ranked Tier-1 budget | months of tape |
| Learn v2 | QD/genetic detector population in shadow; attention-model head from ratings | inventory history |
| Phase 2 | funding-graph, bundle detection, holder streams, insider score | transfers/balances ingestion |
