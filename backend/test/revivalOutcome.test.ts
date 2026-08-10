import { describe, expect, it } from 'vitest';
import {
  OUTCOME_WINDOW_MS,
  buildAlertEntry,
  evaluateOutcome,
  maxHighInWindow,
  partitionOpenAlerts,
} from '../src/revival/outcomeTracker.js';
import type { Candle } from '../src/revival/detector.js';

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
});
