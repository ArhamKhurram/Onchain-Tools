/**
 * Revival ignition detector — pure functions over OHLCV candles.
 *
 * A "revival" is a token that had gone quiet (RELATIVE to its own history)
 * and just ignited: volatility expansion (ATR% z-score) + volume expansion
 * (RVOL) on a token whose trailing volume had recently collapsed versus its
 * own prior peak.
 *
 * This module is deliberately a swappable, side-effect-free unit: a trained
 * scoring model will replace `evaluateRevival` later behind the exact same
 * plumbing (candles in → verdict out). Keep I/O, cooldowns, and fan-out in
 * the poller, never in here.
 *
 * Design notes:
 * - The dormancy precondition is RELATIVE (trailing 6h volume vs the token's
 *   own prior 72h peak 6h-window volume), not an absolute SOL/h ceiling — an
 *   absolute ceiling provably missed a real revival (MANLET, Aug 10).
 * - Sparse candles are normal (a minute with no trades yields no candle).
 *   All volume windows are computed over wall-clock time buckets with missing
 *   buckets counted as zero volume; ATR runs over the candle sequence as-is.
 * - This detector fires only when EVERY gate holds. Signals stay independent:
 *   it never reads convergence / missed-runner / FOMO state.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export interface Candle {
  /** Bucket start, unix ms. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Traded volume in the bucket (USD). */
  volume: number;
}

export interface RevivalDetectorConfig {
  /** Wilder ATR period on 1m candles. */
  atrPeriod: number;
  /** Minimum ATR% z-score vs the trailing baseline. */
  atrZThreshold: number;
  /** Absolute ATR% floor (fraction of close, e.g. 0.001 = 0.1%). */
  atrPctFloor: number;
  /** Trailing window the ATR% baseline (mean/std) is computed over. */
  atrBaselineMs: number;
  /** Minimum span of 1m history before any signal. */
  warmupMs: number;
  /** RVOL numerator window. */
  rvolWindowMs: number;
  /** RVOL baseline window (averaged per rvolWindowMs). */
  rvolBaselineMs: number;
  /** Minimum RVOL. */
  rvolThreshold: number;
  /** Dormancy: size of the trailing volume window that must have collapsed. */
  dormancyWindowMs: number;
  /** Dormancy: lookback over which the peak same-size window is taken. */
  dormancyPeakLookbackMs: number;
  /** Dormancy must have held at some point within this much of "now". */
  dormancyRecentMs: number;
  /** Collapse ratio: trailing window ≤ ratio × prior peak window. */
  dormancyCollapseRatio: number;
}

export const DEFAULT_REVIVAL_CONFIG: RevivalDetectorConfig = {
  atrPeriod: 14,
  atrZThreshold: 3.0,
  atrPctFloor: 0.001,
  atrBaselineMs: 24 * HOUR_MS,
  warmupMs: 6 * HOUR_MS,
  rvolWindowMs: 5 * MINUTE_MS,
  rvolBaselineMs: 24 * HOUR_MS,
  rvolThreshold: 3,
  dormancyWindowMs: 6 * HOUR_MS,
  dormancyPeakLookbackMs: 72 * HOUR_MS,
  dormancyRecentMs: 2 * HOUR_MS,
  dormancyCollapseRatio: 0.2,
};

export interface RevivalEvaluation {
  fired: boolean;
  /** False when < warmupMs of 1m history (or too few candles for ATR). */
  warmedUp: boolean;
  /** Current ATR as a fraction of close (null before warmup). */
  atrPct: number | null;
  /** ATR% z-score vs trailing baseline (null before warmup). */
  atrZ: number | null;
  /** Last-window volume vs trailing per-window average (null before warmup). */
  rvol: number | null;
  /** Relative dormancy precondition held within the recent window. */
  dormant: boolean;
  /** Last 1m close, if any candles exist. */
  price: number | null;
}

const NOT_FIRED_COLD: RevivalEvaluation = {
  fired: false,
  warmedUp: false,
  atrPct: null,
  atrZ: null,
  rvol: null,
  dormant: false,
  price: null,
};

/** Sentinel for "baseline had zero variance / zero volume but current is hot". */
const Z_SENTINEL = 999;

function sortValid(candles: Candle[]): Candle[] {
  return candles
    .filter(
      (c) =>
        Number.isFinite(c.ts) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        Number.isFinite(c.volume) &&
        c.close > 0,
    )
    .sort((a, b) => a.ts - b.ts);
}

/**
 * ATR% series via Wilder smoothing over the candle sequence as-is (gaps from
 * sparse minutes are tolerated — TR uses the previous *traded* candle's close).
 * Returns one entry per candle from index `period` onward: { ts, atrPct }.
 */
export function computeAtrPctSeries(
  candles: Candle[],
  period: number,
): { ts: number; atrPct: number }[] {
  if (candles.length < period + 1) return [];

  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
    trs.push(tr);
  }

  const out: { ts: number; atrPct: number }[] = [];
  // Seed: SMA of the first `period` TRs → ATR at candle index `period`.
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push({ ts: candles[period].ts, atrPct: atr / candles[period].close });
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    const candle = candles[i + 1];
    out.push({ ts: candle.ts, atrPct: atr / candle.close });
  }
  return out;
}

/** Sum of candle volume with ts in (from, to]. Missing buckets contribute 0. */
function volumeInWindow(candles: Candle[], from: number, to: number): number {
  let sum = 0;
  for (const c of candles) {
    if (c.ts > from && c.ts <= to) sum += c.volume;
  }
  return sum;
}

/**
 * Relative dormancy: at some evaluation point within the last
 * `dormancyRecentMs`, the trailing `dormancyWindowMs` of volume was
 * ≤ `dormancyCollapseRatio` × the peak same-size window over the prior
 * `dormancyPeakLookbackMs`. Evaluated on hourly buckets (missing hours = 0).
 * Requires a non-zero prior peak — a token that never traded is not "dormant",
 * it is dead, and must not trivially satisfy the gate.
 */
export function isRecentlyDormant(
  hourCandles: Candle[],
  now: number,
  cfg: RevivalDetectorConfig = DEFAULT_REVIVAL_CONFIG,
): boolean {
  const sorted = sortValid(hourCandles);
  if (sorted.length === 0) return false;

  const windowHours = Math.max(1, Math.round(cfg.dormancyWindowMs / HOUR_MS));
  const peakHours = Math.max(1, Math.round(cfg.dormancyPeakLookbackMs / HOUR_MS));
  const recentHours = Math.max(0, Math.floor(cfg.dormancyRecentMs / HOUR_MS));

  // Hourly volume timeline ending at the current hour, zero-filled.
  const endBucket = Math.floor(now / HOUR_MS);
  const startBucket = endBucket - (peakHours + windowHours + recentHours);
  const n = endBucket - startBucket + 1;
  const vols = new Array<number>(n).fill(0);
  for (const c of sorted) {
    const b = Math.floor(c.ts / HOUR_MS);
    const idx = b - startBucket;
    if (idx >= 0 && idx < n) vols[idx] += c.volume;
  }

  // Rolling window sums (window ending at index i).
  const roll = new Array<number>(n).fill(Number.NaN);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += vols[i];
    if (i >= windowHours) acc -= vols[i - windowHours];
    if (i >= windowHours - 1) roll[i] = acc;
  }

  // Evaluate windows ending now, now-1h, … now-recentHours.
  for (let e = 0; e <= recentHours; e++) {
    const i = n - 1 - e;
    if (i < windowHours - 1 || Number.isNaN(roll[i])) continue;

    // Peak of disjoint prior windows within the lookback.
    const lastPrior = i - windowHours;
    const firstPrior = Math.max(windowHours - 1, i - windowHours - peakHours + 1);
    let peak = 0;
    for (let j = firstPrior; j <= lastPrior; j++) {
      if (!Number.isNaN(roll[j]) && roll[j] > peak) peak = roll[j];
    }
    if (peak <= 0) continue;
    if (roll[i] <= cfg.dormancyCollapseRatio * peak) return true;
  }
  return false;
}

/**
 * The full ATR-gate revival check. Fires only when ALL hold:
 *  1. warmup — ≥ warmupMs span of 1m history (and enough candles for ATR);
 *  2. ATR% expansion — z ≥ atrZThreshold vs trailing baseline, with an
 *     absolute atrPctFloor;
 *  3. RVOL — last-window volume ≥ rvolThreshold × trailing per-window average;
 *  4. relative dormancy within the recent window (see isRecentlyDormant).
 *
 * Cooldowns are the caller's job (poller state), not the detector's.
 */
export function evaluateRevival(
  minuteCandles: Candle[],
  hourCandles: Candle[],
  now: number,
  cfg: RevivalDetectorConfig = DEFAULT_REVIVAL_CONFIG,
): RevivalEvaluation {
  const minutes = sortValid(minuteCandles);
  if (minutes.length === 0) return NOT_FIRED_COLD;

  const price = minutes[minutes.length - 1].close;

  // Warmup: require a real span of history plus enough candles for the ATR
  // seed AND at least a handful of baseline points beyond it.
  const span = minutes[minutes.length - 1].ts - minutes[0].ts;
  const atrSeries = computeAtrPctSeries(minutes, cfg.atrPeriod);
  if (span < cfg.warmupMs || atrSeries.length < 2) {
    return { ...NOT_FIRED_COLD, price };
  }

  // --- Gate 2: ATR% expansion ---
  const current = atrSeries[atrSeries.length - 1];
  const baseline = atrSeries.filter(
    (p) => p.ts >= now - cfg.atrBaselineMs && p.ts < current.ts,
  );
  if (baseline.length < 2) return { ...NOT_FIRED_COLD, price };

  const mean = baseline.reduce((a, b) => a + b.atrPct, 0) / baseline.length;
  const variance =
    baseline.reduce((a, b) => a + (b.atrPct - mean) ** 2, 0) / baseline.length;
  const std = Math.sqrt(variance);
  // A flatlined baseline (std ≈ 0) with a real expansion above it IS the
  // strongest possible z — report a sentinel instead of dividing by zero.
  const atrZ =
    std > 1e-12
      ? (current.atrPct - mean) / std
      : current.atrPct > mean
        ? Z_SENTINEL
        : 0;
  const atrGate = atrZ >= cfg.atrZThreshold && current.atrPct >= cfg.atrPctFloor;

  // --- Gate 3: RVOL ---
  const lastWindowVol = volumeInWindow(minutes, now - cfg.rvolWindowMs, now);
  const baselineVol = volumeInWindow(minutes, now - cfg.rvolBaselineMs, now);
  const windowCount = Math.max(1, Math.round(cfg.rvolBaselineMs / cfg.rvolWindowMs));
  const avgPerWindow = baselineVol / windowCount;
  const rvol =
    avgPerWindow > 1e-12
      ? lastWindowVol / avgPerWindow
      : lastWindowVol > 0
        ? Z_SENTINEL
        : 0;
  const rvolGate = rvol >= cfg.rvolThreshold;

  // --- Gate 4: relative dormancy precondition ---
  const dormant = isRecentlyDormant(hourCandles, now, cfg);

  return {
    fired: atrGate && rvolGate && dormant,
    warmedUp: true,
    atrPct: current.atrPct,
    atrZ,
    rvol,
    dormant,
    price,
  };
}
