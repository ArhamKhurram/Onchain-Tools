import { describe, expect, it } from 'vitest';
import type { JournalPosition } from '@oct/shared';
import { buildJournalSummary } from '../src/journal/stats.js';
import type { RealizedEvent } from '../src/journal/positions.js';

const NOW = Date.parse('2026-08-12T12:00:00.000Z');

function ev(ts: string, pnlSol: number | null, pnlUsd: number | null = null): RealizedEvent {
  return { ts, mint: 'MintXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', symbol: 'TOK', walletId: 'w1', pnlSol, pnlUsd };
}

function pos(status: 'open' | 'closed', realizedPnlSol: number): JournalPosition {
  return {
    id: `p-${Math.random()}`,
    walletId: 'w1',
    walletAddress: 'addr',
    mint: 'MintXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    symbol: 'TOK',
    status,
    acquiredToken: 1,
    remainingToken: status === 'open' ? 1 : 0,
    costSol: 1,
    costUsd: null,
    realizedPnlSol,
    realizedPnlUsd: null,
    pnlIncomplete: false,
    openedAt: '2026-08-01T00:00:00.000Z',
    closedAt: status === 'closed' ? '2026-08-02T00:00:00.000Z' : null,
    lastTradeAt: '2026-08-02T00:00:00.000Z',
    lastPriceUsd: null,
    lastPriceAt: null,
  };
}

describe('buildJournalSummary', () => {
  it('builds the cumulative curve and measures drawdown from the all-time peak (give-back meter)', () => {
    // Run-up to +5, give back down to +1.5 → drawdown 3.5. THE audit pattern.
    const events = [
      ev('2026-08-01T10:00:00.000Z', 2, 400),
      ev('2026-08-02T10:00:00.000Z', 3, 600),
      ev('2026-08-03T10:00:00.000Z', -1.5, -300),
      ev('2026-08-04T10:00:00.000Z', -2, -400),
    ];
    const s = buildJournalSummary(events, [], 8, NOW);
    expect(s.curve.map((p) => p.cumSol)).toEqual([2, 5, 3.5, 1.5]);
    expect(s.cumRealizedSol).toBe(1.5);
    expect(s.peakCumRealizedSol).toBe(5);
    expect(s.drawdownFromPeakSol).toBe(3.5);
    expect(s.cumRealizedUsd).toBe(300);
    expect(s.drawdownFromPeakUsd).toBe(700);
  });

  it('reports zero drawdown at the high-water mark', () => {
    const events = [ev('2026-08-01T10:00:00.000Z', 1), ev('2026-08-02T10:00:00.000Z', 2)];
    const s = buildJournalSummary(events, [], 4, NOW);
    expect(s.drawdownFromPeakSol).toBe(0);
  });

  it('windows realized7d on event time, not curve position', () => {
    const events = [
      ev('2026-07-20T10:00:00.000Z', 10), // outside 7d
      ev('2026-08-06T10:00:00.000Z', 2), // inside (NOW - 6d2h)
      ev('2026-08-11T10:00:00.000Z', -0.5), // inside
    ];
    const s = buildJournalSummary(events, [], 6, NOW);
    expect(s.realized7dSol).toBeCloseTo(1.5, 9);
    expect(s.cumRealizedSol).toBeCloseTo(11.5, 9);
  });

  it('computes win rate over CLOSED episodes only', () => {
    const positions = [pos('closed', 2), pos('closed', -1), pos('closed', 0.5), pos('open', 99)];
    const s = buildJournalSummary([], positions, 0, NOW);
    expect(s.winRate).toBeCloseTo(2 / 3, 9);
    expect(s.closedEpisodes).toBe(3);
    expect(s.openEpisodes).toBe(1);
  });

  it('returns null win rate with no closed episodes instead of 0% or 100%', () => {
    const s = buildJournalSummary([], [pos('open', 1)], 0, NOW);
    expect(s.winRate).toBeNull();
  });

  it('groups the day list by UTC day, newest first', () => {
    const events = [
      ev('2026-08-01T09:00:00.000Z', 1, 200),
      ev('2026-08-01T23:00:00.000Z', -0.25, -50),
      ev('2026-08-03T01:00:00.000Z', 4, 800),
    ];
    const s = buildJournalSummary(events, [], 6, NOW);
    expect(s.days).toEqual([
      { date: '2026-08-03', trades: 1, realizedPnlSol: 4, realizedPnlUsd: 800 },
      { date: '2026-08-01', trades: 2, realizedPnlSol: 0.75, realizedPnlUsd: 150 },
    ]);
  });

  it('nulls USD aggregates once any contributing event lacks a USD value', () => {
    const events = [
      ev('2026-08-10T10:00:00.000Z', 2, 400),
      ev('2026-08-11T10:00:00.000Z', 1, null), // unpriced leg
    ];
    const s = buildJournalSummary(events, [], 4, NOW);
    expect(s.cumRealizedUsd).toBeNull();
    expect(s.realized7dUsd).toBeNull();
    expect(s.days.find((d) => d.date === '2026-08-11')?.realizedPnlUsd).toBeNull();
    // SOL side stays fully computed.
    expect(s.cumRealizedSol).toBe(3);
  });
});
