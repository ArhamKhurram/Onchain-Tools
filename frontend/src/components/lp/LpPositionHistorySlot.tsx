import { LineChart } from 'lucide-react';

/**
 * The PnL / value-history slot.
 *
 * There is no chart here because there is no data, and that is a finding rather
 * than an omission. Krystal's `balance/positionHistory` and
 * `positionEarningStatistic` were both probed live against a real open position
 * on chain 4663 and both returned `{"data":[]}` — the history may simply not be
 * indexed for this chain.
 *
 * So this renders the shape a chart would occupy and says plainly that it is
 * empty. It deliberately does NOT:
 *
 *   - draw an axis with no series on it, which reads as "flat" rather than "absent";
 *   - interpolate between the two points we do have (entry and now), which would
 *     be a drawn claim about a path nobody observed;
 *   - derive a fees-per-day rate by dividing unclaimed fees by an assumed age.
 *
 * On a page about real money, a fabricated line is worse than a blank one. If
 * the upstream data never arrives, this empty state IS the feature: it tells the
 * operator not to go looking for a history that does not exist.
 */
export default function LpPositionHistorySlot() {
  return (
    <div className="border-2 border-oct-border bg-oct-surface-raised">
      <div className="px-3 py-2 border-b-2 border-oct-border flex items-center gap-2">
        <LineChart size={12} strokeWidth={2} className="text-oct-muted shrink-0" />
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-oct-muted">
          Value &amp; fee history
        </p>
      </div>

      <div className="px-4 py-6 min-h-[7rem] flex flex-col items-center justify-center text-center gap-1.5">
        <p className="font-mono text-[11px] text-oct-text">No history available yet.</p>
        <p className="font-mono text-[10px] text-oct-muted leading-relaxed max-w-md">
          The provider returns an empty series for positions on this chain, so there is nothing to plot —
          not a flat line, and not an interpolation between opening and today. The value and fee figures
          above are the current reading only.
        </p>
      </div>
    </div>
  );
}
