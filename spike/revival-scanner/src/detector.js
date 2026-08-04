// C3 (part 3): dormancy tracking + the revival detector.
//
// Locked design: ONE trigger (ATR% expansion z-score) plus hard AND-gates —
// not a blended score. The liquidity gate is omitted in the spike: Pinax REST
// exposes no SVM liquidity add/remove endpoint (documented in the report).
//
// The pipeline is split so the expensive parts (candles, indicators,
// dormancy) run once per pool, and gate combinations are cheap boolean
// re-evaluations over the same snapshots — same code path either way.
import { IndicatorEngine } from './indicators.js';
import { C0, DETECTOR } from './config.js';

/**
 * Incremental dormancy tracker.
 * "Dormant" = every trailing 60-minute window over the past DORMANT_HOURS
 * hours stayed below the trade-count and volume ceilings. Implemented as a
 * consecutive-quiet-minutes counter over rolling 1h sums (O(1) per candle).
 */
export class DormancyTracker {
  constructor(c0 = C0) {
    this.c0 = c0;
    this.win = [];        // last 60 candles {trades, vol}
    this.trades = 0;
    this.vol = 0;
    this.quietMin = 0;    // consecutive minutes with quiet rolling-hour
    this.minutesSeen = 0;
  }
  push(c) {
    this.win.push({ trades: c.trades, vol: c.volQuote });
    this.trades += c.trades; this.vol += c.volQuote;
    if (this.win.length > 60) {
      const old = this.win.shift();
      this.trades -= old.trades; this.vol -= old.vol;
    }
    this.minutesSeen += 1;
    const quiet = this.trades < this.c0.DORMANT_MAX_TRADES_PER_H
      && this.vol < this.c0.DORMANT_MAX_VOL_SOL_PER_H;
    this.quietMin = quiet ? this.quietMin + 1 : 0;
    return this.dormant;
  }
  get dormant() {
    return this.minutesSeen >= this.c0.DORMANT_HOURS * 60
      && this.quietMin >= this.c0.DORMANT_HOURS * 60;
  }
}

/**
 * One pass over a pool's candles -> per-candle snapshots with everything a
 * gate combination needs. Runs the same IndicatorEngine + DormancyTracker a
 * live scanner would.
 */
export function buildSnapshots(candles, cfg = DETECTOR, c0 = C0) {
  const eng = new IndicatorEngine(cfg);
  const dorm = new DormancyTracker(c0);
  const snaps = new Array(candles.length);
  let lastDormantIdx = -Infinity;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const ind = eng.push(c);
    const isDormant = dorm.push(c);
    if (isDormant) lastDormantIdx = i;
    snaps[i] = {
      ts: c.ts,
      close: c.close,
      trigger: ind.warm
        && ind.atrPctZ > cfg.Z_TRIGGER
        && ind.atrPct > cfg.ATR_PCT_FLOOR,
      dormant: isDormant,
      dormantRecently: i - lastDormantIdx <= cfg.DORMANCY_LOOKBACK_MIN,
      // raw gate inputs — thresholds are applied per-combo in runDetector so
      // combos can ablate *and* vary thresholds over the same snapshots
      atrPctZ: ind.atrPctZ,
      rvol: ind.rvol,
      uniqueBuyers: ind.uniqueBuyers,
      buySellRatio: ind.buySellRatio,
    };
  }
  return snaps;
}

/**
 * Evaluate one gate combination over precomputed snapshots.
 * combo gates: rvol / buyers / buySell — a number enables the gate at that
 * threshold; null/undefined disables it. The trigger and the
 * emerged-from-dormancy precondition are always on — they define the signal;
 * gates are what we ablate.
 */
export function runDetector(snaps, combo, cfg = DETECTOR) {
  const alerts = [];
  let cooldownUntil = -Infinity;
  for (const s of snaps) {
    if (s.ts < cooldownUntil) continue;
    if (!s.trigger || !s.dormantRecently) continue;
    if (combo.rvol != null && s.rvol < combo.rvol) continue;
    if (combo.buyers != null && s.uniqueBuyers < combo.buyers) continue;
    if (combo.buySell != null && s.buySellRatio < combo.buySell) continue;
    alerts.push(s);
    cooldownUntil = s.ts + cfg.COOLDOWN_MIN * 60;
  }
  return alerts;
}

const G = DETECTOR; // default gate thresholds
export const GATE_COMBOS = [
  { name: 'trigger only' },
  { name: 'trigger+RVOL',            rvol: G.RVOL_GATE },
  { name: 'trigger+buyers',          buyers: G.BUYERS_GATE },
  { name: 'trigger+buy/sell',        buySell: G.BUYSELL_GATE },
  { name: 'trigger+RVOL+buyers',     rvol: G.RVOL_GATE, buyers: G.BUYERS_GATE },
  { name: 'trigger+RVOL+buy/sell',   rvol: G.RVOL_GATE, buySell: G.BUYSELL_GATE },
  { name: 'trigger+buyers+buy/sell', buyers: G.BUYERS_GATE, buySell: G.BUYSELL_GATE },
  { name: 'ALL gates',               rvol: G.RVOL_GATE, buyers: G.BUYERS_GATE, buySell: G.BUYSELL_GATE },
  // threshold-sensitivity variants (measurement only, not part of the 8-way ablation)
  { name: 'ALL gates, buy/sell>=1.0', rvol: G.RVOL_GATE, buyers: G.BUYERS_GATE, buySell: 1.0 },
  { name: 'RVOL>=2 + buyers>=3',      rvol: 2.0, buyers: 3 },
  { name: 'RVOL>=2 + buyers>=3 + b/s>=1.0', rvol: 2.0, buyers: 3, buySell: 1.0 },
];
