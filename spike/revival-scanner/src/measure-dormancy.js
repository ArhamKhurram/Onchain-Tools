// Relative-dormancy experiment (2026-08-10, prompted by the MANLET miss).
//
// Question: the detector's dormancy precondition uses ABSOLUTE ceilings
// (<=30 trades/h, <=5 SOL/h) — a flatliner test. MANLET was a *fader* (idled
// at 7-17 SOL/h, ~1% of its own peak hour) and the precondition blocked a
// perfect ATR catch. Does replacing the precondition with a RELATIVE
// definition ("trailing 1h volume collapsed to <= X% of the token's own prior
// peak hour") admit faders without wrecking precision?
//
// Design: ground-truth episode labels stay EXACTLY as in measure.js (the C0
// absolute-dormancy labeler) — only the detector's precondition varies:
//   (a) absolute        — original gates (must reproduce measure.js)
//   (b) relative @ X%   — swept X, ceilings = max(absolute, X * own peak 1h)
//   (c) none            — precondition dropped entirely
//
//   node src/measure-dormancy.js   -> data/dormancy-experiment.json + stdout
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './pinax.js';
import { buildCandles } from './candles.js';
import { buildSnapshots, runDetector } from './detector.js';
import { labelEpisodes } from './episodes.js';
import { C0, DETECTOR, DORMANCY, WINDOW_END } from './config.js';

const SWAP_DIR = path.join(DATA_DIR, 'swaps');
const MATCH_BEFORE_S = 15 * 60;
const MATCH_AFTER_S = C0.REVIVAL_WINDOW_MIN * 60;

const MODES = [
  { name: 'absolute', dormancy: { ...DORMANCY, MODE: 'absolute' } },
  ...[0.01, 0.02, 0.05, 0.10, 0.25].map((f) => ({
    name: `relative@${(f * 100).toFixed(0)}%`,
    dormancy: { ...DORMANCY, MODE: 'relative', REL_COLLAPSE_FRAC: f },
  })),
  // MANLET's explosive leg came 139 min after (relative) dormancy ended —
  // outside the 120-min lookback. Cost of widening it:
  { name: 'abs+LB240', dormancy: { ...DORMANCY, MODE: 'absolute' }, lookback: 240 },
  { name: 'rel2%+LB240', dormancy: { ...DORMANCY, MODE: 'relative', REL_COLLAPSE_FRAC: 0.02 }, lookback: 240 },
  { name: 'none', dormancy: { ...DORMANCY, MODE: 'none' } },
];

const G = DETECTOR;
const COMBOS = [
  { name: 'trigger only' },
  { name: 'trigger+RVOL', rvol: G.RVOL_GATE },
  { name: 'trigger+RVOL+buyers', rvol: G.RVOL_GATE, buyers: G.BUYERS_GATE },
  { name: 'ALL gates', rvol: G.RVOL_GATE, buyers: G.BUYERS_GATE, buySell: G.BUYSELL_GATE },
];

function loadSwaps(pool) {
  const p = path.join(SWAP_DIR, `${pool}.jsonl`);
  if (!fs.existsSync(p)) return null;
  const txt = fs.readFileSync(p, 'utf8');
  if (!txt.trim()) return [];
  return txt.trim().split('\n').map((l) => JSON.parse(l));
}

function main() {
  const uni = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'universe.json'), 'utf8'));
  const endTs = Math.floor(Date.parse(WINDOW_END) / 1000);

  // Per pool: candles once, ground-truth episodes once, snapshots per mode.
  const perPool = [];
  for (const entry of uni.universe) {
    const swaps = loadSwaps(entry.pool);
    if (!swaps || swaps.length < 50) continue;
    const meta = JSON.parse(fs.readFileSync(path.join(SWAP_DIR, `${entry.pool}.meta.json`), 'utf8'));
    const candles = buildCandles(swaps, meta.truncated ? meta.lastTs : endTs);
    const { episodes } = labelEpisodes(candles, C0); // ground truth: UNCHANGED
    const revivalWindows = episodes.filter((e) => e.revival)
      .map((e) => ({ from: e.startTs - MATCH_BEFORE_S, to: e.startTs + MATCH_AFTER_S, ep: e }));
    const byMode = {};
    for (const m of MODES) {
      const cfg = m.lookback ? { ...DETECTOR, DORMANCY_LOOKBACK_MIN: m.lookback } : DETECTOR;
      const snaps = buildSnapshots(candles, cfg, C0, m.dormancy);
      byMode[m.name] = COMBOS.map((combo) => runDetector(snaps, combo, cfg));
    }
    perPool.push({
      pool: entry.pool, spanDays: candles.length / 1440, revivalWindows, byMode,
    });
  }

  const tokenDays = perPool.reduce((a, p) => a + p.spanDays, 0);
  const results = [];
  for (const m of MODES) {
    for (let ci = 0; ci < COMBOS.length; ci++) {
      let tp = 0, fp = 0, matchedRevivals = 0, totalRevivals = 0;
      for (const p of perPool) {
        totalRevivals += p.revivalWindows.length;
        const matched = new Set();
        for (const a of p.byMode[m.name][ci]) {
          const w = p.revivalWindows.find((w) => a.ts >= w.from && a.ts <= w.to);
          if (w) { tp += 1; matched.add(w.ep); } else fp += 1;
        }
        matchedRevivals += matched.size;
      }
      const alerts = tp + fp;
      results.push({
        mode: m.name, combo: COMBOS[ci].name,
        alerts, tp, fp,
        precision: alerts ? tp / alerts : null,
        recall: totalRevivals ? matchedRevivals / totalRevivals : null,
        matchedRevivals, totalRevivals,
        alertsPerTokenDay: alerts / tokenDays,
      });
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    note: 'Ground-truth labels fixed (C0 absolute labeler); only the detector dormancy precondition varies.',
    config: { C0, DETECTOR, DORMANCY_BASE: DORMANCY },
    tokenDays,
    results,
  };
  fs.writeFileSync(path.join(DATA_DIR, 'dormancy-experiment.json'), JSON.stringify(out, null, 2));

  console.log(`pools=${perPool.length} tokenDays=${tokenDays.toFixed(0)}`);
  console.log('mode          | combo                | alerts | TP | FP | precision | recall | alerts/td');
  for (const r of results) {
    console.log([
      r.mode.padEnd(13),
      r.combo.padEnd(20),
      String(r.alerts).padStart(6),
      String(r.tp).padStart(3),
      String(r.fp).padStart(4),
      (r.precision == null ? 'n/a' : (r.precision * 100).toFixed(1) + '%').padStart(8),
      (r.recall == null ? 'n/a' : `${r.matchedRevivals}/${r.totalRevivals} ` + (r.recall * 100).toFixed(0) + '%').padStart(9),
      r.alertsPerTokenDay.toFixed(3).padStart(8),
    ].join(' | '));
  }
}

main();
