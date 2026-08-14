import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIVAL_CONFIG,
  computeAtrPctSeries,
  evaluateRevival,
  isRecentlyDormant,
  resolveBaselinePrice,
  resolveTrailingPeak,
  type Candle,
} from '../src/revival/detector.js';
import {
  ALERT_COOLDOWN_MS,
  buildUniverse,
  evaluateRunSuppression,
  RUN_SUPPRESSION_CEILING_MS,
  selectCycleSlice,
  type UserContractRow,
} from '../src/revival/poller.js';
import type { RevivalNetwork } from '@oct/shared';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-08-10T12:00:00.000Z');

interface MinuteSpec {
  /** Offset range [fromMin, toMin) counted back from NOW (fromMin > toMin). */
  fromMin: number;
  toMin: number;
  price: number;
  /** Candle range as a fraction of price (high-low spread). */
  rangePct: number;
  volumePerMin: number;
  /** Emit only every Nth minute (sparse trading). Default 1. */
  every?: number;
}

/** Synthetic minute candles, oldest-first, ending at NOW - 1min. */
function minutes(specs: MinuteSpec[]): Candle[] {
  const out: Candle[] = [];
  for (const s of specs) {
    const every = s.every ?? 1;
    for (let m = s.fromMin; m > s.toMin; m--) {
      if ((s.fromMin - m) % every !== 0) continue;
      const ts = NOW - m * MINUTE;
      const half = (s.price * s.rangePct) / 2;
      out.push({
        ts,
        open: s.price,
        high: s.price + half,
        low: Math.max(s.price - half, s.price * 0.01),
        close: s.price,
        volume: s.volumePerMin * every,
      });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

interface HourSpec {
  /** Offset range [fromHour, toHour) counted back from NOW. */
  fromHour: number;
  toHour: number;
  volumePerHour: number;
  /** Hourly close. Defaults to 1 — the run gate reads these. */
  price?: number;
}

function hours(specs: HourSpec[]): Candle[] {
  const out: Candle[] = [];
  for (const s of specs) {
    const p = s.price ?? 1;
    for (let h = s.fromHour; h > s.toHour; h--) {
      const ts = NOW - h * HOUR;
      out.push({ ts, open: p, high: p, low: p, close: p, volume: s.volumePerHour });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * ~78h of hourly history: busy past at `peakPrice`, collapsed last 6h at
 * `price` — classic fader. `price` is the pre-ignition baseline the run gate
 * measures against; `peakPrice` is the trailing peak the DRAWDOWN gate
 * measures against (default 2× the baseline = a 50% drawdown, comfortably
 * revival-eligible — a token that died, not one consolidating at its highs).
 */
function fadedHours(price = 1, peakPrice = price * 2): Candle[] {
  return hours([
    { fromHour: 78, toHour: 8, volumePerHour: 50_000, price: peakPrice },
    { fromHour: 8, toHour: 0, volumePerHour: 500, price },
  ]);
}

const FADED_HOURS = fadedHours();

/** Uniformly busy the whole time — never dormant. */
const ALWAYS_ACTIVE_HOURS = hours([{ fromHour: 78, toHour: 0, volumePerHour: 50_000 }]);

/** A big ignition burst in the last 5 minutes: wide candles, huge volume. */
function ignition(price: number): MinuteSpec {
  return { fromMin: 5, toMin: 0, price: price * 1.3, rangePct: 0.12, volumePerMin: 40_000 };
}

/** Same burst, but landing at an exact price (for run-multiple calibration). */
function ignitionTo(price: number): MinuteSpec {
  return { fromMin: 5, toMin: 0, price, rangePct: 0.12, volumePerMin: 40_000 };
}

/**
 * A labeled true positive: ran to `priorPeak`, died back to `baseline`, went
 * dormant for 16h, then ignited to `trigger`. Used to prove the run and
 * drawdown gates keep the revivals we want.
 */
function labelledRevival(baseline: number, trigger: number, priorPeak = baseline * 2) {
  return {
    minute: minutes([
      { fromMin: 960, toMin: 5, price: baseline, rangePct: 0.001, volumePerMin: 10, every: 5 },
      ignitionTo(trigger),
    ]),
    hour: fadedHours(baseline, priorPeak),
  };
}

describe('evaluateRevival', () => {
  it('fires on a fader-then-ignition (dormant token igniting)', () => {
    // 16h of minute history: 6h of moderate action, then ~10h fading to
    // near-nothing (sparse — one candle every 5 minutes), then ignition.
    const m = minutes([
      { fromMin: 960, toMin: 600, price: 1.0, rangePct: 0.004, volumePerMin: 300 },
      { fromMin: 600, toMin: 5, price: 0.95, rangePct: 0.001, volumePerMin: 10, every: 5 },
      ignition(0.95),
    ]);
    const r = evaluateRevival(m, FADED_HOURS, NOW);
    expect(r.warmedUp).toBe(true);
    expect(r.dormant).toBe(true);
    expect(r.atrZ).not.toBeNull();
    expect(r.atrZ!).toBeGreaterThanOrEqual(DEFAULT_REVIVAL_CONFIG.atrZThreshold);
    expect(r.rvol).not.toBeNull();
    expect(r.rvol!).toBeGreaterThanOrEqual(DEFAULT_REVIVAL_CONFIG.rvolThreshold);
    expect(r.fired).toBe(true);
  });

  it('fires on a flatliner igniting (zero-variance ATR baseline must not divide by zero)', () => {
    // Perfectly flat price and identical candles for 16h — ATR% baseline has
    // zero variance — then ignition. Hourly history shows an old active period
    // so relative dormancy is establishable.
    const m = minutes([
      { fromMin: 960, toMin: 5, price: 2.0, rangePct: 0.0002, volumePerMin: 5 },
      ignition(2.0),
    ]);
    const r = evaluateRevival(m, fadedHours(2.0), NOW);
    expect(r.warmedUp).toBe(true);
    expect(r.dormant).toBe(true);
    expect(Number.isFinite(r.atrZ!)).toBe(true);
    expect(r.atrZ!).toBeGreaterThanOrEqual(DEFAULT_REVIVAL_CONFIG.atrZThreshold);
    expect(r.fired).toBe(true);
  });

  it('does NOT fire for an always-active token (dormancy precondition)', () => {
    // Same ignition shape, but the token never went quiet: trailing 6h volume
    // sits at its historical norm, so the relative-dormancy gate must hold it.
    const m = minutes([
      { fromMin: 960, toMin: 5, price: 1.0, rangePct: 0.004, volumePerMin: 800 },
      ignition(1.0),
    ]);
    const r = evaluateRevival(m, ALWAYS_ACTIVE_HOURS, NOW);
    expect(r.warmedUp).toBe(true);
    expect(r.dormant).toBe(false);
    expect(r.fired).toBe(false);
  });

  it('does NOT fire before 6h of history (warmup)', () => {
    // Only ~2h of minute candles, ending in the same ignition.
    const m = minutes([
      { fromMin: 120, toMin: 5, price: 1.0, rangePct: 0.001, volumePerMin: 10 },
      ignition(1.0),
    ]);
    const r = evaluateRevival(m, FADED_HOURS, NOW);
    expect(r.warmedUp).toBe(false);
    expect(r.fired).toBe(false);
  });

  it('handles empty input without exploding', () => {
    const r = evaluateRevival([], [], NOW);
    expect(r.fired).toBe(false);
    expect(r.warmedUp).toBe(false);
    expect(r.price).toBeNull();
  });

  it('never-traded tokens are dead, not dormant (zero prior peak)', () => {
    const dead = hours([{ fromHour: 78, toHour: 0, volumePerHour: 0 }]);
    expect(isRecentlyDormant(dead, NOW)).toBe(false);
  });
});

/**
 * The run gate. These four cases are the calibration record for
 * maxRunFromBaseline; changing that default means re-running them, not
 * adjusting them.
 */
describe('evaluateRevival — the run gate ("has it already run?")', () => {
  it('REGRESSION (TOAD): does NOT fire mid-run, even though ATR-z, RVOL and recent-dormancy all pass', () => {
    // The exact prod failure. TOAD alerted at $16-17M after running ~600x off
    // a ~$25K baseline, because every OTHER gate stays satisfied deep into a
    // run: the ATR%/RVOL baselines still average over the dormant period, and
    // "was dormant within the last 2h" slides forward with wall-clock time.
    //
    // Built as the WORST case on purpose — the run's own volume is kept low
    // enough that the dormancy gate still holds, so nothing but the run gate
    // can save us.
    const baseline = 0.0001;
    const runPrice = 0.06; // 600× the baseline

    const hourCandles = hours([
      // Active era at 4× the dormant baseline (75% drawdown): the drawdown
      // gate is satisfied on purpose so the run gate stays the ONLY blocker.
      { fromHour: 78, toHour: 8, volumePerHour: 50_000, price: baseline * 4 },
      // Still-dormant hours at the old price…
      { fromHour: 8, toHour: 2, volumePerHour: 500, price: baseline },
      // …then two hours of run. The newest qualifying dormant window spans the
      // last 6h, so it straddles the ignition — which is exactly why the
      // baseline statistic is a MEDIAN (4 quiet hours outvote 2 hot ones).
      { fromHour: 2, toHour: 0, volumePerHour: 12_000, price: 0.05 },
    ]);
    const m = minutes([
      { fromMin: 960, toMin: 120, price: baseline, rangePct: 0.001, volumePerMin: 5 },
      // Stair-step run: price is up 500× but each minute candle is tight, so
      // ATR% is still depressed and a fresh burst reads as a huge expansion.
      { fromMin: 120, toMin: 5, price: 0.05, rangePct: 0.0005, volumePerMin: 200 },
      ignitionTo(runPrice),
    ]);

    const r = evaluateRevival(m, hourCandles, NOW);

    // Every legacy gate passes — this is the whole point of the case.
    expect(r.warmedUp).toBe(true);
    expect(r.dormant).toBe(true);
    expect(r.atrZ!).toBeGreaterThanOrEqual(DEFAULT_REVIVAL_CONFIG.atrZThreshold);
    expect(r.rvol!).toBeGreaterThanOrEqual(DEFAULT_REVIVAL_CONFIG.rvolThreshold);
    expect(r.drawdownGate).toBe(true); // 75% drawdown — a genuine prior death

    // …and the run gate is the only thing holding it.
    expect(r.baselinePrice).toBeCloseTo(baseline, 10);
    expect(r.runMultiple!).toBeGreaterThan(100);
    expect(r.runGate).toBe(false);
    expect(r.fired).toBe(false);
  });

  it('MANLET-shaped (~2.0× above baseline, ~70% drawdown) MUST still fire — the binding lower constraint', () => {
    // Solana, Aug 10. Ran to ~0.0009, died to hourly closes ~0.00027; the good
    // trigger was at ~0.000543. Anyone tempted to tighten maxRunFromBaseline
    // to 1.5× would start dropping real revivals — this test is the tripwire.
    const { minute, hour } = labelledRevival(0.00027, 0.000543, 0.0009);
    const r = evaluateRevival(minute, hour, NOW);

    expect(r.baselinePrice).toBeCloseTo(0.00027, 10);
    expect(r.runMultiple!).toBeGreaterThan(1.9);
    expect(r.runMultiple!).toBeLessThan(2.1);
    expect(r.runGate).toBe(true);
    expect(r.drawdownFromPeak!).toBeCloseTo(0.7, 2);
    expect(r.drawdownGate).toBe(true);
    expect(r.fired).toBe(true);
  });

  it('UP-shaped (~1.2× above baseline, ~42% drawdown) MUST still fire — the binding UPPER drawdown constraint', () => {
    // Robinhood. Peak ~0.133, baseline ~0.077-0.08, trigger ~0.0959. At ~42%
    // drawdown this is the shallowest labeled true positive: pushing
    // minDrawdownFromPeak past ~40% starts killing real revivals — this test
    // is the tripwire on the drawdown side.
    const { minute, hour } = labelledRevival(0.078, 0.0959, 0.133);
    const r = evaluateRevival(minute, hour, NOW);

    expect(r.runMultiple!).toBeGreaterThan(1.15);
    expect(r.runMultiple!).toBeLessThan(1.3);
    expect(r.runGate).toBe(true);
    expect(r.drawdownFromPeak!).toBeGreaterThan(0.4);
    expect(r.drawdownFromPeak!).toBeLessThan(0.43);
    expect(r.drawdownGate).toBe(true);
    expect(r.fired).toBe(true);
  });

  it('separates all three labeled cases at the default threshold', () => {
    // The calibration itself, asserted rather than left in a comment.
    const manletCase = labelledRevival(0.00027, 0.000543, 0.0009);
    const upCase = labelledRevival(0.078, 0.0959, 0.133);
    const manlet = evaluateRevival(manletCase.minute, manletCase.hour, NOW);
    const up = evaluateRevival(upCase.minute, upCase.hour, NOW);
    const threshold = DEFAULT_REVIVAL_CONFIG.maxRunFromBaseline;

    expect(threshold).toBeGreaterThan(manlet.runMultiple!); // MANLET survives
    expect(threshold).toBeGreaterThan(up.runMultiple!); // UP survives
    expect(threshold).toBeLessThan(600); // TOAD does not
  });

  it('abstains rather than vetoing when no baseline can be established', () => {
    // Hourly candles with no usable closes inside the dormant window: unknown
    // is not evidence of a run, and dormancy has already gated the signal.
    const m = minutes([
      { fromMin: 960, toMin: 600, price: 1.0, rangePct: 0.004, volumePerMin: 300 },
      { fromMin: 600, toMin: 5, price: 0.95, rangePct: 0.001, volumePerMin: 10, every: 5 },
      ignition(0.95),
    ]);
    // Drop every hour candle inside the trailing 6h window; dormancy still
    // holds (missing buckets count as zero volume) but there is no close.
    const sparse = FADED_HOURS.filter((c) => c.ts < NOW - 6 * HOUR);
    const r = evaluateRevival(m, sparse, NOW);

    expect(r.dormant).toBe(true);
    expect(r.baselinePrice).toBeNull();
    expect(r.runMultiple).toBeNull();
    expect(r.runGate).toBe(true);
    // The drawdown gate abstains the same way — the trailing peak is known
    // but a drawdown vs a missing baseline is not, and the abstention is
    // recorded on the verdict rather than silently vetoing (or passing).
    expect(r.trailingPeakPrice).toBe(2);
    expect(r.drawdownFromPeak).toBeNull();
    expect(r.drawdownGate).toBe(true);
    expect(r.fired).toBe(true);
  });
});

/**
 * The drawdown gate. Dormancy measures VOLUME collapse only; this gate is the
 * "did it actually die?" precondition. Calibration: MANLET ~70% and UP ~42%
 * (both asserted in the run-gate suite above) pass; UP binds the upper limit.
 */
describe('evaluateRevival — the drawdown gate ("did it actually die?")', () => {
  it('REGRESSION (TOAD plateau): consolidation at the highs does NOT fire — the drawdown gate is the ONLY blocker', () => {
    // The prod failure of Aug 11, the night after the run gate shipped. TOAD
    // ran to ~0.0137, chopped ~0.011-0.016 for ~20h on heavy volume, then had
    // a genuinely quiet spell (hourly vol $87-150K vs prior-run 6h windows
    // over $6M — the RELATIVE volume-collapse gate flags that as dormancy).
    // The quiet plateau became the baseline, so the 0.0215 breakout read as a
    // mere ~1.7x "run" and the 3.0x run gate waved it through: the alert
    // fired at $20.6M — the all-time high. A consolidation near the highs has
    // volume collapse WITHOUT drawdown; that shape is a continuation
    // breakout, not a revival.
    const plateau = 0.012;
    const chopHigh = 0.0164;
    const breakout = 0.0215;

    const hourCandles = hours([
      // The run up.
      { fromHour: 78, toHour: 28, volumePerHour: 800_000, price: 0.0137 },
      // ~20h of chop near the highs, still heavy (~$6M per 6h window).
      { fromHour: 28, toHour: 8, volumePerHour: 1_000_000, price: chopHigh },
      // The quiet plateau — volume collapsed, price did NOT.
      { fromHour: 8, toHour: 0, volumePerHour: 120_000, price: plateau },
    ]);
    const m = minutes([
      { fromMin: 960, toMin: 5, price: plateau, rangePct: 0.001, volumePerMin: 10, every: 5 },
      ignitionTo(breakout),
    ]);

    const r = evaluateRevival(m, hourCandles, NOW);

    // Every other gate passes — the point of the case.
    expect(r.warmedUp).toBe(true);
    expect(r.dormant).toBe(true); // volume collapse alone flags dormancy
    expect(r.atrZ!).toBeGreaterThanOrEqual(DEFAULT_REVIVAL_CONFIG.atrZThreshold);
    expect(r.rvol!).toBeGreaterThanOrEqual(DEFAULT_REVIVAL_CONFIG.rvolThreshold);
    expect(r.baselinePrice).toBeCloseTo(plateau, 10);
    expect(r.runMultiple!).toBeGreaterThan(1.6);
    expect(r.runMultiple!).toBeLessThan(1.9);
    expect(r.runGate).toBe(true); // the bug: the breakout reads as a small run

    // …and the drawdown gate is the only thing holding it.
    expect(r.trailingPeakPrice).toBeCloseTo(chopHigh, 10);
    expect(r.drawdownFromPeak!).toBeCloseTo(1 - plateau / chopHigh, 3); // ~27%
    expect(r.drawdownFromPeak!).toBeLessThan(DEFAULT_REVIVAL_CONFIG.minDrawdownFromPeak);
    expect(r.drawdownGate).toBe(false);
    expect(r.fired).toBe(false);
  });
});

describe('resolveTrailingPeak', () => {
  it('takes the max hourly close over the lookback PRECEDING the window', () => {
    const window = { fromMs: NOW - 6 * HOUR, toMs: NOW };
    const candles = hours([
      { fromHour: 78, toHour: 30, volumePerHour: 100, price: 0.9 },
      { fromHour: 30, toHour: 6, volumePerHour: 100, price: 2 },
      // Inside the window — a high close here must NOT count as the peak the
      // token "died from".
      { fromHour: 6, toHour: 0, volumePerHour: 100, price: 5 },
    ]);
    expect(resolveTrailingPeak(candles, window)).toBe(2);
  });

  it('returns null when the lookback holds no usable closes (abstain upstream)', () => {
    const window = { fromMs: NOW - 6 * HOUR, toMs: NOW };
    const onlyInsideWindow = hours([{ fromHour: 6, toHour: 0, volumePerHour: 100, price: 5 }]);
    expect(resolveTrailingPeak(onlyInsideWindow, window)).toBeNull();
    expect(resolveTrailingPeak([], window)).toBeNull();
  });
});

describe('resolveBaselinePrice', () => {
  it('is unmoved by a minority of ignition candles inside the window', () => {
    const window = { fromMs: NOW - 6 * HOUR, toMs: NOW };
    const candles = hours([
      { fromHour: 6, toHour: 2, volumePerHour: 100, price: 0.001 },
      { fromHour: 2, toHour: 0, volumePerHour: 100, price: 10 },
    ]);
    // The mean would be ~3.33 here; the median holds the pre-ignition level.
    expect(resolveBaselinePrice(candles, window)).toBeCloseTo(0.001, 10);
  });

  it('returns null when the window holds no candles', () => {
    expect(resolveBaselinePrice(FADED_HOURS, { fromMs: NOW + HOUR, toMs: NOW + 2 * HOUR })).toBeNull();
  });
});

/**
 * Repeat-alert suppression. The old 60-min cooldown let a 6h run alert six
 * times, each later and higher; what ends an alert's validity is the token
 * leaving the run state, not elapsed time.
 */
describe('evaluateRunSuppression', () => {
  const running = { dormant: true, runMultiple: 2.4, drawdownFromPeak: 0.5 };
  /** Crashed back down (≥35% off the trailing peak) AND went quiet again. */
  const backToBaseline = { dormant: true, runMultiple: 1.05, drawdownFromPeak: 0.6 };
  /** Went quiet AT the top: volume-only "dormancy", price never died. */
  const plateauAtTop = { dormant: true, runMultiple: 1.05, drawdownFromPeak: 0.15 };

  it('lets a first-ever ignition through', () => {
    expect(evaluateRunSuppression(undefined, running, NOW).suppress).toBe(false);
  });

  it('suppresses a second qualifying trigger during the SAME run', () => {
    // 90 minutes later — past the old cooldown, so the pre-fix code would have
    // fired again, higher. The token never left the run.
    const prior = { alertedAt: NOW - 90 * MINUTE };
    const d = evaluateRunSuppression(prior, running, NOW);
    expect(d.suppress).toBe(true);
    expect(d.reason).toBe('run-in-progress');
  });

  it('keeps the short cooldown as a floor', () => {
    const prior = { alertedAt: NOW - ALERT_COOLDOWN_MS / 2 };
    const d = evaluateRunSuppression(prior, backToBaseline, NOW);
    expect(d.suppress).toBe(true);
    expect(d.reason).toBe('cooldown');
  });

  it('allows a new alert after a genuine return to dormancy', () => {
    const prior = { alertedAt: NOW - 5 * HOUR };
    expect(evaluateRunSuppression(prior, backToBaseline, NOW).suppress).toBe(false);
  });

  it('will not re-open on an unknown baseline', () => {
    const prior = { alertedAt: NOW - 5 * HOUR };
    const d = evaluateRunSuppression(
      prior,
      { dormant: true, runMultiple: null, drawdownFromPeak: null },
      NOW,
    );
    expect(d.suppress).toBe(true);
    expect(d.reason).toBe('unknown-baseline');
  });

  it('a post-alert plateau at the top does NOT re-arm — quiet is not dead', () => {
    // The token alerted, ran, then went quiet near its highs. Volume-only
    // dormancy plus a near-1x multiple vs the NEW (plateau) baseline would
    // have re-armed it for exactly the consolidation-breakout false alert the
    // detector's drawdown gate blocks (TOAD, Aug 11). The suppression's
    // "returned to dormancy" check must demand the same drawdown.
    const prior = { alertedAt: NOW - 5 * HOUR };
    const d = evaluateRunSuppression(prior, plateauAtTop, NOW);
    expect(d.suppress).toBe(true);
    expect(d.reason).toBe('no-drawdown');
  });

  it('a genuine crash back down (drawdown + volume collapse) DOES re-arm', () => {
    const prior = { alertedAt: NOW - 5 * HOUR };
    expect(evaluateRunSuppression(prior, backToBaseline, NOW).suppress).toBe(false);
  });

  it('will not re-open on an unknown drawdown', () => {
    // Same rule as the unknown baseline: the detector abstains from vetoing
    // on missing data, but "we cannot tell" must not re-open the loudest
    // alert in the app.
    const prior = { alertedAt: NOW - 5 * HOUR };
    const d = evaluateRunSuppression(
      prior,
      { dormant: true, runMultiple: 1.05, drawdownFromPeak: null },
      NOW,
    );
    expect(d.suppress).toBe(true);
    expect(d.reason).toBe('unknown-drawdown');
  });

  it('lapses at the absolute ceiling however the token is behaving', () => {
    const prior = { alertedAt: NOW - RUN_SUPPRESSION_CEILING_MS - MINUTE };
    expect(evaluateRunSuppression(prior, running, NOW).suppress).toBe(false);
  });

  it('full sequence: alert → suppressed through the run AND the top plateau → alert again after a real crash', () => {
    let state: { alertedAt: number } | undefined;
    const fire = (
      at: number,
      verdict: { dormant: boolean; runMultiple: number | null; drawdownFromPeak: number | null },
    ) => {
      if (evaluateRunSuppression(state, verdict, at).suppress) return false;
      state = { alertedAt: at };
      return true;
    };

    expect(fire(NOW, { dormant: true, runMultiple: 1.1, drawdownFromPeak: 0.55 })).toBe(true);
    // The run continues; every detector gate keeps passing for hours.
    expect(fire(NOW + 70 * MINUTE, running)).toBe(false);
    expect(fire(NOW + 3 * HOUR, running)).toBe(false);
    // It stalls near the top: quiet, near the fresh plateau baseline — but it
    // never died, so it stays suppressed.
    expect(fire(NOW + 5 * HOUR, plateauAtTop)).toBe(false);
    // It finally crashes back down and goes quiet again — that is a new setup.
    expect(fire(NOW + 8 * HOUR, backToBaseline)).toBe(true);
  });
});

describe('computeAtrPctSeries', () => {
  it('returns empty for fewer candles than period + 1', () => {
    const m = minutes([{ fromMin: 10, toMin: 0, price: 1, rangePct: 0.01, volumePerMin: 1 }]);
    expect(computeAtrPctSeries(m, 14)).toEqual([]);
  });

  it('tracks the true range through sparse gaps without NaN', () => {
    const m = minutes([
      { fromMin: 200, toMin: 100, price: 1, rangePct: 0.01, volumePerMin: 1, every: 7 },
      { fromMin: 100, toMin: 0, price: 1.2, rangePct: 0.02, volumePerMin: 1, every: 3 },
    ]);
    const series = computeAtrPctSeries(m, 14);
    expect(series.length).toBeGreaterThan(0);
    for (const p of series) {
      expect(Number.isFinite(p.atrPct)).toBe(true);
      expect(p.atrPct).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('buildUniverse', () => {
  const t = (i: number) => new Date(NOW - i * MINUTE).toISOString();
  const sol = (userId: string, address: string, i: number): UserContractRow => ({
    userId,
    address,
    network: 'solana',
    timestamp: t(i),
  });

  it('caps tokens per user, keeping the most recent first', () => {
    const rows = Array.from({ length: 40 }, (_, i) => sol('u1', `Mint${i}`, i));
    const u = buildUniverse(rows, 30);
    expect(u.size).toBe(30);
    expect([...u.keys()][0]).toBe('solana:Mint0');
    expect(u.has('solana:Mint30')).toBe(false);
  });

  it('dedupes tokens across users and repeat mentions', () => {
    const u = buildUniverse([
      sol('u1', 'MintA', 0),
      sol('u2', 'MintA', 1),
      sol('u1', 'MintA', 2),
      sol('u2', 'MintB', 3),
    ]);
    expect(u.size).toBe(2);
    expect([...u.get('solana:MintA')!.subscribers]).toEqual(['u1', 'u2']);
    expect([...u.get('solana:MintB')!.subscribers]).toEqual(['u2']);
  });

  it('keys by network — the same address on two chains is two tokens', () => {
    const addr = '0x57c0e45cb534413d1c20a4240955d6bb250bb4f1';
    const u = buildUniverse([
      { userId: 'u1', address: addr, network: 'robinhood', timestamp: t(0) },
      { userId: 'u1', address: addr, network: 'bsc', timestamp: t(1) },
    ]);
    expect(u.size).toBe(2);
    expect(u.get('robinhood:' + addr)?.network).toBe('robinhood');
    expect(u.get('bsc:' + addr)?.network).toBe('bsc');
  });

  it('does not let a busy chain starve a quiet one at the per-user cap', () => {
    // The real shape of an OCT feed: a flood of Solana, a trickle of EVM.
    // Straight recency ordering would fill all 30 slots with Solana and the UP
    // (Robinhood) revival could never enter the universe.
    const rows: UserContractRow[] = [];
    for (let i = 0; i < 200; i++) rows.push(sol('u1', `SolMint${i}`, i));
    rows.push({ userId: 'u1', address: 'HoodA', network: 'robinhood', timestamp: t(500) });
    rows.push({ userId: 'u1', address: 'HoodB', network: 'robinhood', timestamp: t(501) });
    rows.push({ userId: 'u1', address: 'BnbA', network: 'bsc', timestamp: t(502) });
    rows.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

    const u = buildUniverse(rows, 30);
    expect(u.size).toBe(30);
    const networks = [...u.values()].map((e) => e.network);
    expect(networks.filter((n) => n === 'robinhood')).toHaveLength(2);
    expect(networks.filter((n) => n === 'bsc')).toHaveLength(1);
    // The busy chain still absorbs every slot the quiet ones leave unused.
    expect(networks.filter((n) => n === 'solana')).toHaveLength(27);
  });

  it('splits the cap evenly when every chain is busy', () => {
    const rows: UserContractRow[] = [];
    for (let i = 0; i < 50; i++) {
      rows.push(sol('u1', `SolMint${i}`, i));
      rows.push({ userId: 'u1', address: `Bnb${i}`, network: 'bsc', timestamp: t(i) });
      rows.push({ userId: 'u1', address: `Hood${i}`, network: 'robinhood', timestamp: t(i) });
    }
    const u = buildUniverse(rows, 30);
    const counts = new Map<string, number>();
    for (const e of u.values()) counts.set(e.network, (counts.get(e.network) ?? 0) + 1);
    expect(counts.get('solana')).toBe(10);
    expect(counts.get('bsc')).toBe(10);
    expect(counts.get('robinhood')).toBe(10);
  });

  it('applies the cap per user, not globally', () => {
    const u = buildUniverse([sol('u1', 'MintA', 0), sol('u2', 'MintB', 1)], 1);
    expect(u.size).toBe(2);
  });
});

describe('selectCycleSlice', () => {
  const rot = (network: RevivalNetwork, n: number, offset = 0, prefix = network) => ({
    network,
    keys: Array.from({ length: n }, (_, i) => `${prefix}:${i}`),
    offset,
  });

  it('interleaves chains so a big universe cannot consume the whole cycle', () => {
    const { selected } = selectCycleSlice([rot('solana', 500), rot('robinhood', 3)], 10);
    expect(selected).toHaveLength(10);
    expect(selected.filter((k) => k.startsWith('robinhood'))).toHaveLength(3);
    // The quiet chain is served in the first rounds, not stranded at the end.
    expect(selected.slice(0, 6).filter((k) => k.startsWith('robinhood'))).toHaveLength(3);
  });

  it('gives the leftover budget to whichever chain still has tokens', () => {
    const { selected } = selectCycleSlice([rot('solana', 100), rot('bsc', 2)], 10);
    expect(selected.filter((k) => k.startsWith('bsc'))).toHaveLength(2);
    expect(selected.filter((k) => k.startsWith('solana'))).toHaveLength(8);
  });

  it('advances each chain’s own pointer so every chain is swept fully', () => {
    const solanaKeys = rot('solana', 10);
    const bscKeys = rot('bsc', 4);

    const first = selectCycleSlice([solanaKeys, bscKeys], 6);
    const second = selectCycleSlice(
      [
        { ...solanaKeys, offset: first.offsets.get('solana')! },
        { ...bscKeys, offset: first.offsets.get('bsc')! },
      ],
      6,
    );
    const seen = [...first.selected, ...second.selected];
    // Each chain walks its OWN list: no Solana token repeats while 4 unseen
    // ones remain, and the short BSC list is covered end to end (then wraps,
    // which is the point — a 4-token chain gets rechecked more often).
    const seenSol = seen.filter((k) => k.startsWith('solana'));
    expect(new Set(seenSol).size).toBe(seenSol.length);
    expect(new Set(seen.filter((k) => k.startsWith('bsc'))).size).toBe(4);
  });

  it('wraps a chain’s pointer back to the start', () => {
    const { selected, offsets } = selectCycleSlice([rot('bsc', 3, 2)], 3);
    expect(selected).toEqual(['bsc:2', 'bsc:0', 'bsc:1']);
    expect(offsets.get('bsc')).toBe(2);
  });

  it('handles an empty universe and empty chains', () => {
    expect(selectCycleSlice([], 10).selected).toEqual([]);
    expect(selectCycleSlice([rot('bsc', 0)], 10).selected).toEqual([]);
  });
});
