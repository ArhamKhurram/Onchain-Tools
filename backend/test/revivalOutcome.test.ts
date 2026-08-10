import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Storage is stubbed so the tracker's sweep can be exercised without touching
// the JSON store or Supabase. Declared with vi.hoisted because vi.mock factories
// are hoisted above the imports.
const stub = vi.hoisted(() => ({
  writes: [] as { userId: string; alertId: string; patch: Record<string, unknown> }[],
}));
vi.mock('../src/storage/index.js', () => ({
  isHostedMode: () => false,
  getStorageProvider: () => ({
    updateRevivalAlertOutcome: async (
      userId: string,
      alertId: string,
      patch: Record<string, unknown>,
    ) => {
      stub.writes.push({ userId, alertId, patch });
    },
  }),
}));

import {
  OUTCOME_WINDOW_MS,
  RevivalOutcomeTracker,
  buildAlertEntry,
  evaluateOutcome,
  maxHighInWindow,
  partitionOpenAlerts,
} from '../src/revival/outcomeTracker.js';
import {
  _clearPoolCacheForTest,
  _setRequestSpacingForTest,
} from '../src/revival/candles.js';
import type { Candle } from '../src/revival/detector.js';
import type { RevivalAlertEntry } from '@oct/shared';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-08-11T12:00:00.000Z');

function candle(ts: number, high: number): Candle {
  return { ts, open: high * 0.9, high, low: high * 0.8, close: high * 0.95, volume: 100 };
}

describe('maxHighInWindow', () => {
  it('returns the highest high strictly after `from` and up to `to`', () => {
    const candles = [
      candle(NOW - 30 * MINUTE, 5),
      candle(NOW - 20 * MINUTE, 9),
      candle(NOW - 10 * MINUTE, 7),
    ];
    const best = maxHighInWindow(candles, NOW - 25 * MINUTE, NOW);
    expect(best).toEqual({ price: 9, ts: NOW - 20 * MINUTE });
  });

  it('excludes candles at/before the window start and after the window end', () => {
    const candles = [
      candle(NOW - 30 * MINUTE, 100), // at `from` — excluded
      candle(NOW - 5 * MINUTE, 50), // after `to` — excluded
      candle(NOW - 15 * MINUTE, 3),
    ];
    const best = maxHighInWindow(candles, NOW - 30 * MINUTE, NOW - 10 * MINUTE);
    expect(best).toEqual({ price: 3, ts: NOW - 15 * MINUTE });
  });

  it('returns null when nothing qualifies (empty, out of range, or non-positive highs)', () => {
    expect(maxHighInWindow([], 0, NOW)).toBeNull();
    expect(maxHighInWindow([candle(NOW - 5 * MINUTE, 0)], NOW - HOUR, NOW)).toBeNull();
    expect(maxHighInWindow([candle(NOW - 2 * HOUR, 5)], NOW - HOUR, NOW)).toBeNull();
  });
});

describe('evaluateOutcome', () => {
  const base = { triggeredAtMs: NOW - HOUR, alertPriceUsd: 2, peakPriceUsd: 4 };

  it('writes peak fields only on improvement over the stored peak', () => {
    const better = evaluateOutcome(base, { price: 5, ts: NOW - MINUTE }, 1_000_000, NOW);
    expect(better.closed).toBe(false);
    expect(better.patch).toEqual({
      peakPriceUsd: 5,
      peakMcapUsd: 5_000_000,
      peakMultiple: 2.5,
      peakAt: new Date(NOW - MINUTE).toISOString(),
    });

    const worse = evaluateOutcome(base, { price: 3.9, ts: NOW - MINUTE }, 1_000_000, NOW);
    expect(worse.patch).toBeNull(); // write throttle: no improvement, no write
    expect(worse.closed).toBe(false);

    const equal = evaluateOutcome(base, { price: 4, ts: NOW - MINUTE }, 1_000_000, NOW);
    expect(equal.patch).toBeNull();
  });

  it('treats any positive observation as an improvement when no peak is stored yet', () => {
    const d = evaluateOutcome(
      { ...base, peakPriceUsd: null },
      { price: 1, ts: NOW - MINUTE },
      null,
      NOW,
    );
    expect(d.patch?.peakPriceUsd).toBe(1);
    expect(d.patch?.peakMcapUsd).toBeNull(); // no implied supply → no mcap
    expect(d.patch?.peakMultiple).toBe(0.5); // 1 / 2 — below alert price is still the peak
  });

  it('leaves peakMultiple null when the alert price was unknown', () => {
    const d = evaluateOutcome(
      { ...base, alertPriceUsd: null },
      { price: 9, ts: NOW - MINUTE },
      1_000,
      NOW,
    );
    expect(d.patch?.peakPriceUsd).toBe(9);
    expect(d.patch?.peakMultiple).toBeNull();
  });

  it('does nothing on a null observation inside an open window', () => {
    const d = evaluateOutcome(base, null, 1_000_000, NOW);
    expect(d.patch).toBeNull();
    expect(d.closed).toBe(false);
  });

  it('closes the window at triggeredAt + 24h, stamping the window end (not now)', () => {
    const triggeredAtMs = NOW - OUTCOME_WINDOW_MS - 3 * HOUR; // late sweep after downtime
    const d = evaluateOutcome({ ...base, triggeredAtMs }, null, null, NOW);
    expect(d.closed).toBe(true);
    expect(d.patch).toEqual({
      outcomeWindowClosedAt: new Date(triggeredAtMs + OUTCOME_WINDOW_MS).toISOString(),
    });
  });

  it('records a final improvement in the same write that closes the window', () => {
    const triggeredAtMs = NOW - OUTCOME_WINDOW_MS;
    const d = evaluateOutcome(
      { ...base, triggeredAtMs },
      { price: 10, ts: triggeredAtMs + 23 * HOUR },
      2_000_000,
      NOW,
    );
    expect(d.closed).toBe(true);
    expect(d.patch?.peakPriceUsd).toBe(10);
    expect(d.patch?.peakMultiple).toBe(5);
    expect(d.patch?.outcomeWindowClosedAt).toBe(
      new Date(triggeredAtMs + OUTCOME_WINDOW_MS).toISOString(),
    );
  });
});

describe('partitionOpenAlerts (resume-on-boot filtering)', () => {
  function entry(triggeredAtMsAgo: number, closed: boolean, id: string) {
    return {
      id,
      triggeredAt: new Date(NOW - triggeredAtMsAgo).toISOString(),
      outcomeWindowClosedAt: closed ? new Date(NOW).toISOString() : null,
    };
  }

  it('splits open windows from expired-but-unclosed ones, skipping closed rows', () => {
    const rows = [
      entry(2 * HOUR, false, 'open-recent'),
      entry(23 * HOUR, false, 'open-edge'),
      entry(25 * HOUR, false, 'expired-during-downtime'),
      entry(2 * HOUR, true, 'already-closed'),
    ];
    const { open, expired } = partitionOpenAlerts(rows, NOW);
    expect(open.map((e) => e.id)).toEqual(['open-recent', 'open-edge']);
    expect(expired.map((e) => e.id)).toEqual(['expired-during-downtime']);
  });

  it('treats exactly-24h-old as expired and ignores unparsable timestamps', () => {
    const boundary = { id: 'boundary', triggeredAt: new Date(NOW - OUTCOME_WINDOW_MS).toISOString(), outcomeWindowClosedAt: null };
    const junk = { id: 'junk', triggeredAt: 'not-a-date', outcomeWindowClosedAt: null };
    const { open, expired } = partitionOpenAlerts([boundary, junk], NOW);
    expect(open).toEqual([]);
    expect(expired.map((e) => e.id)).toEqual(['boundary']);
  });
});

describe('buildAlertEntry', () => {
  const fired = {
    mint: 'So11111111111111111111111111111111111111112',
    network: 'solana',
    symbol: 'WSOL',
    price: 0.5,
    mcapUsd: 500_000,
    atrZ: 4.2,
    rvol: 6.1,
    triggeredAt: new Date(NOW).toISOString(),
  };

  it('seeds the peak at the alert price (1.0×) so the log never understates', () => {
    const e = buildAlertEntry(fired);
    expect(e.network).toBe('solana');
    expect(e.priceUsd).toBe(0.5);
    expect(e.peakPriceUsd).toBe(0.5);
    expect(e.peakMcapUsd).toBe(500_000);
    expect(e.peakMultiple).toBe(1);
    expect(e.peakAt).toBe(fired.triggeredAt);
    expect(e.outcomeWindowClosedAt).toBeNull();
    expect(e.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('leaves peaks null when the fire-time price was unknown', () => {
    const e = buildAlertEntry({ ...fired, price: null, mcapUsd: null });
    expect(e.peakPriceUsd).toBeNull();
    expect(e.peakMcapUsd).toBeNull();
    expect(e.peakMultiple).toBeNull();
    expect(e.peakAt).toBeNull();
  });

  it('records the chain the detection actually ran on', () => {
    expect(buildAlertEntry({ ...fired, network: 'robinhood' }).network).toBe('robinhood');
    expect(buildAlertEntry({ ...fired, network: 'bsc' }).network).toBe('bsc');
  });
});

// ---------------------------------------------------------------------------
// The tracker must re-fetch on the alert's OWN chain. Getting this wrong is
// silent: a Robinhood token looked up on Solana just never resolves, so the
// row sits at 1.0× forever and a real 3.4× reads as a dud alert.
// ---------------------------------------------------------------------------

const UP_ADDRESS = '0x57c0e45cb534413d1c20a4240955d6bb250bb4f1';

function alertRow(over: Partial<RevivalAlertEntry>): RevivalAlertEntry {
  return {
    id: 'alert-1',
    mint: UP_ADDRESS,
    symbol: 'UP',
    network: 'robinhood',
    priceUsd: 1,
    mcapUsd: 1_450_000,
    atrZ: 3.4,
    rvol: 16.3,
    triggeredAt: new Date(Date.now() - 30 * MINUTE).toISOString(),
    peakPriceUsd: 1,
    peakMcapUsd: 1_450_000,
    peakMultiple: 1,
    peakAt: null,
    outcomeWindowClosedAt: null,
    ...over,
  };
}

describe('RevivalOutcomeTracker network routing (mocked HTTP)', () => {
  let urls: string[];

  beforeEach(() => {
    stub.writes.length = 0;
    urls = [];
    _clearPoolCacheForTest();
    _setRequestSpacingForTest(0);
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      const network = url.split('/networks/')[1]?.split('/')[0] ?? '?';
      const body = url.includes('/pools?page=1')
        ? {
            data: [
              {
                attributes: {
                  address: `pool-${network}`,
                  name: 'UP / WETH',
                  volume_usd: { h24: '9999' },
                  base_token_price_usd: '1',
                  fdv_usd: '1450000',
                },
              },
            ],
          }
        : {
            data: {
              attributes: {
                ohlcv_list: [
                  [Math.floor((Date.now() - 10 * MINUTE) / 1000), 1, 3.4, 0.9, 3.2, 100],
                ],
              },
            },
          };
      return { ok: true, status: 200, json: async () => body };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _clearPoolCacheForTest();
  });

  it('fetches candles on the alert’s network, never on Solana by default', async () => {
    const tracker = new RevivalOutcomeTracker();
    tracker.resumeEntries([{ entry: alertRow({}), userId: 'u1' }]);
    await tracker.sweepNow();

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.includes('/networks/robinhood/'))).toBe(true);
    expect(urls.some((u) => u.includes('/networks/solana/'))).toBe(false);
    // And the peak it observed on that chain was written back.
    expect(stub.writes[0]?.patch.peakPriceUsd).toBe(3.4);
  });

  it('keeps two chains apart when the same address is tracked on both', async () => {
    const tracker = new RevivalOutcomeTracker();
    tracker.resumeEntries([
      { entry: alertRow({ id: 'hood', network: 'robinhood' }), userId: 'u1' },
      { entry: alertRow({ id: 'bnb', network: 'bsc' }), userId: 'u1' },
    ]);
    await tracker.sweepNow();

    expect(urls.some((u) => u.includes('/networks/robinhood/pools/pool-robinhood/'))).toBe(true);
    expect(urls.some((u) => u.includes('/networks/bsc/pools/pool-bsc/'))).toBe(true);
    expect(stub.writes.map((w) => w.alertId).sort()).toEqual(['bnb', 'hood']);
  });

  it('treats a pre-multichain row with an unknown network as Solana', async () => {
    const tracker = new RevivalOutcomeTracker();
    tracker.resumeEntries([
      { entry: alertRow({ mint: 'SoLegacyMint', network: 'not-a-network' }), userId: 'u1' },
    ]);
    await tracker.sweepNow();
    expect(urls.every((u) => u.includes('/networks/solana/'))).toBe(true);
  });
});
