import { describe, it, expect } from 'vitest';
import type { RevivalAlertEntry } from '@oct/shared';
import {
  DEFAULT_DIGEST_HOUR_UTC,
  DIGEST_ACCENT,
  DIGEST_WINDOW_MS,
  MAX_ALERT_LINES,
  buildDigestComponents,
  digestWindow,
  isDailyDigestOptIn,
  msUntilNextDigestFire,
  resolveDigestHourUtc,
  runDailyDigest,
  selectDigestOptIns,
  selectWindowAlerts,
  selectWindowCallouts,
  type DailyDigestDeps,
} from '../src/bot/dailyDigest.js';
import { BRAND, SITE_ACCENT } from '../src/bot/layout.js';
import type { RecentCallout } from '../src/pumpfun/calloutFeedClient.js';

const HOUR_MS = 3_600_000;

// Fixed reference instant: 2026-08-11T13:00:00Z (a digest fire moment).
const FIRE_MS = Date.UTC(2026, 7, 11, 13, 0, 0, 0);

const alertAt = (isoOffsetMs: number, over: Partial<RevivalAlertEntry> = {}): RevivalAlertEntry => ({
  id: `a-${isoOffsetMs}`,
  mint: 'So11111111111111111111111111111111111111112',
  symbol: 'TOAD',
  network: 'solana',
  priceUsd: 0.001,
  mcapUsd: 120_000,
  atrZ: 3.2,
  rvol: 5,
  baselinePriceUsd: 0.0004,
  runMultiple: 2.5,
  triggeredAt: new Date(FIRE_MS + isoOffsetMs).toISOString(),
  peakPriceUsd: 0.0024,
  peakMcapUsd: 288_000,
  peakMultiple: 2.4,
  peakAt: new Date(FIRE_MS + isoOffsetMs + HOUR_MS).toISOString(),
  outcomeWindowClosedAt: null,
  ...over,
});

const callout = (
  id: string,
  caller: string,
  createdAt: number | null,
  over: Partial<RecentCallout> = {},
): RecentCallout => ({
  calloutId: id,
  callerAddress: caller,
  coinMint: `mint-${id}`,
  marketCapUsd: 45_000,
  thesis: 'sending it',
  multiple: 1.2,
  createdAt,
  ...over,
});

describe('resolveDigestHourUtc', () => {
  it('defaults to 13:00 UTC when nothing is set', () => {
    expect(resolveDigestHourUtc({})).toBe(DEFAULT_DIGEST_HOUR_UTC);
    expect(DEFAULT_DIGEST_HOUR_UTC).toBe(13);
  });

  it('reads OCT_DIGEST_HOUR_UTC, with the TRENCHCORD_* fallback', () => {
    expect(resolveDigestHourUtc({ OCT_DIGEST_HOUR_UTC: '7' })).toBe(7);
    expect(resolveDigestHourUtc({ TRENCHCORD_DIGEST_HOUR_UTC: '21' })).toBe(21);
    // OCT wins over TRENCHCORD, matching the repo-wide env convention.
    expect(resolveDigestHourUtc({ OCT_DIGEST_HOUR_UTC: '5', TRENCHCORD_DIGEST_HOUR_UTC: '9' })).toBe(5);
  });

  it('rejects garbage and out-of-range values', () => {
    expect(resolveDigestHourUtc({ OCT_DIGEST_HOUR_UTC: 'noon' })).toBe(13);
    expect(resolveDigestHourUtc({ OCT_DIGEST_HOUR_UTC: '24' })).toBe(13);
    expect(resolveDigestHourUtc({ OCT_DIGEST_HOUR_UTC: '-1' })).toBe(13);
    expect(resolveDigestHourUtc({ OCT_DIGEST_HOUR_UTC: '' })).toBe(13);
  });

  it('accepts the boundary hours 0 and 23', () => {
    expect(resolveDigestHourUtc({ OCT_DIGEST_HOUR_UTC: '0' })).toBe(0);
    expect(resolveDigestHourUtc({ OCT_DIGEST_HOUR_UTC: '23' })).toBe(23);
  });
});

describe('digestWindow', () => {
  it('covers exactly the 24h ending at the fire moment', () => {
    const { startMs, endMs } = digestWindow(FIRE_MS);
    expect(endMs).toBe(FIRE_MS);
    expect(startMs).toBe(FIRE_MS - DIGEST_WINDOW_MS);
    expect(endMs - startMs).toBe(24 * HOUR_MS);
  });
});

describe('msUntilNextDigestFire (scheduler hour matching)', () => {
  it('targets today when the hour is still ahead', () => {
    const now = Date.UTC(2026, 7, 11, 10, 0, 0, 0);
    expect(msUntilNextDigestFire(now, 13)).toBe(3 * HOUR_MS);
  });

  it('targets tomorrow when the hour already passed today', () => {
    const now = Date.UTC(2026, 7, 11, 14, 30, 0, 0);
    expect(msUntilNextDigestFire(now, 13)).toBe(22.5 * HOUR_MS);
  });

  it('at exactly the fire hour, schedules a full day out (no double fire)', () => {
    expect(msUntilNextDigestFire(FIRE_MS, 13)).toBe(24 * HOUR_MS);
  });

  it('handles midnight (hour 0) across a date boundary', () => {
    const now = Date.UTC(2026, 7, 11, 23, 0, 0, 0);
    expect(msUntilNextDigestFire(now, 0)).toBe(1 * HOUR_MS);
  });

  it('never returns zero or negative', () => {
    for (const h of [0, 5, 13, 23]) {
      for (const now of [FIRE_MS, FIRE_MS + 1, FIRE_MS - 1]) {
        expect(msUntilNextDigestFire(now, h)).toBeGreaterThan(0);
        expect(msUntilNextDigestFire(now, h)).toBeLessThanOrEqual(24 * HOUR_MS);
      }
    }
  });
});

describe('isDailyDigestOptIn / selectDigestOptIns', () => {
  it('requires BOTH the master switch and the dailyDigest trigger', () => {
    expect(isDailyDigestOptIn({ discordBotDm: { enabled: true, triggers: { dailyDigest: true } } })).toBe(true);
    expect(isDailyDigestOptIn({ discordBotDm: { enabled: false, triggers: { dailyDigest: true } } })).toBe(false);
    expect(isDailyDigestOptIn({ discordBotDm: { enabled: true, triggers: { dailyDigest: false } } })).toBe(false);
    expect(isDailyDigestOptIn({ discordBotDm: { enabled: true, triggers: {} } })).toBe(false);
  });

  it('reads anything malformed as "no" (settings is an untyped blob)', () => {
    expect(isDailyDigestOptIn(null)).toBe(false);
    expect(isDailyDigestOptIn(undefined)).toBe(false);
    expect(isDailyDigestOptIn('yes')).toBe(false);
    expect(isDailyDigestOptIn({})).toBe(false);
    expect(isDailyDigestOptIn({ discordBotDm: 'on' })).toBe(false);
    expect(isDailyDigestOptIn({ discordBotDm: { enabled: 1, triggers: { dailyDigest: 'true' } } })).toBe(false);
  });

  it('does not treat other triggers (e.g. releaseNotes) as digest consent', () => {
    expect(
      isDailyDigestOptIn({ discordBotDm: { enabled: true, triggers: { releaseNotes: true, missedRunner: true } } }),
    ).toBe(false);
  });

  it('selects only opted-in user ids', () => {
    const rows = [
      { user_id: 'a', settings: { discordBotDm: { enabled: true, triggers: { dailyDigest: true } } } },
      { user_id: 'b', settings: { discordBotDm: { enabled: true, triggers: { dailyDigest: false } } } },
      { user_id: 'c', settings: null },
      { user_id: 'd', settings: { discordBotDm: { enabled: true, triggers: { dailyDigest: true } } } },
    ];
    expect(selectDigestOptIns(rows)).toEqual({ userIds: ['a', 'd'], truncated: false });
  });
});

describe('selectWindowAlerts (window computation over fixed timestamps)', () => {
  const { startMs, endMs } = digestWindow(FIRE_MS);

  it('returns empty for zero alerts', () => {
    expect(selectWindowAlerts([], startMs, endMs)).toEqual([]);
  });

  it('keeps only alerts inside [start, end), newest first', () => {
    const inWindowOld = alertAt(-23 * HOUR_MS);
    const inWindowNew = alertAt(-1 * HOUR_MS);
    const tooOld = alertAt(-25 * HOUR_MS);
    const atStart = alertAt(-24 * HOUR_MS); // inclusive start
    const atEnd = alertAt(0); // exclusive end
    const future = alertAt(2 * HOUR_MS);

    const out = selectWindowAlerts([inWindowOld, tooOld, future, atEnd, inWindowNew, atStart], startMs, endMs);
    expect(out.map((a) => a.id)).toEqual([inWindowNew.id, inWindowOld.id, atStart.id]);
  });

  it('drops rows with unparseable timestamps instead of throwing', () => {
    const bad = alertAt(-HOUR_MS, { triggeredAt: 'not-a-date' });
    expect(selectWindowAlerts([bad], startMs, endMs)).toEqual([]);
  });
});

describe('selectWindowCallouts', () => {
  const { startMs, endMs } = digestWindow(FIRE_MS);
  const allowed = new Set(['top1', 'top2']);

  it('filters to allowed callers inside the window, newest first, capped', () => {
    const picks = selectWindowCallouts(
      [
        callout('c1', 'top1', FIRE_MS - 2 * HOUR_MS),
        callout('c2', 'nobody', FIRE_MS - 1 * HOUR_MS), // not on the board
        callout('c3', 'top2', FIRE_MS - 30 * HOUR_MS), // out of window
        callout('c4', 'top2', FIRE_MS - 1 * HOUR_MS),
        callout('c5', 'top1', FIRE_MS - 10 * HOUR_MS),
        callout('c6', 'top1', FIRE_MS - 12 * HOUR_MS),
      ],
      allowed,
      startMs,
      endMs,
      3,
    );
    expect(picks.map((c) => c.calloutId)).toEqual(['c4', 'c1', 'c5']);
  });

  it('drops rows without a timestamp (cannot be placed in the window)', () => {
    expect(selectWindowCallouts([callout('c1', 'top1', null)], allowed, startMs, endMs)).toEqual([]);
  });
});

describe('buildDigestComponents', () => {
  const base = { windowEndMs: FIRE_MS, callouts: [], topCallers: { callers: [], source: 'window' as const } };

  it('says the quiet night out loud instead of skipping the section', () => {
    const text = JSON.stringify(buildDigestComponents({ ...base, alerts: [] }));
    expect(text).toContain('Quiet night — 0 revival alerts.');
  });

  it('renders alert lines with symbol, chain, MC at alert and peak multiple', () => {
    const text = JSON.stringify(buildDigestComponents({ ...base, alerts: [alertAt(-HOUR_MS)] }));
    expect(text).toContain('$TOAD');
    expect(text).toContain('SOL');
    expect(text).toContain('$120.0K');
    expect(text).toContain('2.40×');
    expect(text).toContain('peak so far'); // window still open
  });

  it('labels a closed outcome window as the 24h peak', () => {
    const closed = alertAt(-23 * HOUR_MS, { outcomeWindowClosedAt: new Date(FIRE_MS).toISOString() });
    const text = JSON.stringify(buildDigestComponents({ ...base, alerts: [closed] }));
    expect(text).toContain('24h peak');
  });

  it('caps a loud night and reports the overflow', () => {
    const many = Array.from({ length: MAX_ALERT_LINES + 4 }, (_, i) => alertAt(-(i + 1) * 60_000));
    const text = JSON.stringify(buildDigestComponents({ ...base, alerts: many }));
    expect(text).toContain(`Revival alerts — ${MAX_ALERT_LINES + 4} alerts`);
    expect(text).toContain('+4 more alert(s) not shown');
  });

  it('renders callout picks with MC at call, and honest fallbacks otherwise', () => {
    const withPicks = JSON.stringify(
      buildDigestComponents({
        ...base,
        alerts: [],
        callouts: [
          { callerAddress: 'top1', callerName: 'papipablo', mint: 'm1', symbol: 'WIF', marketCapUsd: 45_000 },
        ],
      }),
    );
    expect(withPicks).toContain('papipablo');
    expect(withPicks).toContain('$WIF');
    expect(withPicks).toContain('MC at call $45.0K');

    const unavailable = JSON.stringify(buildDigestComponents({ ...base, alerts: [], callouts: null }));
    expect(unavailable).toContain('Callout feed unavailable');
  });

  it('labels the caller board by what was actually read (window vs all-time)', () => {
    const caller = {
      callerAddress: 'top1',
      username: 'papipablo',
      avatar: null,
      calloutCount: 12,
      avgMultiple: 1.4,
      maxMultiple: 3.1,
      lastCalloutAt: null,
    };
    const windowed = JSON.stringify(
      buildDigestComponents({ ...base, alerts: [], topCallers: { callers: [caller], source: 'window' } }),
    );
    expect(windowed).toContain('Top callers (24h)');
    expect(windowed).toContain('12 calls');

    const fallback = JSON.stringify(
      buildDigestComponents({ ...base, alerts: [], topCallers: { callers: [caller], source: 'all_time' } }),
    );
    expect(fallback).toContain('Current top callers');
    expect(fallback).toContain('12 calls all-time');
  });

  it('uses its own neutral accent — not the changelog red, not the callout gold', () => {
    const [container] = buildDigestComponents({ ...base, alerts: [] }) as Array<{ accent_color: number }>;
    expect(container.accent_color).toBe(DIGEST_ACCENT);
    expect(container.accent_color).not.toBe(SITE_ACCENT);
    expect(container.accent_color).not.toBe(BRAND.gold);
    expect(container.accent_color).not.toBe(BRAND.red);
  });
});

describe('runDailyDigest delivery loop', () => {
  const makeDeps = (over: Partial<DailyDigestDeps> = {}): {
    deps: DailyDigestDeps;
    sent: string[];
  } => {
    const sent: string[] = [];
    const client = {
      users: {
        fetch: async (discordId: string) => ({
          send: async () => {
            if (discordId === 'discord-blocked') {
              const err: any = new Error('Cannot send messages to this user');
              err.code = 50007;
              throw err;
            }
            if (discordId === 'discord-broken') throw new Error('boom');
            sent.push(discordId);
          },
        }),
      },
    } as any;

    const deps: DailyDigestDeps = {
      getClient: () => client,
      loadOptIns: async () => ({ userIds: ['u-ok', 'u-blocked', 'u-broken', 'u-unlinked', 'u-ok2'], truncated: false }),
      listAlerts: async () => [alertAt(-HOUR_MS)],
      loadRecentCallouts: async () => [],
      loadBoardAddresses: async () => [],
      loadTopCallers: async () => ({ callers: [], source: 'window' }),
      resolveDiscordId: async (userId) =>
        userId === 'u-unlinked' ? null : userId.replace('u-', 'discord-'),
      resolveUsers: async () => new Map(),
      resolveCoins: async () => new Map(),
      now: () => FIRE_MS,
      sleep: async () => {},
      ...over,
    };
    return { deps, sent };
  };

  it('delivers to every linked opt-in and never aborts on a per-user failure', async () => {
    const { deps, sent } = makeDeps();
    const result = await runDailyDigest(deps);
    expect(sent).toEqual(['discord-ok', 'discord-ok2']); // loop survived the middle failures
    expect(result).toEqual({ eligible: 5, delivered: 2, blocked: 1, failed: 1, truncated: false });
  });

  it('skips the run cleanly when the bot client is not connected', async () => {
    const { deps } = makeDeps({ getClient: () => null });
    const result = await runDailyDigest(deps);
    expect(result).toEqual({ eligible: 0, delivered: 0, blocked: 0, failed: 0, truncated: false });
  });

  it('still sends the DM (with the quiet-night line) when a user had zero alerts', async () => {
    const { deps, sent } = makeDeps({
      loadOptIns: async () => ({ userIds: ['u-ok'], truncated: false }),
      listAlerts: async () => [],
    });
    const result = await runDailyDigest(deps);
    expect(sent).toEqual(['discord-ok']);
    expect(result.delivered).toBe(1);
  });

  it('degrades global sections to null instead of failing the run', async () => {
    const { deps, sent } = makeDeps({
      loadOptIns: async () => ({ userIds: ['u-ok'], truncated: false }),
      loadBoardAddresses: async () => {
        throw new Error('board down');
      },
      loadTopCallers: async () => {
        throw new Error('rpc down');
      },
    });
    const result = await runDailyDigest(deps);
    expect(sent).toEqual(['discord-ok']);
    expect(result.delivered).toBe(1);
  });
});
