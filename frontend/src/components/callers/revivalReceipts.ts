/**
 * Pure receipt math for the Revival tab — turns the fetched alert rows into
 * the stats rendered above the log (see RevivalStats.tsx).
 *
 * Honesty rules, encoded here so the UI can't fudge them:
 * - Peak stats (median peak, ≥2× rate) use CLOSED outcome windows only. A
 *   fresh row starts life with peakMultiple = 1.0 (see buildAlertEntry in
 *   backend/src/revival/outcomeTracker.ts), so counting open windows would
 *   drown the signal in 1.0× "duds" that simply haven't had time to move.
 * - Rows whose alert price was unknown at fire time keep peakMultiple = null
 *   forever. A null is missing evidence, not a dud, so those rows are
 *   excluded from both the numerator and the denominator of the ≥2× rate
 *   (and can't contribute to the median).
 * - runMultiple is fixed at fire time, so its median spans open AND closed
 *   rows — but pre-#125 rows (no baseline) are null and are skipped.
 * - Best catch is a max, and observed peaks only ever improve, so open
 *   windows may contribute — but only once the tracker has actually observed
 *   an improvement (peakMultiple > 1). The 1.0× initialisation of a
 *   just-fired row is not a catch. Closed rows qualify at any value: a wall
 *   of 1.0× duds producing a "best catch" of 1.00× is a receipt too.
 *
 * `nowMs` is a parameter (never Date.now() in here) so the 7d window is
 * deterministic under test.
 */

import type { RevivalAlertEntry } from '../../types';

export const SEVEN_DAYS_MS = 7 * 24 * 3_600_000;

export interface RevivalBestCatch {
  symbol: string | null;
  mint: string;
  peakMultiple: number;
  /** Market cap AT the alert (what you could have entered at), not at peak. */
  mcapUsd: number | null;
  /** False when the outcome window is still open (peak may yet improve). */
  closed: boolean;
}

export interface RevivalReceipts {
  /** Rows in the fetched window (the API caps the list — see RevivalStats). */
  totalAlerts: number;
  /** Alerts fired within the trailing 7 days of `nowMs`. */
  alerts7d: number;
  /** Rows whose 24h outcome window has closed. */
  closedCount: number;
  /** Closed rows with a measurable peak (non-null peakMultiple). */
  closedMeasuredCount: number;
  /** Measurable closed rows whose peak reached ≥2×. */
  closed2xCount: number;
  /** Median peakMultiple over measurable closed rows. Null when none. */
  medianPeakMultiple: number | null;
  /** closed2xCount / closedMeasuredCount as a 0–100 %. Null when none. */
  rate2xPct: number | null;
  bestCatch: RevivalBestCatch | null;
  /** Median runMultiple over rows that have one (open or closed). Null when none. */
  medianRunMultiple: number | null;
}

/** Standard median: mean of the two middle values on even counts. Null on empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeRevivalReceipts(
  alerts: readonly RevivalAlertEntry[],
  nowMs: number,
): RevivalReceipts {
  const cutoff7d = nowMs - SEVEN_DAYS_MS;

  let alerts7d = 0;
  let closedCount = 0;
  let closed2xCount = 0;
  const closedPeaks: number[] = [];
  const runMultiples: number[] = [];
  let bestCatch: RevivalBestCatch | null = null;

  for (const a of alerts) {
    const triggeredMs = Date.parse(a.triggeredAt);
    if (Number.isFinite(triggeredMs) && triggeredMs >= cutoff7d) alerts7d += 1;

    const closed = a.outcomeWindowClosedAt != null;
    const peak =
      a.peakMultiple != null && Number.isFinite(a.peakMultiple) ? a.peakMultiple : null;

    if (closed) {
      closedCount += 1;
      if (peak != null) {
        closedPeaks.push(peak);
        if (peak >= 2) closed2xCount += 1;
      }
    }

    if (a.runMultiple != null && Number.isFinite(a.runMultiple)) {
      runMultiples.push(a.runMultiple);
    }

    const catchCandidate = peak != null && (closed || peak > 1);
    if (catchCandidate && (bestCatch == null || peak > bestCatch.peakMultiple)) {
      bestCatch = {
        symbol: a.symbol,
        mint: a.mint,
        peakMultiple: peak,
        mcapUsd: a.mcapUsd,
        closed,
      };
    }
  }

  return {
    totalAlerts: alerts.length,
    alerts7d,
    closedCount,
    closedMeasuredCount: closedPeaks.length,
    closed2xCount,
    medianPeakMultiple: median(closedPeaks),
    rate2xPct: closedPeaks.length > 0 ? (closed2xCount / closedPeaks.length) * 100 : null,
    bestCatch,
    medianRunMultiple: median(runMultiples),
  };
}
