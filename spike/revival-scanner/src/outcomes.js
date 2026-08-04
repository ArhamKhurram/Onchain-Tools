// Outcome analysis: what actually happens AFTER a labeled episode or an alert?
//
// The C0 label is a detection threshold (+30% spike, +20% sustained 15m) — it
// says nothing about whether the move was a dead-cat blip or a 10x run. This
// script measures the forward outcome distribution, from each episode's
// pre-move baseline and from each alert's entry price:
//   - peak multiple within 1h / 6h / 24h / end-of-tape
//   - terminal multiple at those horizons (did it hold, or round-trip?)
//   - time-to-peak, and max drawdown from the peak
//
// Multiples are price ratios (SOL-denominated pool price), so they compose
// across tokens. Episodes near the tape edge report how much forward window
// they actually had.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './pinax.js';
import { buildCandles } from './candles.js';
import { buildSnapshots, runDetector, GATE_COMBOS } from './detector.js';
import { labelEpisodes } from './episodes.js';
import { C0, DETECTOR, WINDOW_END } from './config.js';

const SWAP_DIR = path.join(DATA_DIR, 'swaps');
const HORIZONS = [
  ['1h', 60],
  ['6h', 360],
  ['24h', 1440],
];
const COMBO_NAME = process.env.OUTCOME_COMBO || 'trigger+RVOL+buyers';

function loadSwaps(pool) {
  const p = path.join(SWAP_DIR, `${pool}.jsonl`);
  if (!fs.existsSync(p)) return null;
  const txt = fs.readFileSync(p, 'utf8');
  if (!txt.trim()) return [];
  return txt.trim().split('\n').map((l) => JSON.parse(l));
}

/** Forward stats from candles[startIdx] against a reference price. */
function forwardStats(candles, startIdx, refPrice) {
  if (!(refPrice > 0)) return null;
  const out = { forwardMin: candles.length - startIdx };
  let peak = 0, peakIdx = startIdx;
  for (let i = startIdx; i < candles.length; i++) {
    const px = candles[i].close;
    if (px > 0 && px / refPrice > peak) { peak = px / refPrice; peakIdx = i; }
    for (const [name, mins] of HORIZONS) {
      if (i - startIdx === mins) out[`peak_${name}`] = peak;
    }
  }
  for (const [name, mins] of HORIZONS) {
    if (!(`peak_${name}` in out) && out.forwardMin > 0) out[`peak_${name}`] = peak; // tape ended early
    const idx = Math.min(candles.length - 1, startIdx + mins);
    const px = candles[idx]?.close;
    out[`terminal_${name}`] = px > 0 ? px / refPrice : null;
  }
  out.peak_end = peak;
  out.minToPeak = peakIdx - startIdx;
  // max drawdown from the running peak, after the peak was set
  let trough = peak;
  for (let i = peakIdx; i < candles.length; i++) {
    const px = candles[i].close;
    if (px > 0 && px / refPrice < trough) trough = px / refPrice;
  }
  out.retraceFromPeak = peak > 0 ? 1 - trough / peak : null;
  return out;
}

function bucket(mult) {
  if (mult == null) return 'n/a';
  if (mult < 1.5) return '<1.5x';
  if (mult < 2) return '1.5-2x';
  if (mult < 5) return '2-5x';
  if (mult < 10) return '5-10x';
  return '>=10x';
}

function fmt(x, d = 2) { return x == null ? '   —' : x.toFixed(d); }

function main() {
  const uni = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'universe.json'), 'utf8'));
  const endTs = Math.floor(Date.parse(WINDOW_END) / 1000);
  const combo = GATE_COMBOS.find((c) => c.name === COMBO_NAME);
  if (!combo) throw new Error(`unknown combo ${COMBO_NAME}`);

  const revivalRows = [], controlRows = [], alertRows = [];

  for (const entry of uni.universe) {
    const swaps = loadSwaps(entry.pool);
    if (!swaps || swaps.length < 50) continue;
    const meta = JSON.parse(fs.readFileSync(path.join(SWAP_DIR, `${entry.pool}.meta.json`), 'utf8'));
    const candles = buildCandles(swaps, meta.truncated ? meta.lastTs : endTs);
    const byTs = new Map(candles.map((c, i) => [c.ts, i]));
    const { episodes } = labelEpisodes(candles, C0);
    const symbol = entry.symbol ?? meta.symbol ?? entry.pool.slice(0, 8);

    for (const ep of episodes) {
      const idx = byTs.get(ep.startTs);
      if (idx == null) continue;
      const stats = forwardStats(candles, idx, ep.baseline);
      if (!stats) continue;
      const row = { symbol, startTs: ep.startTs, ...stats };
      (ep.revival ? revivalRows : controlRows).push(row);
    }

    const snaps = buildSnapshots(candles, DETECTOR, C0);
    for (const a of runDetector(snaps, combo, DETECTOR)) {
      const idx = byTs.get(a.ts);
      if (idx == null) continue;
      const entryPx = candles[idx].close;
      const stats = forwardStats(candles, idx, entryPx);
      if (stats) alertRows.push({ symbol, startTs: a.ts, ...stats });
    }
  }

  const line = (r) =>
    `${r.symbol.padEnd(12).slice(0, 12)} | peak ${fmt(r.peak_end)}x @${String(r.minToPeak).padStart(4)}m` +
    ` | 1h ${fmt(r.peak_1h)}x | 6h ${fmt(r.peak_6h)}x | 24h ${fmt(r.peak_24h)}x` +
    ` | end ${fmt(r.terminal_24h)}x | retrace ${r.retraceFromPeak == null ? '—' : Math.round(r.retraceFromPeak * 100) + '%'}` +
    ` | fwd ${Math.round(r.forwardMin / 60)}h`;

  console.log(`\n=== LABELED REVIVALS (${revivalRows.length}) — from pre-move baseline ===`);
  for (const r of revivalRows.sort((a, b) => b.peak_end - a.peak_end)) console.log(line(r));

  console.log(`\n=== CONTROLS that ran anyway (peak >= 1.5x, ${controlRows.filter((r) => r.peak_end >= 1.5).length}/${controlRows.length}) ===`);
  for (const r of controlRows.filter((r) => r.peak_end >= 1.5).sort((a, b) => b.peak_end - a.peak_end).slice(0, 10)) console.log(line(r));

  console.log(`\n=== ALERT OUTCOMES — combo "${COMBO_NAME}" (${alertRows.length} alerts), from alert-candle close ===`);
  const buckets = {};
  for (const r of alertRows) buckets[bucket(r.peak_24h)] = (buckets[bucket(r.peak_24h)] || 0) + 1;
  console.log('peak-within-24h buckets:', JSON.stringify(buckets));
  const meds = (key) => {
    const xs = alertRows.map((r) => r[key]).filter((x) => x != null).sort((a, b) => a - b);
    return xs.length ? xs[Math.floor(xs.length / 2)] : null;
  };
  console.log(`median peak 1h ${fmt(meds('peak_1h'))}x · 6h ${fmt(meds('peak_6h'))}x · 24h ${fmt(meds('peak_24h'))}x · median terminal 24h ${fmt(meds('terminal_24h'))}x`);
  const winners = alertRows.filter((r) => r.peak_24h >= 2).sort((a, b) => b.peak_24h - a.peak_24h);
  console.log(`alerts reaching >=2x within 24h: ${winners.length}/${alertRows.length}`);
  for (const r of winners.slice(0, 8)) console.log('  ' + line(r));

  fs.writeFileSync(path.join(DATA_DIR, 'outcomes.json'), JSON.stringify({ generatedAt: new Date().toISOString(), combo: COMBO_NAME, revivalRows, controlRows, alertRows }, null, 1));
  console.log(`\nwrote data/outcomes.json`);
}

main();
