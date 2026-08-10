// Convert operator-labeled snapshots (data/labels/*) into training-corpus
// episode rows — the same schema corpus-episodes.js emits — so the GBT
// pipeline can score/evaluate them.
//
//   node src/labels-to-corpus.js            # all snapshots
//   node src/labels-to-corpus.js MANLET     # one snapshot
//
// Output: data/labels/intake-episodes.jsonl (committed with the snapshots;
// train/train.py appends it to the corpus as window='intake').
//
// Differences vs the swap-derived corpus rows (all honest gaps, not guesses):
//   - Episode segmentation uses RELATIVE dormancy (2%) — faders like MANLET
//     are exactly the tokens the absolute segmenter cannot see. Rows carry
//     dormancyMode so the trainer knows.
//   - uniqueBuyers10m / buySellRatio10m / tradesInMinute are null (no wallet
//     or per-trade data in public OHLCV; LightGBM treats null as missing).
//   - vol10m is rolling 10m total volume (SOL), matching the corpus field's
//     units; absorption uses it the same way.
//   - Forward labels are capped at the observed tape (observedMin says how
//     much); a label2x=1 within a short window is still a true positive, but
//     label2x=0 with observedMin < 1440 is censored — the trainer must not
//     treat those as confirmed negatives (rows carry `censored:1`).
import fs from 'node:fs';
import path from 'node:path';
import { IndicatorEngine } from './indicators.js';
import { DormancyTracker } from './detector.js';
import { C0, DETECTOR, DORMANCY } from './config.js';
import { LABELS_DIR, listSnapshotDirs, loadSnapshot } from './labels-common.js';

const OUT_PATH = path.join(LABELS_DIR, 'intake-episodes.jsonl');
const HORIZONS = [['1h', 60], ['6h', 360], ['24h', 1440]];
const SEG_DORMANCY = { ...DORMANCY, MODE: 'relative', REL_COLLAPSE_FRAC: 0.02 };

const round = (x) => (x == null || !isFinite(x) ? null : Number(x.toPrecision(6)));
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function processSnapshot(ref, out) {
  const { dir, label, pool, candles } = loadSnapshot(ref);
  const eng = new IndicatorEngine(DETECTOR);
  const dorm = new DormancyTracker(C0, SEG_DORMANCY);
  const closes = candles.map((c) => c.close ?? 0);
  const volRing = [];
  const closeRing = [];
  let wasDormant = false, prevQuiet = 0, blockedUntil = -1;
  const episodes = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const ind = eng.push(c);
    const quietBefore = prevQuiet;
    const nowDormant = dorm.push(c);
    prevQuiet = dorm.quietMin;
    volRing.push(c.volQuote);
    if (volRing.length > 10) volRing.shift();
    closeRing.push(c.close);
    if (closeRing.length > 11) closeRing.shift();

    // dormancy exit = activity resumes (volume, not trades: OHLCV has no counts)
    if (wasDormant && !nowDormant && c.volQuote > 0 && i > blockedUntil) {
      const preIdx = Math.max(0, i - 30);
      const baseline = median(closes.slice(preIdx, i).filter((x) => x > 0)) ?? c.close;
      const vol10 = volRing.reduce((a, b) => a + b, 0);
      const disp10 = closeRing.length > 1 && closeRing[0] > 0 ? Math.abs(c.close / closeRing[0] - 1) : 0;
      episodes.push({
        idx: i,
        feat: {
          atrPctZ: round(ind.atrPctZ), atrPct: round(ind.atrPct),
          rvol: round(ind.rvol),
          uniqueBuyers10m: null,
          buySellRatio10m: null,
          vol10m: round(vol10),
          absorption: round(disp10 / Math.max(vol10, 0.5)),
          dispFromBaseline: baseline > 0 ? round(c.close / baseline - 1) : 0,
          dormancyHours: round(quietBefore / 60),
          tokenAgeMin: i,
          tradesInMinute: null,
          hourUtc: Math.floor((c.ts % 86400) / 3600),
          dayOfWeek: new Date(c.ts * 1000).getUTCDay(),
          warm: ind.warm ? 1 : 0,
        },
        entry: c.close,
        baseline,
        ts: c.ts,
      });
      blockedUntil = i + C0.REVIVAL_WINDOW_MIN;
    }
    wasDormant = nowDormant;
  }

  let prior = 0, prior2x = 0, written = 0;
  const endIdx = candles.length - 1;
  for (const ep of episodes) {
    if (!(ep.entry > 0)) continue;
    const observedMin = Math.min(endIdx - ep.idx, 1440);
    if (observedMin < 30) continue; // nothing observable
    const lastIdx = Math.min(endIdx, ep.idx + 1440);
    let peak = 0, peakIdx = ep.idx;
    const lab = {};
    for (let i = ep.idx; i <= lastIdx; i++) {
      const m = closes[i] / ep.entry;
      if (m > peak) { peak = m; peakIdx = i; }
    }
    for (const [name, mins] of HORIZONS) {
      const hi = Math.min(lastIdx, ep.idx + mins);
      let p = 0;
      for (let i = ep.idx; i <= hi; i++) p = Math.max(p, closes[i] / ep.entry);
      lab[`peak_${name}`] = round(p);
      lab[`terminal_${name}`] = round(closes[Math.min(lastIdx, ep.idx + Math.min(mins, observedMin))] / ep.entry);
    }
    let trough = peak;
    for (let i = peakIdx; i <= lastIdx; i++) trough = Math.min(trough, closes[i] / ep.entry);
    lab.retraceFromPeak = peak > 0 ? round(1 - trough / peak) : null;
    lab.minToPeak = peakIdx - ep.idx;
    lab.label2x = lab.peak_24h >= 2 ? 1 : 0;
    lab.rugged90 = lab.terminal_24h <= 0.1 ? 1 : 0;
    lab.observedMin = observedMin;
    lab.censored = lab.label2x === 0 && observedMin < 1440 ? 1 : 0;

    out.write(JSON.stringify({
      chain: 'solana', window: 'intake', pool,
      mint: label.mint, symbol: label.symbol, operatorLabel: label.label,
      dormancyMode: 'relative@2%',
      ts: ep.ts,
      ...ep.feat,
      priorEpisodes: prior,
      prior2xEpisodes: prior2x,
      entryPrice: ep.entry,
      baselinePrice: ep.baseline,
      ...lab,
    }) + '\n');
    prior += 1;
    if (lab.label2x) prior2x += 1;
    written += 1;
  }
  console.log(`${path.basename(dir)}: ${written} episode row(s)`);
  return written;
}

const ref = process.argv[2];
const targets = ref ? [ref] : listSnapshotDirs();
const out = fs.createWriteStream(OUT_PATH, { flags: 'w' });
let total = 0;
for (const t of targets) total += processSnapshot(t, out);
out.end(() => console.log(`wrote ${total} row(s) -> ${OUT_PATH}`));
