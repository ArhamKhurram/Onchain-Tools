import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIVAL_CONFIG,
  evaluateRevival,
  type Candle,
} from '../src/revival/detector.js';
import {
  ALERT_COOLDOWN_MS,
  evaluateRunSuppression,
  formatCycleSummary,
  isBreakoutEnabled,
  shouldSkipCandleFetch,
  summarizeCycle,
  suppressionKey,
  type RunSuppression,
} from '../src/revival/poller.js';
import { buildAlertEntry } from '../src/revival/outcomeTracker.js';
import { RevivalAlertsRepo } from '../src/storage/supabase/revivalAlertsRepo.js';
import type { SupabaseContext } from '../src/storage/supabase/client.js';
import type { RevivalAlertEntry } from '@oct/shared';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-08-10T12:00:00.000Z');

// --- Fixture builders (mirrors revivalDetector.test.ts) ---------------------

interface MinuteSpec {
  fromMin: number;
  toMin: number;
  price: number;
  rangePct: number;
  volumePerMin: number;
  every?: number;
}

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
  fromHour: number;
  toHour: number;
  volumePerHour: number;
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

function ignitionTo(price: number): MinuteSpec {
  return { fromMin: 5, toMin: 0, price, rangePct: 0.12, volumePerMin: 40_000 };
}

/**
 * The TOAD plateau (Aug 10-11): ran, chopped ~20h near the highs on heavy
 * volume, went genuinely quiet WITHOUT drawing down (~27% off peak), then
 * broke out. Revival's drawdown gate correctly rejects it; it is the labeled
 * true positive for BREAKOUT.
 */
function toadPlateau() {
  const plateau = 0.012;
  const chopHigh = 0.0164;
  const breakout = 0.0215;
  return {
    plateau,
    chopHigh,
    minute: minutes([
      { fromMin: 960, toMin: 5, price: plateau, rangePct: 0.001, volumePerMin: 10, every: 5 },
      ignitionTo(breakout),
    ]),
    hour: hours([
      { fromHour: 78, toHour: 28, volumePerHour: 800_000, price: 0.0137 },
      { fromHour: 28, toHour: 8, volumePerHour: 1_000_000, price: chopHigh },
      { fromHour: 8, toHour: 0, volumePerHour: 120_000, price: plateau },
    ]),
  };
}

/** A labeled deep-drawdown revival (MANLET-shaped: ~70% drawdown, ~2.0x run). */
function deepDrawdownRevival() {
  const baseline = 0.00027;
  return {
    minute: minutes([
      { fromMin: 960, toMin: 5, price: baseline, rangePct: 0.001, volumePerMin: 10, every: 5 },
      ignitionTo(0.000543),
    ]),
    hour: hours([
      { fromHour: 78, toHour: 8, volumePerHour: 50_000, price: 0.0009 },
      { fromHour: 8, toHour: 0, volumePerHour: 500, price: baseline },
    ]),
  };
}

// --- Detector: the breakout verdict ----------------------------------------

describe('evaluateRevival — breakout sibling verdict', () => {
  it('TOAD plateau: breakout fires where revival correctly stays silent', () => {
    const { minute, hour, plateau, chopHigh } = toadPlateau();
    const r = evaluateRevival(minute, hour, NOW);

    // Every revival gate passes except drawdown — the breakout signature.
    expect(r.warmedUp).toBe(true);
    expect(r.dormant).toBe(true);
    expect(r.atrZ!).toBeGreaterThanOrEqual(DEFAULT_REVIVAL_CONFIG.atrZThreshold);
    expect(r.rvol!).toBeGreaterThanOrEqual(DEFAULT_REVIVAL_CONFIG.rvolThreshold);
    expect(r.runGate).toBe(true);
    expect(r.drawdownFromPeak!).toBeCloseTo(1 - plateau / chopHigh, 3); // ~27%
    expect(r.drawdownGate).toBe(false);

    expect(r.fired).toBe(false);
    expect(r.breakoutFired).toBe(true);
  });

  it('deep-drawdown revival: revival fires, breakout stays silent', () => {
    const { minute, hour } = deepDrawdownRevival();
    const r = evaluateRevival(minute, hour, NOW);

    expect(r.drawdownFromPeak!).toBeCloseTo(0.7, 2);
    expect(r.fired).toBe(true);
    expect(r.breakoutFired).toBe(false);
  });

  it('a token failing RVOL fires neither signal', () => {
    // TOAD's shape but the "ignition" carries no volume: wide candles (ATR
    // still expands) at the plateau's own trickle of volume.
    const { hour, plateau } = toadPlateau();
    const m = minutes([
      { fromMin: 960, toMin: 5, price: plateau, rangePct: 0.001, volumePerMin: 10, every: 5 },
      { fromMin: 5, toMin: 0, price: 0.0215, rangePct: 0.12, volumePerMin: 10 },
    ]);
    const r = evaluateRevival(m, hour, NOW);

    expect(r.rvol!).toBeLessThan(DEFAULT_REVIVAL_CONFIG.rvolThreshold);
    expect(r.fired).toBe(false);
    expect(r.breakoutFired).toBe(false);
  });

  it('the two verdicts are mutually exclusive on every labeled fixture', () => {
    for (const { minute, hour } of [toadPlateau(), deepDrawdownRevival()]) {
      const r = evaluateRevival(minute, hour, NOW);
      expect(r.fired && r.breakoutFired).toBe(false);
    }
  });

  it('a null drawdown (abstention) never fires breakout — missing data is not a consolidation', () => {
    // Sparse hourly history: dormancy holds (missing buckets are zero volume)
    // but the dormant window holds no closes, so drawdown is unknowable. The
    // drawdown gate abstains (revival may fire); breakout must NOT.
    const m = minutes([
      { fromMin: 960, toMin: 600, price: 1.0, rangePct: 0.004, volumePerMin: 300 },
      { fromMin: 600, toMin: 5, price: 0.95, rangePct: 0.001, volumePerMin: 10, every: 5 },
      { fromMin: 5, toMin: 0, price: 0.95 * 1.3, rangePct: 0.12, volumePerMin: 40_000 },
    ]);
    const sparse = hours([
      { fromHour: 78, toHour: 8, volumePerHour: 50_000, price: 2 },
      { fromHour: 8, toHour: 0, volumePerHour: 500, price: 1 },
    ]).filter((c) => c.ts < NOW - 6 * HOUR);
    const r = evaluateRevival(m, sparse, NOW);

    expect(r.drawdownFromPeak).toBeNull();
    expect(r.fired).toBe(true); // the abstention passes revival, as before
    expect(r.breakoutFired).toBe(false);
  });

  it('the drawdown floor excludes a dormant window sitting ABOVE the prior era (negative drawdown) by default', () => {
    // Quiet stretch at 2x every close in the trailing lookback → drawdown -1.
    // Kept to 5 hours so it sits ENTIRELY inside the 6h dormancy window —
    // any quiet hour spilling before the window would become the "trailing
    // peak" at the same price and read as a 0% drawdown instead.
    const hourCandles = hours([
      { fromHour: 78, toHour: 5, volumePerHour: 50_000, price: 1 },
      { fromHour: 5, toHour: 0, volumePerHour: 500, price: 2 },
    ]);
    const m = minutes([
      { fromMin: 960, toMin: 5, price: 2, rangePct: 0.001, volumePerMin: 10, every: 5 },
      ignitionTo(2.4),
    ]);

    const r = evaluateRevival(m, hourCandles, NOW);
    expect(r.drawdownFromPeak!).toBeLessThan(0);
    expect(r.fired).toBe(false);
    expect(r.breakoutFired).toBe(false); // default floor 0 excludes it

    // Lowering the floor opts the shape in — the knob works.
    const permissive = evaluateRevival(m, hourCandles, NOW, {
      ...DEFAULT_REVIVAL_CONFIG,
      breakout: { minDrawdownFloor: -10 },
    });
    expect(permissive.breakoutFired).toBe(true);
  });
});

// --- Poller: per-kind suppression independence ------------------------------

describe('per-kind suppression', () => {
  const running = { dormant: true, runMultiple: 2.4, drawdownFromPeak: 0.5 };

  it('keys the same token differently per kind', () => {
    expect(suppressionKey('revival', 'solana:MintA')).not.toBe(
      suppressionKey('breakout', 'solana:MintA'),
    );
  });

  it("a token's revival suppression never mutes its breakout (and vice versa)", () => {
    const map = new Map<string, RunSuppression>();
    const tokenKey = 'solana:MintA';
    map.set(suppressionKey('revival', tokenKey), { alertedAt: NOW - 90 * MINUTE });

    // Revival stays suppressed mid-run…
    expect(
      evaluateRunSuppression(map.get(suppressionKey('revival', tokenKey)), running, NOW).suppress,
    ).toBe(true);
    // …while a first-ever breakout on the same token goes straight through.
    expect(
      evaluateRunSuppression(map.get(suppressionKey('breakout', tokenKey)), running, NOW).suppress,
    ).toBe(false);

    // And symmetrically the other way around.
    map.clear();
    map.set(suppressionKey('breakout', tokenKey), { alertedAt: NOW - 90 * MINUTE });
    expect(
      evaluateRunSuppression(map.get(suppressionKey('breakout', tokenKey)), running, NOW).suppress,
    ).toBe(true);
    expect(
      evaluateRunSuppression(map.get(suppressionKey('revival', tokenKey)), running, NOW).suppress,
    ).toBe(false);
  });

  describe('shouldSkipCandleFetch (the 60-min post-revival fetch skip)', () => {
    // The skip is keyed off the REVIVAL suppression alone — the pre-breakout
    // behaviour, so detection-side request volume is unchanged. It does not
    // mute breakout: inside revival's floor the only dormancy-qualifying
    // window is the pre-ignition one that just measured drawdown ≥ threshold
    // (post-ignition windows contain the ignition's own volume expansion),
    // so no breakout verdict is reachable there. Symmetrically, the poll loop
    // never passes the breakout prior: a breakout floor must not suppress the
    // fetch, because revival (the loud tier) stays observable through it.
    const inCooldown: RunSuppression = { alertedAt: NOW - 10 * MINUTE };
    const expired: RunSuppression = { alertedAt: NOW - 2 * HOUR };

    it('skips for the hour after a revival alert (breakout is unreachable inside the floor)', () => {
      expect(shouldSkipCandleFetch(inCooldown, NOW)).toBe(true);
    });

    it('fetches when no revival floor is open — first sight, lapsed floor, or breakout-cooldown-only', () => {
      expect(shouldSkipCandleFetch(undefined, NOW)).toBe(false);
      expect(shouldSkipCandleFetch(expired, NOW)).toBe(false);
    });

    it('the floor is exactly ALERT_COOLDOWN_MS', () => {
      expect(shouldSkipCandleFetch({ alertedAt: NOW - ALERT_COOLDOWN_MS + 1 }, NOW)).toBe(true);
      expect(shouldSkipCandleFetch({ alertedAt: NOW - ALERT_COOLDOWN_MS }, NOW)).toBe(false);
    });
  });
});

// --- Poller: cycle summary ---------------------------------------------------

describe('cycle summary — breakout count', () => {
  const base = {
    universeSize: 20,
    scanned: 10,
    requests: 12,
    rateLimited: 0,
    pollMs: 300_000,
    pausedEarly: false,
  };

  it('carries the breakout count (default 0 for legacy callers)', () => {
    expect(summarizeCycle(base).breakouts).toBe(0);
    expect(summarizeCycle({ ...base, breakouts: 2 }).breakouts).toBe(2);
  });

  it('renders it only when non-zero', () => {
    expect(formatCycleSummary(summarizeCycle(base))).not.toContain('breakout');
    expect(formatCycleSummary(summarizeCycle({ ...base, breakouts: 2 }))).toContain('2 breakout(s)');
  });
});

// --- Env gate ----------------------------------------------------------------

describe('isBreakoutEnabled', () => {
  afterEach(() => {
    delete process.env.OCT_BREAKOUT_ENABLED;
    delete process.env.TRENCHCORD_BREAKOUT_ENABLED;
  });

  it('defaults on', () => {
    delete process.env.OCT_BREAKOUT_ENABLED;
    delete process.env.TRENCHCORD_BREAKOUT_ENABLED;
    expect(isBreakoutEnabled()).toBe(true);
  });

  it('only an explicit falsy value disables, on either branding', () => {
    process.env.OCT_BREAKOUT_ENABLED = 'false';
    expect(isBreakoutEnabled()).toBe(false);
    delete process.env.OCT_BREAKOUT_ENABLED;

    process.env.TRENCHCORD_BREAKOUT_ENABLED = '0';
    expect(isBreakoutEnabled()).toBe(false);
    delete process.env.TRENCHCORD_BREAKOUT_ENABLED;

    process.env.OCT_BREAKOUT_ENABLED = 'anything-else';
    expect(isBreakoutEnabled()).toBe(true);
  });
});

// --- Persistence: kind + the deploy-window insert fallback -------------------

describe('buildAlertEntry — kind', () => {
  const data = {
    mint: 'MintA',
    network: 'solana',
    symbol: 'TOAD',
    price: 0.02,
    mcapUsd: 20_000_000,
    atrZ: 5,
    rvol: 8,
    baselinePrice: 0.012,
    runMultiple: 1.7,
    triggeredAt: new Date(NOW).toISOString(),
  };

  it('defaults to revival (existing callers unchanged)', () => {
    expect(buildAlertEntry(data).kind).toBe('revival');
  });

  it('carries breakout through', () => {
    expect(buildAlertEntry({ ...data, kind: 'breakout' }).kind).toBe('breakout');
  });

  it('persists the fire-time drawdown label — the calibration input for the drawdown knobs', () => {
    expect(buildAlertEntry({ ...data, drawdownFromPeak: 0.27 }).drawdownFromPeak).toBe(0.27);
    // Null when never measured (a revival firing on the gate's abstention).
    expect(buildAlertEntry({ ...data, drawdownFromPeak: null }).drawdownFromPeak).toBeNull();
    expect(buildAlertEntry(data).drawdownFromPeak).toBeNull();
  });
});

describe('RevivalAlertsRepo.logRevivalAlert — missing-column fallback (#123 pattern)', () => {
  function makeRepo(missing: { kind?: boolean; drawdown?: boolean; baseline?: boolean }) {
    const inserts: Record<string, unknown>[] = [];
    const client = {
      from: (_table: string) => ({
        insert: async (row: Record<string, unknown>) => {
          inserts.push({ ...row });
          if (missing.kind && 'kind' in row) {
            return {
              error: {
                message: "Could not find the 'kind' column of 'revival_alerts' in the schema cache",
              },
            };
          }
          if (missing.drawdown && 'drawdown_from_peak' in row) {
            return {
              error: {
                message:
                  "Could not find the 'drawdown_from_peak' column of 'revival_alerts' in the schema cache",
              },
            };
          }
          if (missing.baseline && ('baseline_price_usd' in row || 'run_multiple' in row)) {
            return {
              error: {
                message:
                  "Could not find the 'baseline_price_usd' column of 'revival_alerts' in the schema cache",
              },
            };
          }
          return { error: null };
        },
      }),
    };
    const repo = new RevivalAlertsRepo({ supabase: client } as unknown as SupabaseContext);
    return { repo, inserts };
  }

  const alert: RevivalAlertEntry = {
    id: '00000000-0000-0000-0000-000000000001',
    kind: 'breakout',
    mint: 'MintA',
    symbol: 'TOAD',
    network: 'solana',
    priceUsd: 0.02,
    mcapUsd: 20_000_000,
    atrZ: 5,
    rvol: 8,
    baselinePriceUsd: 0.012,
    runMultiple: 1.7,
    drawdownFromPeak: 0.27,
    triggeredAt: new Date(NOW).toISOString(),
    peakPriceUsd: 0.02,
    peakMcapUsd: 20_000_000,
    peakMultiple: 1,
    peakAt: new Date(NOW).toISOString(),
    outcomeWindowClosedAt: null,
  };

  it('writes kind and the drawdown label on the happy path (null kind defaults to revival)', async () => {
    const { repo, inserts } = makeRepo({});
    await repo.logRevivalAlert('u1', alert);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].kind).toBe('breakout');
    expect(inserts[0].drawdown_from_peak).toBe(0.27);

    const { repo: repo2, inserts: inserts2 } = makeRepo({});
    await repo2.logRevivalAlert('u1', { ...alert, kind: null, drawdownFromPeak: undefined });
    expect(inserts2[0].kind).toBe('revival');
    expect(inserts2[0].drawdown_from_peak).toBeNull();
  });

  it('retries once WITHOUT kind + drawdown (one migration, missing together) in the deploy→migrate window', async () => {
    const { repo, inserts } = makeRepo({ kind: true });
    await repo.logRevivalAlert('u1', alert);
    expect(inserts).toHaveLength(2);
    expect('kind' in inserts[0]).toBe(true);
    expect('kind' in inserts[1]).toBe(false);
    expect('drawdown_from_peak' in inserts[1]).toBe(false);
    // Nothing else was dropped from the row.
    expect(inserts[1].mint).toBe('MintA');
    expect(inserts[1].baseline_price_usd).toBe(0.012);
  });

  it('the same retry fires when the error names drawdown_from_peak instead of kind', async () => {
    // PostgREST reports ONE missing column per attempt — whichever of the
    // migration's two columns it names, the retry must drop both.
    const { repo, inserts } = makeRepo({ drawdown: true });
    await repo.logRevivalAlert('u1', { ...alert, kind: null });
    expect(inserts).toHaveLength(2);
    expect('kind' in inserts[1]).toBe(false);
    expect('drawdown_from_peak' in inserts[1]).toBe(false);
    expect(inserts[1].mint).toBe('MintA');
  });

  it('cascades with the older baseline/run_multiple fallback when both are missing', async () => {
    const { repo, inserts } = makeRepo({ kind: true, baseline: true });
    await repo.logRevivalAlert('u1', alert);
    expect(inserts).toHaveLength(3);
    const last = inserts[2];
    expect('kind' in last).toBe(false);
    expect('drawdown_from_peak' in last).toBe(false);
    expect('baseline_price_usd' in last).toBe(false);
    expect('run_multiple' in last).toBe(false);
    expect(last.mint).toBe('MintA');
  });

  it('maps drawdown_from_peak back out on reads (null on pre-migration rows)', async () => {
    const rows = [
      { id: 'a', kind: 'breakout', mint: 'MintA', triggered_at: new Date(NOW).toISOString(), drawdown_from_peak: '0.27' },
      { id: 'b', mint: 'MintB', triggered_at: new Date(NOW).toISOString() },
    ];
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            order: () => ({ limit: async () => ({ data: rows, error: null }) }),
          }),
        }),
      }),
    };
    const repo = new RevivalAlertsRepo({ supabase: client } as unknown as SupabaseContext);
    const entries = await repo.listRevivalAlerts('u1');
    expect(entries[0].drawdownFromPeak).toBe(0.27);
    expect(entries[1].drawdownFromPeak).toBeNull();
  });

  it('still throws on an unrelated insert error', async () => {
    const client = {
      from: () => ({
        insert: async () => ({ error: { message: 'connection reset' } }),
      }),
    };
    const repo = new RevivalAlertsRepo({ supabase: client } as unknown as SupabaseContext);
    await expect(repo.logRevivalAlert('u1', alert)).rejects.toThrow(/Failed to log revival alert/);
  });
});
