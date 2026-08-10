import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIVAL_CONFIG,
  computeAtrPctSeries,
  evaluateRevival,
  isRecentlyDormant,
  type Candle,
} from '../src/revival/detector.js';
import { buildUniverse } from '../src/revival/poller.js';

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
}

function hours(specs: HourSpec[]): Candle[] {
  const out: Candle[] = [];
  for (const s of specs) {
    for (let h = s.fromHour; h > s.toHour; h--) {
      const ts = NOW - h * HOUR;
      out.push({ ts, open: 1, high: 1, low: 1, close: 1, volume: s.volumePerHour });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** ~78h of hourly history: busy past, collapsed last 6h — classic fader. */
const FADED_HOURS = hours([
  { fromHour: 78, toHour: 8, volumePerHour: 50_000 },
  { fromHour: 8, toHour: 0, volumePerHour: 500 },
]);

/** Uniformly busy the whole time — never dormant. */
const ALWAYS_ACTIVE_HOURS = hours([{ fromHour: 78, toHour: 0, volumePerHour: 50_000 }]);

/** A big ignition burst in the last 5 minutes: wide candles, huge volume. */
function ignition(price: number): MinuteSpec {
  return { fromMin: 5, toMin: 0, price: price * 1.3, rangePct: 0.12, volumePerMin: 40_000 };
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
    const r = evaluateRevival(m, FADED_HOURS, NOW);
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

  it('caps tokens per user, keeping the most recent first', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      userId: 'u1',
      address: `Mint${i}`,
      timestamp: t(i),
    }));
    const u = buildUniverse(rows, 30);
    expect(u.size).toBe(30);
    expect([...u.keys()][0]).toBe('Mint0');
    expect(u.has('Mint30')).toBe(false);
  });

  it('dedupes mints across users and repeat mentions', () => {
    const u = buildUniverse([
      { userId: 'u1', address: 'MintA', timestamp: t(0) },
      { userId: 'u2', address: 'MintA', timestamp: t(1) },
      { userId: 'u1', address: 'MintA', timestamp: t(2) },
      { userId: 'u2', address: 'MintB', timestamp: t(3) },
    ]);
    expect(u.size).toBe(2);
    expect([...u.get('MintA')!]).toEqual(['u1', 'u2']);
    expect([...u.get('MintB')!]).toEqual(['u2']);
  });
});
