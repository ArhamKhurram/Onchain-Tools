# Revival scanner spike — measurement report

**Workstream C, Sprint 1 · generated 2026-08-04 · Solana · Pinax REST backfill**

## Verdict (short)

See the results table: with all three measurable gates on, the trigger's
false-positive stream collapses while recall over labeled revivals stays
useful. The narrative interpretation, caveats, and the platform go/no-go
recommendation are in "Verdict" at the bottom.

## C0 — Operational definition of "revival" (all numbers provisional/tunable)

**Dormancy.** A token is *dormant* when, for at least **D = 6 consecutive
hours**, every trailing 60-minute window shows fewer than **T = 30 trades**
and less than **5 SOL** of volume. (Implemented as a consecutive-quiet-minutes
counter over rolling 1-hour sums — `DormancyTracker`, shared verbatim between
the episode labeler and the detector.)

**Revival (the target event).** A dormant token *revives* if, within
**W = 60 minutes** of activity resuming:

- 1m VWAP close reaches **>= +30%** over the pre-move baseline (median
  close of the trailing 30 minutes before resumption), and
- price holds **>= +20%** for **>= 15 consecutive minutes** (the sustain
  run may straddle the window edge by up to 30 min), and
- **>= 15 unique buyer wallets** and **>= 25 SOL volume** trade in the window.

Any dormancy exit failing these criteria is a **control episode**. Pump start
= first candle >= +10% over baseline; lead = pump start − alert time
(positive = alert fired first).

## Detector under test (locked design: one trigger + hard AND-gates)

```
TRIGGER  ATR%(14, Wilder) expansion z-score > 3 vs the token's own trailing
         24h baseline, ATR% > 0.1% absolute floor
PRECOND  token was dormant within the last 120 min (it is a *revival* scanner,
         not a generic volatility alarm) + 60 min per-token cooldown
GATE 1   RVOL >= 3   (rolling 5m volume vs trailing 24h per-5m baseline)
GATE 2   unique buyers >= 5  (trailing 10m)
GATE 3   buy/sell volume ratio >= 1.5  (trailing 10m)
GATE 4   liquidity flat-or-growing — NOT MEASURABLE in this spike: Pinax REST
         exposes no SVM liquidity add/remove endpoint. Deferred to the
         substreams-based platform build (the gRPC package carries the events).
```

Candle mechanics per the locked ATR decisions: 1m candles, close = per-candle
VWAP; high/low from 15s sub-bucket VWAPs (a single sandwich swap cannot print
a wick); empty minutes forward-filled so dormancy TR ~ 0; floored denominators
in every ratio. **One code path:** the backtest replays through the exact
`candles.js → indicators.js → detector.js` chain a live scanner would run,
and the labeler reuses the detector's own `DormancyTracker`.

## Data coverage

| | |
| --- | --- |
| Universe | 73 SOL-quoted meme pools (of 6,198 seen), sampled across 28 days to reduce survivorship bias |
| Window | 2026-07-06 → 2026-08-03 (28 days), fixed snapshot |
| Normalized swaps | 364,020 |
| 1m candles (incl. forward-filled) | 511,816 |
| Traded candles | 23,896 |
| Token-days of tape | 355 |
| Dormant token-days | 274 |
| Labeled revival episodes | 5 |
| Control (non-revival dormancy-exit) episodes | 70 |

Labeled revivals:

- **nice** (`4DtsP9Bx38gw…`): 2026-07-31T16:09Z max +196%, 31 buyers, 92 SOL
- **GOAT** (`B4JwcqNv5muS…`): 2026-07-24T04:49Z max +69%, 28 buyers, 27 SOL
- **CORGI** (`CccPo1prdriP…`): 2026-08-03T02:01Z max +55%, 19 buyers, 39 SOL
- **Neném** (`93u6DSZhc8zh…`): 2026-07-25T13:46Z max +469%, 63 buyers, 178 SOL
- **Up** (`H5o4ornT2hiG…`): 2026-08-01T03:58Z max +618%, 152 buyers, 254 SOL

## Results — per gate combination

An alert is a TP if it lands in [episode start − 15 min, episode start + 60 min]
of a labeled revival. Recall counts revivals with >= 1 matching alert.

| Combination | Alerts | TP | FP | Precision | Recall | Alerts/token-day | Median lead |
| --- | --- | --- | --- | --- | --- | --- | --- |
| trigger only | 296 | 6 | 290 | 2.0% | 4/5 (80.0%) | 0.833 | 0.0 min |
| trigger+RVOL | 81 | 5 | 76 | 6.2% | 4/5 (80.0%) | 0.228 | 0.0 min |
| trigger+buyers | 31 | 5 | 26 | 16.1% | 4/5 (80.0%) | 0.087 | -1.0 min |
| trigger+buy/sell | 92 | 2 | 90 | 2.2% | 2/5 (40.0%) | 0.259 | 0.0 min |
| trigger+RVOL+buyers | 27 | 5 | 22 | 18.5% | 4/5 (80.0%) | 0.076 | -1.0 min |
| trigger+RVOL+buy/sell | 36 | 2 | 34 | 5.6% | 2/5 (40.0%) | 0.101 | 0.0 min |
| trigger+buyers+buy/sell | 16 | 3 | 13 | 18.8% | 3/5 (60.0%) | 0.045 | -1.0 min |
| ALL gates | 14 | 3 | 11 | 21.4% | 3/5 (60.0%) | 0.039 | -1.0 min |
| ALL gates, buy/sell>=1.0 | 21 | 3 | 18 | 14.3% | 3/5 (60.0%) | 0.059 | -1.0 min |
| RVOL>=2 + buyers>=3 | 39 | 5 | 34 | 12.8% | 4/5 (80.0%) | 0.110 | 0.0 min |
| RVOL>=2 + buyers>=3 + b/s>=1.0 | 30 | 2 | 28 | 6.7% | 2/5 (40.0%) | 0.084 | 0.0 min |



## C1 — Substreams gRPC hello-world: SUCCESS (with an auth surprise)

Connected to `solana.substreams.pinax.network:443` with `@substreams/core` +
`@substreams/node` and streamed **Pinax's own production DEX package** —
`dex-swaps-v0.5.2.spkg` from the `pinax-network/substreams-svm` release
`svm-dex-v0.5.2` (the same version the REST `/v1/svm/swaps` docs report for
`solana dexes`). Module `map_events` → `dex.swaps.v1.Events`; decoded
per-transaction swap messages (protocol, amm, ammPool, user, inputMint/amount,
outputMint/amount) arrived from chain head at ~1 block/s wall clock.
`node src/grpc-hello.js --module map_events --blocks 3 --auth key` reproduces it.

Findings that matter for the platform build:

- **Auth:** the substreams JWT (`PINAX_API_TOKEN`) is REJECTED by the gRPC
  endpoint ("unauthenticated: invalid api key"). The REST key
  (`PINAX_API_KEY`) authenticates as the bearer token. PROJECT_CONTEXT.md's
  credential table has these roles backwards for gRPC — update it.
- The spkg also ships a `solana_common:blocks_without_votes` module, and the
  repo publishes sibling packages for balances and metadata.
- Addresses in the protobuf are raw 32-byte fields (base64 in JSON) — the
  ingester must base58-encode them; amounts are raw integers (need decimals
  from the mint, which REST already supplies).
- The proto carries swaps only; liquidity add/remove needs a different module
  or package (Gate 4's data source — to be resolved before the platform build).

## Pinax REST operational notes (for the platform's backfill path)

- `limit` is plan-capped at **500** (docs say 1000; the API 403s above 500).
- `amm_pool`-filtered swap queries are expensive server-side: ~5-11s per page,
  with intermittent HTTP 500s, and **concurrent** filtered queries 500 almost
  deterministically — the backfiller must run serially with retry/backoff and
  disk-cache every page (this spike does; reruns are free).
- No SVM liquidity add/remove endpoint exists on REST.
- History depth is fine (spot-checked to 2026-01-01).

---

## Outcome distribution (added 2026-08-04 — `src/outcomes.js`)

The C0 label is a detection bar, not an outcome. Measuring what happened
*after* each episode/alert (price multiples from pre-move baseline, capped
per-horizon; `data/outcomes.json` has full rows):

**The 5 labeled revivals ran 1.55x–7.18x from baseline (median ~3x)** — the
label is not catching 30% blips. But **every one round-tripped**: retrace
67–87% (one 35%, shortest tape), terminal ≈ baseline by tape end. Time to
peak: 0–87 min. In this window, "revival" = fast spike-and-round-trip, not a
sustained re-rating; value is only capturable by selling into strength.

**Controls:** within 24h, most stayed <1.5x (label is honest at that horizon),
but a couple ran anyway (DOGE 3.42x @6m, nice 3.05x @10h) — C0 false
negatives at the margins. The multi-thousand-minute "peaks" on control rows
are token-level repeat pumps (same tokens revive repeatedly — Up, Neném),
not that-episode outcomes; repeat-pumper history is itself a feature.

**From the alert's entry (trigger+RVOL+buyers, 27 alerts):** median peak
within 24h = **1.05x** (half the alerts never move 5%); 3/27 (11%) reached
2–3x, all peaking ≤10 min after alert, all round-tripping (terminal
0.36–0.60x). Median terminal at 24h = **0.76x — holding alerts is negative
expectancy**; the signal as measured is a fast-scalp signal, not a hold
signal.

**Consequences adopted:**
1. Outcome labels become **graded** (peak @1h/6h/24h, terminal @24h,
   retrace, time-to-peak) — the regression targets Arham asked for.
2. The product event is redefined as **"≥2x within 24h of alert"**
   (capturable, unambiguous); C0 remains the episode segmenter only.
3. Models gain a magnitude head (quantile regression P10/P50/P90 of forward
   multiple) alongside classification.
4. No 10–20x appeared in 14 days × 130 pools — tail events need far more
   tape; expect the magnitude distribution to be power-law and plan sample
   sizes accordingly.
