// C4 (part 2): replay the detector over the backfilled history and measure
// precision / recall / alerts-per-day / lead time per gate combination.
//
// Matching rule: an alert is a true positive if it lands inside
// [episodeStart - 15 min, episodeStart + REVIVAL_WINDOW_MIN] of a labeled
// revival episode. Everything else is a false positive. Recall = fraction of
// labeled revivals with at least one matching alert (under that combo).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './pinax.js';
import { buildCandles } from './candles.js';
import { buildSnapshots, runDetector, GATE_COMBOS } from './detector.js';
import { labelEpisodes } from './episodes.js';
import { C0, DETECTOR, WINDOW_END } from './config.js';

const SWAP_DIR = path.join(DATA_DIR, 'swaps');
const MATCH_BEFORE_S = 15 * 60;
const MATCH_AFTER_S = C0.REVIVAL_WINDOW_MIN * 60;

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

  const perPool = [];
  let totals = { pools: 0, swaps: 0, candles: 0, tradedCandles: 0, dormantMinutes: 0, revivals: 0, controls: 0 };

  for (const entry of uni.universe) {
    const swaps = loadSwaps(entry.pool);
    if (!swaps || swaps.length < 50) continue; // too thin to say anything
    const meta = JSON.parse(fs.readFileSync(path.join(SWAP_DIR, `${entry.pool}.meta.json`), 'utf8'));
    const candles = buildCandles(swaps, meta.truncated ? meta.lastTs : endTs);
    const snaps = buildSnapshots(candles, DETECTOR, C0);
    const { episodes, dormantMinutes } = labelEpisodes(candles, C0);
    const revivals = episodes.filter((e) => e.revival);
    const controls = episodes.filter((e) => !e.revival);

    const combos = GATE_COMBOS.map((combo) => {
      const alerts = runDetector(snaps, combo, DETECTOR);
      return { combo: combo.name, alerts };
    });

    perPool.push({
      pool: entry.pool, symbol: entry.symbol ?? meta.symbol,
      swaps: swaps.length, candles: candles.length,
      tradedCandles: candles.filter((c) => c.trades > 0).length,
      truncated: meta.truncated,
      spanDays: (candles.length / 1440),
      dormantMinutes, episodes, revivals: revivals.length, controls: controls.length,
      combos,
    });
    totals.pools += 1; totals.swaps += swaps.length; totals.candles += candles.length;
    totals.tradedCandles += candles.filter((c) => c.trades > 0).length;
    totals.dormantMinutes += dormantMinutes;
    totals.revivals += revivals.length; totals.controls += controls.length;
  }

  // ---- aggregate per combo ----
  const results = [];
  for (const comboDef of GATE_COMBOS) {
    let tp = 0, fp = 0, matchedRevivals = 0, totalRevivals = 0;
    const leads = [];
    const fpSamples = [];
    for (const p of perPool) {
      const revivalWindows = p.episodes.filter((e) => e.revival)
        .map((e) => ({ from: e.startTs - MATCH_BEFORE_S, to: e.startTs + MATCH_AFTER_S, ep: e }));
      totalRevivals += revivalWindows.length;
      const { alerts } = p.combos.find((c) => c.combo === comboDef.name);
      const matched = new Set();
      for (const a of alerts) {
        const w = revivalWindows.find((w) => a.ts >= w.from && a.ts <= w.to);
        if (w) {
          tp += 1;
          if (!matched.has(w.ep)) {
            matched.add(w.ep);
            if (w.ep.pumpStartTs != null) leads.push((w.ep.pumpStartTs - a.ts) / 60);
          }
        } else {
          fp += 1;
          if (fpSamples.length < 40) fpSamples.push({ pool: p.pool, symbol: p.symbol, ...a });
        }
      }
      matchedRevivals += matched.size;
    }
    const alertsTotal = tp + fp;
    const tokenDays = perPool.reduce((a, p) => a + p.spanDays, 0);
    leads.sort((a, b) => a - b);
    results.push({
      combo: comboDef.name,
      alerts: alertsTotal,
      tp, fp,
      precision: alertsTotal ? tp / alertsTotal : null,
      recall: totalRevivals ? matchedRevivals / totalRevivals : null,
      matchedRevivals, totalRevivals,
      alertsPerTokenDay: alertsTotal / tokenDays,
      medianLeadMin: leads.length ? leads[Math.floor(leads.length / 2)] : null,
      fpSamples,
    });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    config: { C0, DETECTOR },
    coverage: {
      ...totals,
      tokenDays: perPool.reduce((a, p) => a + p.spanDays, 0),
      dormantTokenDays: totals.dormantMinutes / 1440,
    },
    results: results.map(({ fpSamples, ...r }) => r),
    fpSamples: Object.fromEntries(results.map((r) => [r.combo, r.fpSamples])),
    pools: perPool.map(({ combos, episodes, ...p }) => ({
      ...p,
      revivalEpisodes: episodes.filter((e) => e.revival),
      alertsAllGates: combos.find((c) => c.combo === 'ALL gates').alerts.length,
    })),
  };
  fs.writeFileSync(path.join(DATA_DIR, 'measurement.json'), JSON.stringify(out, null, 2));

  // console summary
  console.log(`pools=${totals.pools} swaps=${totals.swaps} candles=${totals.candles} ` +
    `tokenDays=${out.coverage.tokenDays.toFixed(0)} dormantTokenDays=${out.coverage.dormantTokenDays.toFixed(0)}`);
  console.log(`revival episodes=${totals.revivals} control episodes=${totals.controls}`);
  console.log('combo | alerts | TP | FP | precision | recall | alerts/token-day | median lead (min)');
  for (const r of out.results) {
    console.log([
      r.combo.padEnd(26),
      String(r.alerts).padStart(6),
      String(r.tp).padStart(4),
      String(r.fp).padStart(5),
      r.precision == null ? '  n/a' : (r.precision * 100).toFixed(1) + '%',
      r.recall == null ? '  n/a' : (r.recall * 100).toFixed(1) + '%',
      r.alertsPerTokenDay.toFixed(3).padStart(8),
      r.medianLeadMin == null ? ' n/a' : r.medianLeadMin.toFixed(1),
    ].join(' | '));
  }
}

main();
