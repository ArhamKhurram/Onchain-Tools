import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIVAL_CONFIG,
  computeAtrPctSeries,
  evaluateRevival,
  isRecentlyDormant,
  type Candle,
} from '../src/revival/detector.js';
import {
  buildUniverse,
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
