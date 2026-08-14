import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_POSITION_VALUE_USD,
  DEFAULT_VOLUME_DEATH_CONFIG,
  evaluateVolumeDeath,
  extractTokenVolumeSnapshot,
  isPositionWorthAlerting,
  shouldAlertVolumeDeath,
  type DexTokenPair,
} from '../src/journal/volumeDeath.js';

const MINT = 'TokenMintAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

describe('evaluateVolumeDeath', () => {
  it('does not fire on steady-state volume (both ratios ≈ 1)', () => {
    // 10k/h steady: m5 ≈ 833, h1 = 10k, h6 = 60k.
    const v = evaluateVolumeDeath({ m5: 833, h1: 10_000, h6: 60_000 });
    expect(v.m5RateVsH1).toBeCloseTo(1.0, 1);
    expect(v.h1RateVsH6).toBeCloseTo(1.0, 1);
    expect(v.dying).toBe(false);
  });

  it('fires when BOTH the m5-vs-h1 and h1-vs-h6 rates collapse below the ratio', () => {
    // Real collapse shape: h6 had 120k, the last hour only 4k, the last 5m 50.
    const v = evaluateVolumeDeath({ m5: 50, h1: 4_000, h6: 120_000 });
    expect(v.h1RateVsH6).toBeCloseTo((4_000 / 60) / (120_000 / 360), 6); // 0.2
    expect(v.m5RateVsH1).toBeCloseTo((50 / 5) / (4_000 / 60), 6); // 0.15
    expect(v.dying).toBe(true);
  });

  it('does NOT fire on a one-window blip (m5 quiet, h1 still healthy)', () => {
    // h1 rate matches h6 rate; only the last 5 minutes went quiet.
    const v = evaluateVolumeDeath({ m5: 100, h1: 20_000, h6: 120_000 });
    expect(v.h1RateVsH6).toBeCloseTo(1.0, 1);
    expect(v.dying).toBe(false);
  });

  it('does NOT fire when h1 collapsed but m5 shows volume returning', () => {
    const v = evaluateVolumeDeath({ m5: 500, h1: 4_000, h6: 120_000 });
    expect(v.m5RateVsH1).toBeCloseTo(1.5, 6);
    expect(v.dying).toBe(false);
  });

  it('abstains below the h6 volume floor (dead-on-arrival ≠ dying)', () => {
    const v = evaluateVolumeDeath({ m5: 0, h1: 10, h6: 400 });
    expect(v.dying).toBe(false);
    expect(v.m5RateVsH1).toBeNull();
    expect(v.h1RateVsH6).toBeNull();
  });

  it('treats zero h1 with a live h6 as total collapse', () => {
    const v = evaluateVolumeDeath({ m5: 0, h1: 0, h6: 60_000 });
    expect(v.m5RateVsH1).toBe(0);
    expect(v.h1RateVsH6).toBe(0);
    expect(v.dying).toBe(true);
  });

  it('respects a custom ratio', () => {
    const w = { m5: 250, h1: 6_000, h6: 60_000 }; // m5/h1 = 0.5, h1/h6 = 0.6
    expect(evaluateVolumeDeath(w, { ratio: 0.35, minH6VolumeUsd: 500 }).dying).toBe(false);
    expect(evaluateVolumeDeath(w, { ratio: 0.7, minH6VolumeUsd: 500 }).dying).toBe(true);
  });

  it('ships the calibrated defaults', () => {
    expect(DEFAULT_VOLUME_DEATH_CONFIG.ratio).toBe(0.35);
  });
});

describe('shouldAlertVolumeDeath (cooldown)', () => {
  const COOLDOWN = 1_800_000;
  const NOW = 10_000_000;

  it('alerts when never alerted before', () => {
    expect(shouldAlertVolumeDeath(null, NOW, COOLDOWN)).toBe(true);
    expect(shouldAlertVolumeDeath(undefined, NOW, COOLDOWN)).toBe(true);
  });

  it('suppresses inside the cooldown window', () => {
    expect(shouldAlertVolumeDeath(NOW - COOLDOWN + 1, NOW, COOLDOWN)).toBe(false);
    expect(shouldAlertVolumeDeath(NOW - 1, NOW, COOLDOWN)).toBe(false);
  });

  it('re-arms exactly at the cooldown boundary', () => {
    expect(shouldAlertVolumeDeath(NOW - COOLDOWN, NOW, COOLDOWN)).toBe(true);
  });
});

describe('isPositionWorthAlerting (dust gate)', () => {
  const MIN = 10;

  it('ships a $10 default floor', () => {
    expect(DEFAULT_MIN_POSITION_VALUE_USD).toBe(10);
    expect(isPositionWorthAlerting(9.99)).toBe(false);
    expect(isPositionWorthAlerting(10)).toBe(true);
  });

  it('skips a position below the threshold', () => {
    expect(isPositionWorthAlerting(0, MIN)).toBe(false);
    expect(isPositionWorthAlerting(0.004, MIN)).toBe(false); // the real $BOT bag
    expect(isPositionWorthAlerting(9.999999, MIN)).toBe(false);
  });

  it('alerts at and above the threshold', () => {
    expect(isPositionWorthAlerting(MIN, MIN)).toBe(true);
    expect(isPositionWorthAlerting(10.01, MIN)).toBe(true);
    expect(isPositionWorthAlerting(25_000, MIN)).toBe(true);
  });

  it('still alerts when the value is UNKNOWN — a data gap is not dust', () => {
    expect(isPositionWorthAlerting(null, MIN)).toBe(true);
    expect(isPositionWorthAlerting(undefined, MIN)).toBe(true);
    expect(isPositionWorthAlerting(Number.NaN, MIN)).toBe(true);
  });

  it('a threshold of 0 disables the gate', () => {
    expect(isPositionWorthAlerting(0, 0)).toBe(true);
  });
});

describe('dust gate ordering vs the cooldown', () => {
  const COOLDOWN = 1_800_000;
  const MIN = 10;

  /** The poller's per-holder decision, in the order volumeDeathPoller.ts uses. */
  function tryAlert(
    lastAlertAt: Map<string, number>,
    id: string,
    positionValueUsd: number | null,
    now: number,
  ): boolean {
    if (!isPositionWorthAlerting(positionValueUsd, MIN)) return false;
    if (!shouldAlertVolumeDeath(lastAlertAt.get(id), now, COOLDOWN)) return false;
    lastAlertAt.set(id, now);
    return true;
  }

  it('does not burn the cooldown slot on a dust-skipped position', () => {
    const lastAlertAt = new Map<string, number>();
    // Cycle 1: dust — skipped, and must NOT stamp the cooldown.
    expect(tryAlert(lastAlertAt, 'pos-1', 0.004, 1_000)).toBe(false);
    expect(lastAlertAt.has('pos-1')).toBe(false);
    // Cycle 2, three minutes later: the bag has real value again. Well inside
    // the 30-min window, so a burnt slot would have wrongly suppressed this.
    expect(tryAlert(lastAlertAt, 'pos-1', 250, 181_000)).toBe(true);
    expect(lastAlertAt.get('pos-1')).toBe(181_000);
  });

  it('still applies the cooldown to a real alert', () => {
    const lastAlertAt = new Map<string, number>();
    expect(tryAlert(lastAlertAt, 'pos-2', 250, 1_000)).toBe(true);
    expect(tryAlert(lastAlertAt, 'pos-2', 250, 1_000 + COOLDOWN - 1)).toBe(false);
    expect(tryAlert(lastAlertAt, 'pos-2', 250, 1_000 + COOLDOWN)).toBe(true);
  });
});

describe('extractTokenVolumeSnapshot', () => {
  // Real-shaped `/latest/dex/tokens/{mint}` pairs payload.
  const pairs: DexTokenPair[] = [
    {
      baseToken: { address: MINT, symbol: 'TOK' },
      liquidity: { usd: 250_000 },
      priceUsd: '0.0042',
      volume: { m5: 100, h1: 5_000, h6: 40_000, h24: 90_000 },
    },
    {
      baseToken: { address: MINT, symbol: 'TOK' },
      liquidity: { usd: 12_000 },
      priceUsd: '0.0041',
      volume: { m5: 10, h1: 500, h6: 2_000, h24: 5_000 },
    },
    {
      // The mint as QUOTE token elsewhere — must not count.
      baseToken: { address: 'OtherMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', symbol: 'OTHER' },
      liquidity: { usd: 999_999 },
      priceUsd: '1.00',
      volume: { m5: 99_999, h1: 99_999, h6: 99_999 },
    },
  ];

  it('sums volume across the token’s own pairs and prices from the deepest pool', () => {
    const snap = extractTokenVolumeSnapshot(pairs, MINT);
    expect(snap).not.toBeNull();
    expect(snap!.windows).toEqual({ m5: 110, h1: 5_500, h6: 42_000 });
    expect(snap!.priceUsd).toBeCloseTo(0.0042, 9);
    expect(snap!.symbol).toBe('TOK');
  });

  it('returns null when no pair matches the mint', () => {
    expect(extractTokenVolumeSnapshot(pairs, 'Nope1111111111111111111111111111111111111111')).toBeNull();
    expect(extractTokenVolumeSnapshot(null, MINT)).toBeNull();
    expect(extractTokenVolumeSnapshot([], MINT)).toBeNull();
  });

  it('tolerates pairs with missing volume/liquidity fields', () => {
    const sparse: DexTokenPair[] = [{ baseToken: { address: MINT, symbol: 'TOK' } }];
    const snap = extractTokenVolumeSnapshot(sparse, MINT);
    expect(snap!.windows).toEqual({ m5: 0, h1: 0, h6: 0 });
    expect(snap!.priceUsd).toBeNull();
  });
});
