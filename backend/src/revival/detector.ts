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
 * - Dormancy alone is NOT enough. "Was dormant at some point in the last 2h"
 *   keeps sliding forward while a token runs, and the ATR%/RVOL baselines stay
 *   depressed by the dormant period they still average over — so every gate
 *   stays satisfied for hours INTO a run. The run gate below (current price vs
 *   the pre-ignition baseline) is what makes this detector fire at the START of
 *   a move instead of anywhere along it.
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
  /**
   * Run gate: refuse to fire once price is already more than this multiple of
   * the pre-ignition baseline (see resolveBaselinePrice). "Revival" means the
   * ignition, not the middle of the move.
   */
  maxRunFromBaseline: number;
  /**
   * Drawdown gate: a dormant window only counts as revival-eligible when its
   * baseline price sits at least this far below the trailing peak hourly close
   * over the `dormancyPeakLookbackMs` span preceding the window (0.35 = the
   * baseline must be ≥35% below the peak). Volume collapse alone is not death:
   * a token consolidating near its highs goes quiet WITHOUT drawing down, and
   * that shape is a continuation/breakout setup, not a revival (see the TOAD
   * plateau case on the default below).
   *
   * The lookback is deliberately the same `dormancyPeakLookbackMs` the volume
   * collapse is measured over — dormancy is already defined as "quiet relative
   * to the token's own prior 72h", so "died" is measured against the same era
   * rather than through a second knob that could drift out of sync with it.
   */
  minDrawdownFromPeak: number;
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
  // 3.0 is calibrated against labeled cases, not chosen for roundness:
  //   MANLET (Solana, true positive) — baseline ~0.00027, good trigger at
  //     ~0.000543 → 2.0x. This is the BINDING CONSTRAINT on the lower side:
  //     tightening to 1.5x would have dropped a real revival. Do not tighten
  //     below ~2.2x without re-labelling cases first.
  //   UP (Robinhood, true positive) — baseline ~0.077, trigger ~0.0959 → 1.2x.
  //   TOAD (false alert this gate exists to kill) — alerted at $16-17M after
  //     running from a ~$25K baseline → ~600x.
  // 3.0 clears MANLET with 50% headroom for baseline-estimation noise while
  // sitting 200x below the TOAD case; anything in 2.5-3.0 separates all three,
  // and the wider end is preferred because the cost of a slightly-late alert is
  // far lower than the cost of silently dropping a real revival.
  maxRunFromBaseline: 3.0,
  // 0.35 is calibrated against labeled cases, not chosen for roundness:
  //   MANLET (Solana, true positive) — dormant baseline ~0.00027 vs trailing
  //     peak ~0.0009 → ~70% drawdown → passes comfortably.
  //   UP (Robinhood, true positive) — baseline ~0.077 vs peak ~0.133 → ~42%
  //     drawdown → passes. This is the BINDING CONSTRAINT on the upper side:
  //     pushing the threshold past ~40% starts killing real revivals. Do not
  //     raise it without re-labelling cases first.
  //   TOAD plateau (the false alert this gate exists to kill, Aug 10-11) —
  //     ran to ~0.0137, chopped ~0.011-0.016 for ~20h, then went genuinely
  //     quiet (hourly vol $87-150K vs prior-run 6h windows over $6M — the
  //     relative volume-collapse gate flags this as dormancy). Plateau
  //     baseline ~0.0120 vs peak ~0.0164 → ~27% drawdown → BLOCKED. The
  //     breakout to 0.0215 was only ~1.7x above the plateau, so the run gate
  //     passed and the alert fired AT the all-time high.
  // 0.35 sits between TOAD's 27% and UP's 42% with roughly symmetric margin;
  // the drawdown of a consolidation is bounded by its own chop range, so the
  // separation is structural, not lucky.
  minDrawdownFromPeak: 0.35,
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
  /**
   * Pre-ignition price: median hourly close over the dormant window that
   * satisfied the dormancy gate. Null when no dormant window was found or it
   * contained no usable closes.
   */
  baselinePrice: number | null;
  /** price / baselinePrice — how far the token has ALREADY run. */
  runMultiple: number | null;
  /** False when runMultiple > cfg.maxRunFromBaseline (the "already ran" veto). */
  runGate: boolean;
  /**
   * Max hourly close over the dormancyPeakLookbackMs span PRECEDING the
   * dormant window. Null when no dormant window was found or the lookback
   * held no usable closes.
   */
  trailingPeakPrice: number | null;
  /**
   * 1 - baselinePrice / trailingPeakPrice — how far the token had DIED from
   * its trailing peak before going quiet. Negative when the dormant window
   * sits above the prior peak. Null when either side is unknown.
   */
  drawdownFromPeak: number | null;
  /**
   * False when drawdownFromPeak < cfg.minDrawdownFromPeak (the "never died"
   * veto). True (abstain) when drawdownFromPeak is null — missing data is not
   * evidence of a consolidation, and dormancy has already gated the signal;
   * the abstention is visible as trailingPeakPrice/drawdownFromPeak == null.
   */
  drawdownGate: boolean;
}

const NOT_FIRED_COLD: RevivalEvaluation = {
  fired: false,
  warmedUp: false,
  atrPct: null,
  atrZ: null,
  rvol: null,
  dormant: false,
  price: null,
  baselinePrice: null,
  runMultiple: null,
  runGate: false,
  trailingPeakPrice: null,
  drawdownFromPeak: null,
  drawdownGate: false,
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

/** The dormant stretch that satisfied the dormancy gate, as a half-open ms range. */
export interface DormancyWindow {
  /** Start of the first hour bucket in the window (inclusive), unix ms. */
  fromMs: number;
  /** End of the last hour bucket in the window (exclusive), unix ms. */
  toMs: number;
}

/**
 * Relative dormancy: at some evaluation point within the last
 * `dormancyRecentMs`, the trailing `dormancyWindowMs` of volume was
 * ≤ `dormancyCollapseRatio` × the peak same-size window over the prior
 * `dormancyPeakLookbackMs`. Evaluated on hourly buckets (missing hours = 0).
 * Requires a non-zero prior peak — a token that never traded is not "dormant",
 * it is dead, and must not trivially satisfy the gate.
 *
 * Returns the MOST RECENT qualifying window (evaluation walks now → now-2h and
 * stops at the first hit) so the baseline drawn from it is the freshest
 * pre-ignition state, not a stale one from further back.
 */
export function findRecentDormancy(
  hourCandles: Candle[],
  now: number,
  cfg: RevivalDetectorConfig = DEFAULT_REVIVAL_CONFIG,
): DormancyWindow | null {
  const sorted = sortValid(hourCandles);
  if (sorted.length === 0) return null;

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
    if (roll[i] <= cfg.dormancyCollapseRatio * peak) {
      return {
        fromMs: (startBucket + i - windowHours + 1) * HOUR_MS,
        toMs: (startBucket + i + 1) * HOUR_MS,
      };
    }
  }
  return null;
}

/** Boolean form of findRecentDormancy (the dormancy gate). */
export function isRecentlyDormant(
  hourCandles: Candle[],
  now: number,
  cfg: RevivalDetectorConfig = DEFAULT_REVIVAL_CONFIG,
): boolean {
  return findRecentDormancy(hourCandles, now, cfg) !== null;
}

/**
 * Pre-ignition baseline price: the MEDIAN hourly close inside the dormant
 * window.
 *
 * Median, deliberately, over the alternatives:
 * - a single candle (first/last close) is one print away from being wrong on a
 *   thin token, and the last close of the window is often already the first
 *   ignition candle;
 * - the mean is dragged upward by exactly those ignition hours — the newest
 *   qualifying window can legitimately overlap the start of the move, so the
 *   statistic has to tolerate a minority of hot candles;
 * - the min understates the baseline, which inflates the run multiple and
 *   would start vetoing genuine revivals.
 * The median tolerates up to half the window being ignition candles and is
 * unaffected by a single wick.
 *
 * Returns null when the window holds no usable closes — the caller must then
 * ABSTAIN (dormancy has already gated the signal) rather than veto blindly.
 */
export function resolveBaselinePrice(
  hourCandles: Candle[],
  window: DormancyWindow,
): number | null {
  const closes = sortValid(hourCandles)
    .filter((c) => c.ts >= window.fromMs && c.ts < window.toMs)
    .map((c) => c.close)
    .sort((a, b) => a - b);
  if (closes.length === 0) return null;
  const mid = closes.length >> 1;
  return closes.length % 2 === 1 ? closes[mid] : (closes[mid - 1] + closes[mid]) / 2;
}

/**
 * Trailing peak: the MAX hourly close over the `dormancyPeakLookbackMs` span
 * strictly BEFORE the dormant window. This is the price the token "died" from;
 * the drawdown gate compares the dormant window's baseline against it.
 *
 * The lookback reuses dormancyPeakLookbackMs on purpose (see the config doc):
 * the volume-collapse gate already defines the token's "prior life" as that
 * span, and the drawdown must be measured against the same era.
 *
 * Max, not median: a revival is measured from the top the token fell from —
 * a single-wick close can't inflate it because these are hourly CLOSES, and
 * understating the peak (mean/median would) shrinks real drawdowns and starts
 * vetoing genuine revivals.
 *
 * Returns null when the lookback holds no usable closes — the caller must
 * ABSTAIN (missing history is not evidence of a consolidation) while surfacing
 * the abstention on the verdict.
 */
export function resolveTrailingPeak(
  hourCandles: Candle[],
  window: DormancyWindow,
  cfg: RevivalDetectorConfig = DEFAULT_REVIVAL_CONFIG,
): number | null {
  const from = window.fromMs - cfg.dormancyPeakLookbackMs;
  let peak: number | null = null;
  for (const c of sortValid(hourCandles)) {
    if (c.ts < from || c.ts >= window.fromMs) continue;
    if (peak == null || c.close > peak) peak = c.close;
  }
  return peak;
}

/**
 * The full ATR-gate revival check. Fires only when ALL hold:
 *  1. warmup — ≥ warmupMs span of 1m history (and enough candles for ATR);
 *  2. ATR% expansion — z ≥ atrZThreshold vs trailing baseline, with an
 *     absolute atrPctFloor;
 *  3. RVOL — last-window volume ≥ rvolThreshold × trailing per-window average;
 *  4. relative dormancy within the recent window (see isRecentlyDormant);
 *  5. the run gate — price is still within maxRunFromBaseline × the dormant
 *     window's median close, i.e. the token has not ALREADY run;
 *  6. the drawdown gate — the dormant window's baseline sits at least
 *     minDrawdownFromPeak below the trailing peak, i.e. the token actually
 *     DIED before going quiet.
 *
 * Gate 5 exists because gates 2-4 all stay true deep into a move: the ATR% and
 * RVOL baselines are still averaging over the dormant period, and "was dormant
 * within the last 2h" slides forward with wall-clock time. Without it the
 * detector alerts later and higher the harder a token runs, which is precisely
 * backwards (observed in prod: TOAD alerted at $16-17M, ~600x off its
 * pre-ignition baseline).
 *
 * Gate 6 exists because dormancy measures VOLUME collapse only. A token
 * consolidating near its highs has volume collapse without drawdown; the quiet
 * plateau then becomes the baseline, a mere breakout reads as a small run
 * multiple, and every other gate passes — observed in prod the night after the
 * run gate shipped: TOAD alerted AGAIN at $20.6M, at its all-time high, off a
 * ~27%-below-peak plateau. A revival requires the token to have died first.
 *
 * Cooldowns and repeat suppression are the caller's job (poller state).
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
  const dormancyWindow = findRecentDormancy(hourCandles, now, cfg);
  const dormant = dormancyWindow !== null;

  // --- Gate 5: the run gate ("has it already run?") ---
  // Abstain (pass) when there is no baseline to compare against: an unknown
  // run multiple is not evidence of a run, and dormancy has already gated us.
  const baselinePrice =
    dormancyWindow != null ? resolveBaselinePrice(hourCandles, dormancyWindow) : null;
  const runMultiple =
    baselinePrice != null && baselinePrice > 0 ? price / baselinePrice : null;
  const runGate = runMultiple == null || runMultiple <= cfg.maxRunFromBaseline;

  // --- Gate 6: the drawdown gate ("did it actually die?") ---
  // Same abstention rule as the run gate: an unknowable trailing peak (or
  // baseline) is not evidence of a consolidation, so a null drawdown passes —
  // but the verdict records the abstention via the null fields.
  const trailingPeakPrice =
    dormancyWindow != null ? resolveTrailingPeak(hourCandles, dormancyWindow, cfg) : null;
  const drawdownFromPeak =
    baselinePrice != null && trailingPeakPrice != null && trailingPeakPrice > 0
      ? 1 - baselinePrice / trailingPeakPrice
      : null;
  const drawdownGate =
    drawdownFromPeak == null || drawdownFromPeak >= cfg.minDrawdownFromPeak;

  return {
    fired: atrGate && rvolGate && dormant && runGate && drawdownGate,
    warmedUp: true,
    atrPct: current.atrPct,
    atrZ,
    rvol,
    dormant,
    price,
    baselinePrice,
    runMultiple,
    runGate,
    trailingPeakPrice,
    drawdownFromPeak,
    drawdownGate,
  };
}
