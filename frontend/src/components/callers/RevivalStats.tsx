import { useMemo } from 'react';
import type { RevivalAlertEntry } from '../../types';
import { formatMcap } from '../../types/pumpfun';
import { computeRevivalReceipts } from './revivalReceipts';

type Tone = 'default' | 'green' | 'muted';

function toneClass(tone: Tone): string {
  if (tone === 'green') return 'text-oct-green';
  if (tone === 'muted') return 'text-oct-muted';
  return '';
}

function Tile({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: Tone;
}) {
  return (
    <div className="oct-stat-tile min-w-[132px] flex-1">
      <p className="oct-stat-label mb-1.5">{label}</p>
      <p className={`oct-stat-value truncate ${toneClass(tone)}`.trim()}>{value}</p>
      {sub && <p className="font-mono text-[11px] text-oct-muted mt-1.5 truncate">{sub}</p>}
    </div>
  );
}

/**
 * Receipts row for the Revival tab — the at-a-glance answer to "is this
 * signal earning its keep?", rendered above the alert log. All math lives in
 * revivalReceipts.ts (pure, unit-tested); this file is presentation only.
 *
 * A stat with no evidence yet renders a muted "—", never a fake zero. Green
 * is reserved for receipts worth keeping (a ≥2× hit rate clearing 25%, a
 * best catch that at least doubled) — this is a ledger, not a dashboard.
 *
 * When the fetched list hits the API's row cap the stats cover only that
 * trailing window, and the row says so instead of posing as all-time.
 */
export default function RevivalStats({
  alerts,
  fetchLimit,
}: {
  alerts: RevivalAlertEntry[];
  /** The `limit` used by the fetch; at/above it the stats window is truncated. */
  fetchLimit?: number;
}) {
  const stats = useMemo(() => computeRevivalReceipts(alerts, Date.now()), [alerts]);
  if (stats.totalAlerts === 0) return null;

  const truncated = fetchLimit != null && stats.totalAlerts >= fetchLimit;
  const { medianPeakMultiple, medianRunMultiple, rate2xPct, bestCatch } = stats;
  const bestSym =
    bestCatch == null ? null : bestCatch.symbol ? `$${bestCatch.symbol}` : `${bestCatch.mint.slice(0, 6)}…`;

  return (
    <div className="shrink-0 px-4 pt-3">
      {truncated && (
        <p className="oct-stat-label mb-2">
          receipts cover the last {stats.totalAlerts} alerts — older history is not fetched
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Tile
          label="Alerts (7d)"
          value={String(stats.alerts7d)}
          sub={truncated ? `of last ${stats.totalAlerts}` : `of ${stats.totalAlerts} total`}
        />
        <Tile
          label="Tracked to close"
          value={String(stats.closedCount)}
          sub={stats.closedCount === 0 ? 'windows still open' : `of ${stats.totalAlerts} alerts`}
        />
        <Tile
          label="Median peak"
          value={medianPeakMultiple != null ? `${medianPeakMultiple.toFixed(2)}×` : '—'}
          tone={medianPeakMultiple != null ? 'default' : 'muted'}
          sub={
            medianPeakMultiple == null
              ? 'no closed windows yet'
              : medianRunMultiple != null
                ? `run @ alert ${medianRunMultiple.toFixed(2)}× median`
                : `over ${stats.closedMeasuredCount} closed`
          }
        />
        <Tile
          label="≥2× rate"
          value={rate2xPct != null ? `${Math.round(rate2xPct)}%` : '—'}
          tone={rate2xPct == null ? 'muted' : rate2xPct >= 25 ? 'green' : 'default'}
          sub={
            rate2xPct != null
              ? `${stats.closed2xCount} of ${stats.closedMeasuredCount} closed`
              : 'awaiting closed windows'
          }
        />
        <Tile
          label="Best catch"
          value={bestCatch != null ? `${bestSym} ${bestCatch.peakMultiple.toFixed(2)}×` : '—'}
          tone={bestCatch == null ? 'muted' : bestCatch.peakMultiple >= 2 ? 'green' : 'default'}
          sub={
            bestCatch != null
              ? `alerted @ ${formatMcap(bestCatch.mcapUsd)}${bestCatch.closed ? '' : ' · still tracking'}`
              : 'nothing measurable yet'
          }
        />
      </div>
    </div>
  );
}
