import { useEffect, useState } from 'react';
import { Fuel, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { SniperFeeSettings } from '../../types/sniper';

interface SniperFeeBarProps {
  fees: SniperFeeSettings;
  /** Per-venue trading fee rate from the API, so 0.5% is never hardcoded here. */
  venueFeeRate: Record<string, number>;
  error: string | null;
  save: (next: Partial<SniperFeeSettings>) => Promise<{ ok: boolean; reason?: string }>;
}

/**
 * The ACCOUNT-LEVEL fee readout: one combined "prio & tip & trading fees"
 * figure, set once and inherited by every rule.
 *
 * Two numbers are shown rather than one, on purpose. The combined figure is
 * what the operator recognises from other trading UIs, but the trading fee is a
 * PERCENTAGE of the trade and the tip and priority fee are FLAT — so a single
 * number is only true for one trade size. The bar therefore renders the flat
 * part as the headline (it is the part the operator sets) and states the venue
 * rate beside it, with the combined figure quoted per 1 SOL of size.
 *
 * These values feed the previews only. Every fire re-reads the account setting
 * server-side at the top of executeFire, so what is drawn here can be stale but
 * can never be what is reserved.
 */
export default function SniperFeeBar({ fees, venueFeeRate, error, save }: SniperFeeBarProps) {
  const [editing, setEditing] = useState(false);
  const [tip, setTip] = useState(String(fees.tip));
  const [priorityFee, setPriorityFee] = useState(String(fees.priorityFee));
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Re-seed the inputs whenever the loaded value changes and the form is not
  // open — otherwise the first paint's zeroes stick after the fetch resolves.
  useEffect(() => {
    if (editing) return;
    setTip(String(fees.tip));
    setPriorityFee(String(fees.priorityFee));
  }, [fees.tip, fees.priorityFee, editing]);

  const rate = venueFeeRate.slotshark ?? 0.005;
  const flat = fees.tip + fees.priorityFee;
  // Per 1 SOL of size, which is the only way a percentage and a flat amount can
  // share one figure honestly. The unit is stated in the label.
  const combined = flat + rate;

  const submit = async () => {
    setBusy(true);
    setSaveError(null);
    const res = await save({ tip: Number(tip), priorityFee: Number(priorityFee) });
    setBusy(false);
    if (res.ok) {
      setEditing(false);
      return;
    }
    // `invalid_fees` is the server refusing a value rather than coercing it —
    // a coerced zero would silently under-reserve every leg.
    setSaveError(
      res.reason === 'invalid_fees'
        ? 'Each fee must be a number between 0 and 1000.'
        : (res.reason ?? 'Could not save.'),
    );
  };

  return (
    <div className="shrink-0 flex flex-wrap items-center gap-cozy px-roomy sm:px-section py-tight border-b border-oct-border bg-oct-surface">
      <Fuel size={14} className="shrink-0 text-oct-muted" strokeWidth={2.5} />
      <span className="type-caption font-mono uppercase tracking-wider text-oct-muted">
        Prio &amp; tip &amp; trading fees
      </span>

      {editing ? (
        <div className="flex flex-wrap items-center gap-cozy">
          <label className="flex items-center gap-tight type-caption font-mono uppercase tracking-wider text-oct-muted">
            Tip
            <input
              type="number"
              min={0}
              step="0.0001"
              value={tip}
              onChange={(e) => setTip(e.target.value)}
              className="w-24 bg-oct-bg border border-oct-border px-tight py-hair font-mono text-xs text-oct-text"
            />
          </label>
          <label className="flex items-center gap-tight type-caption font-mono uppercase tracking-wider text-oct-muted">
            Priority
            <input
              type="number"
              min={0}
              step="0.0001"
              value={priorityFee}
              onChange={(e) => setPriorityFee(e.target.value)}
              className="w-24 bg-oct-bg border border-oct-border px-tight py-hair font-mono text-xs text-oct-text"
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="inline-flex items-center gap-tight border border-oct-border px-cozy py-hair font-mono text-xs font-bold uppercase tracking-wider text-oct-text hover:bg-oct-surface-raised disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : null}
            Save
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setSaveError(null);
            }}
            className="font-mono text-xs uppercase tracking-wider text-oct-muted hover:text-oct-text"
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          <span className="type-metric text-lg text-oct-text">{combined.toFixed(4)}</span>
          <span className="type-caption font-mono uppercase tracking-wider text-oct-muted">
            SOL per 1 SOL of size — {flat.toFixed(4)} flat (tip {fees.tip} + prio {fees.priorityFee}) +{' '}
            {(rate * 100).toFixed(2)}% venue
          </span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="font-mono text-xs font-bold uppercase tracking-wider text-oct-accent hover:underline"
          >
            Edit
          </button>
        </>
      )}

      <span className="type-caption font-mono text-oct-muted">
        Applies to every rule. A rule that sets its own tip keeps it.
      </span>

      {(saveError || error) && (
        <span className={cn('font-mono text-xs', 'text-oct-critical')}>{saveError ?? error}</span>
      )}
    </div>
  );
}
