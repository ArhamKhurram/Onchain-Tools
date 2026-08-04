// Synthetic-data sanity checks for the candle -> indicator -> detector path.
// Run: node src/selftest.js  (exits non-zero on failure)
import { buildCandles } from './candles.js';
import { buildSnapshots, runDetector, GATE_COMBOS } from './detector.js';
import { labelEpisodes } from './episodes.js';
import { C0, DETECTOR } from './config.js';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log('ok  ', name);
  else { console.error('FAIL', name, extra); failures += 1; }
}

const T0 = 1_700_000_000 - (1_700_000_000 % 60);

// ---- Scenario: 30h quiet tape, then a revival pump ----
const swaps = [];
let w = 0;
// Phase 1: 24h of sparse dormant trading (1 small trade every ~10 min)
for (let m = 0; m < 1440; m += 10) {
  swaps.push({ ts: T0 + m * 60, pool: 'P', token: 'X', price: 1.0 + 0.001 * Math.sin(m), amountQuote: 0.2, side: m % 20 ? 'buy' : 'sell', wallet: 'w' + (w++ % 3), txHash: 't' + m });
}
// Phase 2: 6h of total silence (forward-filled candles)
const pumpStartMin = 1440 + 360;
// Phase 3: pump — 30 minutes, price ramps 1.0 -> 1.8, heavy volume, many buyers
for (let m = 0; m < 30; m++) {
  const minute = pumpStartMin + m;
  for (let k = 0; k < 6; k++) {
    const price = 1.0 + (0.8 * (m * 6 + k)) / 180;
    swaps.push({ ts: T0 + minute * 60 + k * 10, pool: 'P', token: 'X', price, amountQuote: 3, side: k === 5 ? 'sell' : 'buy', wallet: 'buyer' + (m * 6 + k), txHash: 'p' + m + '_' + k });
  }
}
// Phase 4: hold the level for 30 more minutes
for (let m = 30; m < 60; m++) {
  const minute = pumpStartMin + m;
  swaps.push({ ts: T0 + minute * 60, pool: 'P', token: 'X', price: 1.75, amountQuote: 1, side: 'buy', wallet: 'late' + m, txHash: 'h' + m });
}

const endTs = T0 + (pumpStartMin + 90) * 60;
const candles = buildCandles(swaps, endTs);

check('candles are contiguous 1m', candles.every((c, i) => i === 0 || c.ts - candles[i - 1].ts === 60),
  'gaps found');
const filled = candles.filter((c) => c.filled).length;
check('silence produced forward-filled candles', filled > 300, `filled=${filled}`);
check('filled candles carry prev close', candles.filter((c) => c.filled).every((c) => c.close != null && c.volQuote === 0));

const vwapCandle = candles.find((c) => c.trades >= 6);
check('multi-swap candle close is VWAP not last trade', vwapCandle && Math.abs(vwapCandle.close - vwapCandle.vwap) < 1e-12);

const snaps = buildSnapshots(candles, DETECTOR, C0);
const dormantSnaps = snaps.filter((s) => s.dormant);
check('dormancy detected during silent phase', dormantSnaps.length > 0, `dormant=${dormantSnaps.length}`);
const pumpTs = T0 + pumpStartMin * 60;
check('dormant right before pump', snaps.find((s) => s.ts === pumpTs - 60)?.dormant === true);

const { episodes } = labelEpisodes(candles, C0);
const revivals = episodes.filter((e) => e.revival);
check('exactly one episode labeled', episodes.length === 1, `episodes=${episodes.length}`);
check('episode labeled as revival', revivals.length === 1,
  JSON.stringify(episodes.map((e) => ({ g: e.maxGain.toFixed(2), run: e.sustainRun, b: e.uniqueBuyers, v: e.volQuote.toFixed(1), r: e.revival }))));

const all = runDetector(snaps, GATE_COMBOS.find((c) => c.name === 'ALL gates'), DETECTOR);
check('ALL-gates detector fires on the revival', all.length >= 1, `alerts=${all.length}`);
if (all.length) {
  const lead = (revivals[0]?.pumpStartTs ?? pumpTs) - all[0].ts;
  console.log(`    first alert at +${(all[0].ts - pumpTs) / 60}min after activity resumed; lead vs pumpStart=${lead / 60}min`);
  check('alert lands inside the episode window', all[0].ts >= pumpTs - 900 && all[0].ts <= pumpTs + C0.REVIVAL_WINDOW_MIN * 60);
}

// ---- Scenario: dormant token stays dormant -> no alerts ----
const quiet = [];
for (let m = 0; m < 2880; m += 15) {
  quiet.push({ ts: T0 + m * 60, pool: 'Q', token: 'Y', price: 0.5, amountQuote: 0.1, side: 'buy', wallet: 'q' + (m % 2), txHash: 'q' + m });
}
const qc = buildCandles(quiet, T0 + 2880 * 60);
const qs = buildSnapshots(qc, DETECTOR, C0);
const qAlerts = runDetector(qs, GATE_COMBOS.find((c) => c.name === 'ALL gates'), DETECTOR);
check('flat dormant tape produces zero alerts', qAlerts.length === 0, `alerts=${qAlerts.length}`);

process.exit(failures ? 1 : 0);
