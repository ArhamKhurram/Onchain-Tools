/**
 * Journal summary arithmetic — the header stat row, cumulative realized PnL
 * curve, and day list, all derived from the pairing engine's output. Pure and
 * unit-tested (journalStats.test.ts): the give-back meter is the point of the
 * whole feature, so its numbers are computed here rather than assembled inline
 * in a route.
 *
 * The give-back meter = distance of cumulative realized PnL below its
 * all-time high. The 7-wallet audit showed run-up→give-back cycles going
 * unnoticed until the money was gone; this makes the current giveback a
 * number the operator sees every time the tab opens.
 */

import type {
  JournalCurvePoint,
  JournalDayRow,
  JournalPosition,
  JournalSummary,
} from '@oct/shared';
import type { RealizedEvent } from './positions.js';

export const SEVEN_DAYS_MS = 7 * 24 * 3_600_000;

export function buildJournalSummary(
  events: RealizedEvent[],
  positions: JournalPosition[],
  totalTrades: number,
  now: number = Date.now(),
): JournalSummary {
  const ordered = [...events].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  // --- Curve + peak/drawdown (SOL is canonical; USD best-effort) ---
  const curve: JournalCurvePoint[] = [];
  let cumSol = 0;
  let cumUsd = 0;
  let usdComplete = true;
  let peakSol = 0;
  let peakUsd = 0;
  for (const e of ordered) {
    cumSol += e.pnlSol ?? 0;
    if (e.pnlUsd != null) cumUsd += e.pnlUsd;
    else if (e.pnlSol != null && e.pnlSol !== 0) usdComplete = false;
    if (cumSol > peakSol) peakSol = cumSol;
    if (cumUsd > peakUsd) peakUsd = cumUsd;
    curve.push({ ts: e.ts, cumSol: round4(cumSol), cumUsd: usdComplete ? round2(cumUsd) : null });
  }

  // --- Day list (UTC days, newest first) ---
  const dayMap = new Map<string, { trades: number; sol: number; usd: number; usdKnown: boolean }>();
  for (const e of ordered) {
    const day = e.ts.slice(0, 10);
    const row = dayMap.get(day) ?? { trades: 0, sol: 0, usd: 0, usdKnown: true };
    row.trades += 1;
    row.sol += e.pnlSol ?? 0;
    if (e.pnlUsd != null) row.usd += e.pnlUsd;
    else row.usdKnown = false;
    dayMap.set(day, row);
  }
  const days: JournalDayRow[] = [...dayMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, r]) => ({
      date,
      trades: r.trades,
      realizedPnlSol: round4(r.sol),
      realizedPnlUsd: r.usdKnown ? round2(r.usd) : null,
    }));

  // --- 7d realized ---
  const sinceMs = now - SEVEN_DAYS_MS;
  let realized7dSol = 0;
  let realized7dUsd = 0;
  let realized7dUsdKnown = true;
  for (const e of ordered) {
    if (new Date(e.ts).getTime() < sinceMs) continue;
    realized7dSol += e.pnlSol ?? 0;
    if (e.pnlUsd != null) realized7dUsd += e.pnlUsd;
    else realized7dUsdKnown = false;
  }

  // --- Win rate over closed episodes ---
  const closed = positions.filter((p) => p.status === 'closed');
  const wins = closed.filter((p) => p.realizedPnlSol > 0).length;

  return {
    totalTrades,
    realized7dSol: round4(realized7dSol),
    realized7dUsd: realized7dUsdKnown ? round2(realized7dUsd) : null,
    winRate: closed.length > 0 ? wins / closed.length : null,
    closedEpisodes: closed.length,
    openEpisodes: positions.filter((p) => p.status === 'open').length,
    cumRealizedSol: round4(cumSol),
    cumRealizedUsd: usdComplete ? round2(cumUsd) : null,
    peakCumRealizedSol: round4(peakSol),
    drawdownFromPeakSol: round4(Math.max(peakSol - cumSol, 0)),
    drawdownFromPeakUsd: usdComplete ? round2(Math.max(peakUsd - cumUsd, 0)) : null,
    curve,
    days,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
