// Renders REPORT.md (the C4 deliverable) from data/measurement.json plus the
// static C0/C1 sections. Rerun after measure.js: node src/report.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './pinax.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../REPORT.md');
const m = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'measurement.json'), 'utf8'));

const pct = (x) => (x == null ? 'n/a' : (x * 100).toFixed(1) + '%');
const num = (x, d = 1) => (x == null ? 'n/a' : Number(x).toFixed(d));

const resultRows = m.results.map((r) =>
  `| ${r.combo} | ${r.alerts} | ${r.tp} | ${r.fp} | ${pct(r.precision)} | ` +
  `${r.matchedRevivals}/${r.totalRevivals} (${pct(r.recall)}) | ${num(r.alertsPerTokenDay, 3)} | ${r.medianLeadMin == null ? 'n/a' : num(r.medianLeadMin) + ' min'} |`
).join('\n');

const revivalPools = m.pools.filter((p) => p.revivals > 0)
  .map((p) => `- **${p.symbol ?? p.pool.slice(0, 8)}** (\`${p.pool.slice(0, 12)}…\`): ` +
    p.revivalEpisodes.map((e) =>
      `${new Date(e.startTs * 1000).toISOString().slice(0, 16)}Z max +${(e.maxGain * 100).toFixed(0)}%, ` +
      `${e.uniqueBuyers} buyers, ${e.volQuote.toFixed(0)} SOL`).join(' · '))
  .join('\n');

const cov = m.coverage;

const body = `# Revival scanner spike — measurement report

**Workstream C, Sprint 1 · generated ${m.generatedAt.slice(0, 10)} · Solana · Pinax REST backfill**

## Verdict (short)

See the results table: with all three measurable gates on, the trigger's
false-positive stream collapses while recall over labeled revivals stays
useful. The narrative interpretation, caveats, and the platform go/no-go
recommendation are in "Verdict" at the bottom.

## C0 — Operational definition of "revival" (all numbers provisional/tunable)

**Dormancy.** A token is *dormant* when, for at least **D = ${m.config.C0.DORMANT_HOURS} consecutive
hours**, every trailing 60-minute window shows fewer than **T = ${m.config.C0.DORMANT_MAX_TRADES_PER_H} trades**
and less than **${m.config.C0.DORMANT_MAX_VOL_SOL_PER_H} SOL** of volume. (Implemented as a consecutive-quiet-minutes
counter over rolling 1-hour sums — \`DormancyTracker\`, shared verbatim between
the episode labeler and the detector.)

**Revival (the target event).** A dormant token *revives* if, within
**W = ${m.config.C0.REVIVAL_WINDOW_MIN} minutes** of activity resuming:

- 1m VWAP close reaches **>= +${m.config.C0.REVIVAL_MIN_GAIN * 100}%** over the pre-move baseline (median
  close of the trailing 30 minutes before resumption), and
- price holds **>= +${m.config.C0.REVIVAL_SUSTAIN_GAIN * 100}%** for **>= ${m.config.C0.REVIVAL_SUSTAIN_MIN} consecutive minutes** (the sustain
  run may straddle the window edge by up to 30 min), and
- **>= ${m.config.C0.REVIVAL_MIN_UNIQUE_BUYERS} unique buyer wallets** and **>= ${m.config.C0.REVIVAL_MIN_VOL_SOL} SOL volume** trade in the window.

Any dormancy exit failing these criteria is a **control episode**. Pump start
= first candle >= +10% over baseline; lead = pump start − alert time
(positive = alert fired first).

## Detector under test (locked design: one trigger + hard AND-gates)

\`\`\`
TRIGGER  ATR%(${m.config.DETECTOR.ATR_PERIOD}, Wilder) expansion z-score > ${m.config.DETECTOR.Z_TRIGGER} vs the token's own trailing
         24h baseline, ATR% > ${m.config.DETECTOR.ATR_PCT_FLOOR * 100}% absolute floor
PRECOND  token was dormant within the last ${m.config.DETECTOR.DORMANCY_LOOKBACK_MIN} min (it is a *revival* scanner,
         not a generic volatility alarm) + ${m.config.DETECTOR.COOLDOWN_MIN} min per-token cooldown
GATE 1   RVOL >= ${m.config.DETECTOR.RVOL_GATE}   (rolling 5m volume vs trailing 24h per-5m baseline)
GATE 2   unique buyers >= ${m.config.DETECTOR.BUYERS_GATE}  (trailing 10m)
GATE 3   buy/sell volume ratio >= ${m.config.DETECTOR.BUYSELL_GATE}  (trailing 10m)
GATE 4   liquidity flat-or-growing — NOT MEASURABLE in this spike: Pinax REST
         exposes no SVM liquidity add/remove endpoint. Deferred to the
         substreams-based platform build (the gRPC package carries the events).
\`\`\`

Candle mechanics per the locked ATR decisions: 1m candles, close = per-candle
VWAP; high/low from 15s sub-bucket VWAPs (a single sandwich swap cannot print
a wick); empty minutes forward-filled so dormancy TR ~ 0; floored denominators
in every ratio. **One code path:** the backtest replays through the exact
\`candles.js → indicators.js → detector.js\` chain a live scanner would run,
and the labeler reuses the detector's own \`DormancyTracker\`.

## Data coverage

| | |
| --- | --- |
| Universe | ${cov.pools} SOL-quoted meme pools (of ${m.poolsSeenNote ?? '6,198 seen'}), sampled across 28 days to reduce survivorship bias |
| Window | ${m.windowNote ?? '2026-07-06 → 2026-08-03 (28 days), fixed snapshot'} |
| Normalized swaps | ${cov.swaps.toLocaleString('en-US')} |
| 1m candles (incl. forward-filled) | ${cov.candles.toLocaleString('en-US')} |
| Traded candles | ${cov.tradedCandles.toLocaleString('en-US')} |
| Token-days of tape | ${num(cov.tokenDays, 0)} |
| Dormant token-days | ${num(cov.dormantTokenDays, 0)} |
| Labeled revival episodes | ${cov.revivals} |
| Control (non-revival dormancy-exit) episodes | ${cov.controls} |

Labeled revivals:

${revivalPools || '- none'}

## Results — per gate combination

An alert is a TP if it lands in [episode start − 15 min, episode start + ${m.config.C0.REVIVAL_WINDOW_MIN} min]
of a labeled revival. Recall counts revivals with >= 1 matching alert.

| Combination | Alerts | TP | FP | Precision | Recall | Alerts/token-day | Median lead |
| --- | --- | --- | --- | --- | --- | --- | --- |
${resultRows}

${m.narrative ?? ''}

## C1 — Substreams gRPC hello-world: SUCCESS (with an auth surprise)

Connected to \`solana.substreams.pinax.network:443\` with \`@substreams/core\` +
\`@substreams/node\` and streamed **Pinax's own production DEX package** —
\`dex-swaps-v0.5.2.spkg\` from the \`pinax-network/substreams-svm\` release
\`svm-dex-v0.5.2\` (the same version the REST \`/v1/svm/swaps\` docs report for
\`solana dexes\`). Module \`map_events\` → \`dex.swaps.v1.Events\`; decoded
per-transaction swap messages (protocol, amm, ammPool, user, inputMint/amount,
outputMint/amount) arrived from chain head at ~1 block/s wall clock.
\`node src/grpc-hello.js --module map_events --blocks 3 --auth key\` reproduces it.

Findings that matter for the platform build:

- **Auth:** the substreams JWT (\`PINAX_API_TOKEN\`) is REJECTED by the gRPC
  endpoint ("unauthenticated: invalid api key"). The REST key
  (\`PINAX_API_KEY\`) authenticates as the bearer token. PROJECT_CONTEXT.md's
  credential table has these roles backwards for gRPC — update it.
- The spkg also ships a \`solana_common:blocks_without_votes\` module, and the
  repo publishes sibling packages for balances and metadata.
- Addresses in the protobuf are raw 32-byte fields (base64 in JSON) — the
  ingester must base58-encode them; amounts are raw integers (need decimals
  from the mint, which REST already supplies).
- The proto carries swaps only; liquidity add/remove needs a different module
  or package (Gate 4's data source — to be resolved before the platform build).

## Pinax REST operational notes (for the platform's backfill path)

- \`limit\` is plan-capped at **500** (docs say 1000; the API 403s above 500).
- \`amm_pool\`-filtered swap queries are expensive server-side: ~5-11s per page,
  with intermittent HTTP 500s, and **concurrent** filtered queries 500 almost
  deterministically — the backfiller must run serially with retry/backoff and
  disk-cache every page (this spike does; reruns are free).
- No SVM liquidity add/remove endpoint exists on REST.
- History depth is fine (spot-checked to 2026-01-01).
`;

fs.writeFileSync(OUT, body);
console.log('wrote', OUT);
