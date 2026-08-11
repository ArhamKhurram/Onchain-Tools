import { describe, it, expect } from 'vitest';
import {
  computeRevivalReceipts,
  median,
  SEVEN_DAYS_MS,
} from '../src/components/callers/revivalReceipts';
import type { RevivalAlertEntry } from '../src/types';

/** Fixed clock — the pure function takes `nowMs`, never reads Date.now(). */
const NOW = Date.parse('2026-08-11T12:00:00.000Z');
const HOUR = 3_600_000;

let seq = 0;
function alert(overrides: Partial<RevivalAlertEntry> = {}): RevivalAlertEntry {
  seq += 1;
  return {
    id: `alert-${seq}`,
    mint: `Mint${seq}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
    symbol: 'TEST',
    network: 'solana',
    priceUsd: 0.001,
    mcapUsd: 500_000,
    atrZ: 4,
    rvol: 8,
    baselinePriceUsd: 0.0009,
    runMultiple: 1.1,
    triggeredAt: new Date(NOW - HOUR).toISOString(),
    peakPriceUsd: 0.001,
    peakMcapUsd: 500_000,
    // A freshly written row starts at 1.0× (peak = alert price) with the
    // window still open — exactly the shape that must not count as a dud.
    peakMultiple: 1,
    peakAt: new Date(NOW - HOUR).toISOString(),
    outcomeWindowClosedAt: null,
    ...overrides,
  };
}

/** A row whose 24h outcome window has closed with the given peak multiple. */
function closed(
  peakMultiple: number | null,
  overrides: Partial<RevivalAlertEntry> = {},
): RevivalAlertEntry {
  return alert({
    triggeredAt: new Date(NOW - 30 * HOUR).toISOString(),
    outcomeWindowClosedAt: new Date(NOW - 6 * HOUR).toISOString(),
    peakMultiple,
    ...overrides,
  });
}

describe('median', () => {
  it('returns the middle value on odd counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([5])).toBe(5);
  });
  it('averages the two middle values on even counts', () => {
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(median([4, 1])).toBe(2.5);
  });
  it('returns null on an empty list', () => {
    expect(median([])).toBeNull();
  });
});

describe('computeRevivalReceipts — zero state', () => {
  it('reports nulls (not fake zeros) when there are no alerts', () => {
    const r = computeRevivalReceipts([], NOW);
    expect(r.totalAlerts).toBe(0);
    expect(r.alerts7d).toBe(0);
    expect(r.closedCount).toBe(0);
    expect(r.closedMeasuredCount).toBe(0);
    expect(r.closed2xCount).toBe(0);
    expect(r.medianPeakMultiple).toBeNull();
    expect(r.rate2xPct).toBeNull();
    expect(r.bestCatch).toBeNull();
    expect(r.medianRunMultiple).toBeNull();
  });
});

describe('computeRevivalReceipts — 7d windowing', () => {
  it('counts only alerts triggered within the trailing 7 days of nowMs', () => {
    const rows = [
      alert({ triggeredAt: new Date(NOW - HOUR).toISOString() }), // in
      alert({ triggeredAt: new Date(NOW - SEVEN_DAYS_MS + HOUR).toISOString() }), // in
      alert({ triggeredAt: new Date(NOW - SEVEN_DAYS_MS).toISOString() }), // boundary: in
      alert({ triggeredAt: new Date(NOW - SEVEN_DAYS_MS - 1).toISOString() }), // out
      alert({ triggeredAt: new Date(NOW - 8 * 24 * HOUR).toISOString() }), // out
    ];
    const r = computeRevivalReceipts(rows, NOW);
    expect(r.totalAlerts).toBe(5);
    expect(r.alerts7d).toBe(3);
  });

  it('ignores unparseable timestamps rather than counting them', () => {
    const r = computeRevivalReceipts([alert({ triggeredAt: 'not-a-date' })], NOW);
    expect(r.alerts7d).toBe(0);
    expect(r.totalAlerts).toBe(1);
  });
});

describe('computeRevivalReceipts — open windows are not duds', () => {
  it('excludes open windows from median peak and the ≥2× rate', () => {
    const rows = [
      // Two fresh open rows sitting at their 1.0× initialisation.
      alert(),
      alert(),
      closed(3.0),
      closed(1.5),
    ];
    const r = computeRevivalReceipts(rows, NOW);
    expect(r.closedCount).toBe(2);
    expect(r.closedMeasuredCount).toBe(2);
    expect(r.medianPeakMultiple).toBe(2.25); // median of [1.5, 3.0], NOT dragged by the 1.0s
    expect(r.rate2xPct).toBe(50);
    expect(r.closed2xCount).toBe(1);
  });

  it('reports null peak stats when every window is still open', () => {
    const r = computeRevivalReceipts([alert(), alert(), alert()], NOW);
    expect(r.closedCount).toBe(0);
    expect(r.medianPeakMultiple).toBeNull();
    expect(r.rate2xPct).toBeNull();
    // All peaks are the 1.0× initialisation — no catch has been observed.
    expect(r.bestCatch).toBeNull();
  });
});

describe('computeRevivalReceipts — null peaks on closed windows', () => {
  it('treats a null peak as missing evidence, not a dud', () => {
    const rows = [closed(null), closed(2.5), closed(1.0)];
    const r = computeRevivalReceipts(rows, NOW);
    expect(r.closedCount).toBe(3);
    expect(r.closedMeasuredCount).toBe(2); // the null row is out of numerator AND denominator
    expect(r.medianPeakMultiple).toBe(1.75);
    expect(r.rate2xPct).toBe(50);
  });

  it('handles all-null closed peaks (alert price unknown at fire time)', () => {
    const r = computeRevivalReceipts([closed(null), closed(null)], NOW);
    expect(r.closedCount).toBe(2);
    expect(r.closedMeasuredCount).toBe(0);
    expect(r.medianPeakMultiple).toBeNull();
    expect(r.rate2xPct).toBeNull();
    expect(r.bestCatch).toBeNull();
  });
});

describe('computeRevivalReceipts — median peak on odd/even closed counts', () => {
  it('odd count takes the middle closed peak', () => {
    const r = computeRevivalReceipts([closed(1.0), closed(9.0), closed(2.0)], NOW);
    expect(r.medianPeakMultiple).toBe(2.0);
  });
  it('even count averages the two middle closed peaks', () => {
    const r = computeRevivalReceipts([closed(1.0), closed(2.0), closed(4.0), closed(10.0)], NOW);
    expect(r.medianPeakMultiple).toBe(3.0);
  });
});

describe('computeRevivalReceipts — median run @ alert', () => {
  it('spans open and closed rows but skips pre-#125 nulls', () => {
    const rows = [
      alert({ runMultiple: null }), // pre-#125: no baseline
      alert({ runMultiple: 1.2 }),
      closed(2.0, { runMultiple: 3.0 }),
      closed(1.1, { runMultiple: null }),
      alert({ runMultiple: 1.4 }),
    ];
    const r = computeRevivalReceipts(rows, NOW);
    expect(r.medianRunMultiple).toBe(1.4); // median of [1.2, 1.4, 3.0]
  });

  it('is null when no row has a run multiple', () => {
    const r = computeRevivalReceipts([alert({ runMultiple: null }), closed(2.0, { runMultiple: null })], NOW);
    expect(r.medianRunMultiple).toBeNull();
  });
});

describe('computeRevivalReceipts — best catch', () => {
  it('picks the highest peak and carries symbol, mint and mcap-at-alert', () => {
    const rows = [
      closed(2.1, { symbol: 'AAA', mcapUsd: 100_000 }),
      closed(4.2, { symbol: 'BBB', mint: 'BestMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', mcapUsd: 412_000 }),
      closed(1.0, { symbol: 'CCC' }),
    ];
    const r = computeRevivalReceipts(rows, NOW);
    expect(r.bestCatch).toEqual({
      symbol: 'BBB',
      mint: 'BestMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      peakMultiple: 4.2,
      mcapUsd: 412_000,
      closed: true,
    });
  });

  it('lets an open window win once the tracker has observed an improvement', () => {
    const rows = [closed(1.8, { symbol: 'OLD' }), alert({ symbol: 'LIVE', peakMultiple: 3.5 })];
    const r = computeRevivalReceipts(rows, NOW);
    expect(r.bestCatch?.symbol).toBe('LIVE');
    expect(r.bestCatch?.peakMultiple).toBe(3.5);
    expect(r.bestCatch?.closed).toBe(false);
  });

  it('never crowns a fresh open row still at its 1.0× initialisation', () => {
    const r = computeRevivalReceipts([alert({ peakMultiple: 1 })], NOW);
    expect(r.bestCatch).toBeNull();
  });

  it('a closed 1.0× dud can be the best catch when it is all there is', () => {
    const r = computeRevivalReceipts([closed(1.0, { symbol: 'DUD' })], NOW);
    expect(r.bestCatch?.symbol).toBe('DUD');
    expect(r.bestCatch?.peakMultiple).toBe(1.0);
  });
});
