// C4 (part 1): scan candle series for dormancy-exit episodes and label each
// one revival / non-revival per the C0 operational definition. Uses the SAME
// DormancyTracker as the detector (one code path for "dormant").
import { DormancyTracker } from './detector.js';
import { C0 } from './config.js';

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Returns { episodes, dormantMinutes }.
 * An episode starts when a dormant token's activity resumes (quiet-minute
 * counter resets while dormant). Label per C0:
 *   revival  = within REVIVAL_WINDOW_MIN: max gain >= REVIVAL_MIN_GAIN vs the
 *              pre-move baseline, a run of >= REVIVAL_SUSTAIN_MIN consecutive
 *              minutes holding >= REVIVAL_SUSTAIN_GAIN, >= Z unique buyers and
 *              >= volume floor over the window.
 *   control  = any dormancy exit that fails the above.
 */
export function labelEpisodes(candles, c0 = C0) {
  const dorm = new DormancyTracker(c0);
  const episodes = [];
  let dormantMinutes = 0;
  let wasDormant = false;
  let blockedUntilIdx = -1;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const nowDormant = dorm.push(c);
    if (nowDormant) dormantMinutes += 1;

    // dormancy exit: was dormant last minute, activity this minute
    if (wasDormant && !nowDormant && c.trades > 0 && i > blockedUntilIdx) {
      const ep = evaluateEpisode(candles, i, c0);
      episodes.push(ep);
      blockedUntilIdx = i + c0.REVIVAL_WINDOW_MIN; // no overlapping episodes
    }
    wasDormant = nowDormant;
  }
  return { episodes, dormantMinutes };
}

function evaluateEpisode(candles, startIdx, c0) {
  const start = candles[startIdx];
  // Pre-move baseline: median close of the trailing 30 minutes (dormant tail).
  const pre = candles.slice(Math.max(0, startIdx - 30), startIdx)
    .map((c) => c.close).filter((x) => x != null && x > 0);
  const baseline = median(pre) ?? start.close;

  const endIdx = Math.min(candles.length, startIdx + c0.REVIVAL_WINDOW_MIN);
  const sustainEndIdx = Math.min(candles.length, endIdx + 30); // sustain run may straddle window edge
  let maxGain = 0, vol = 0;
  const buyers = new Set();
  let pumpStartTs = null;
  for (let i = startIdx; i < endIdx; i++) {
    const c = candles[i];
    const gain = baseline > 0 ? c.close / baseline - 1 : 0;
    if (gain > maxGain) maxGain = gain;
    if (pumpStartTs == null && gain >= 0.10) pumpStartTs = c.ts;
    vol += c.volQuote;
    for (const b of c.buyerWallets ?? []) buyers.add(b);
  }
  // sustain: longest run of consecutive minutes holding >= SUSTAIN_GAIN
  let run = 0, bestRun = 0;
  for (let i = startIdx; i < sustainEndIdx; i++) {
    const gain = baseline > 0 ? candles[i].close / baseline - 1 : 0;
    if (gain >= c0.REVIVAL_SUSTAIN_GAIN) { run += 1; bestRun = Math.max(bestRun, run); }
    else run = 0;
  }

  const revival = maxGain >= c0.REVIVAL_MIN_GAIN
    && bestRun >= c0.REVIVAL_SUSTAIN_MIN
    && buyers.size >= c0.REVIVAL_MIN_UNIQUE_BUYERS
    && vol >= c0.REVIVAL_MIN_VOL_SOL;

  return {
    startTs: start.ts,
    endTs: candles[Math.max(startIdx, endIdx - 1)].ts,
    baseline,
    maxGain,
    sustainRun: bestRun,
    uniqueBuyers: buyers.size,
    volQuote: vol,
    pumpStartTs,
    revival,
  };
}
