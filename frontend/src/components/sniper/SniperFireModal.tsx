import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import {
  computeLegsPreview,
  describeAbortReason,
  estimateFeesPreview,
  triggerTotalPreview,
  type FireResponse,
  type SnipeRule,
  type SniperWallet,
} from '../../types/sniper';
import type { SniperResult } from '../../lib/sniperApi';

interface SniperFireModalProps {
  open: boolean;
  rule: SnipeRule | null;
  wallets: SniperWallet[];
  /** OCT_SNIPER_DRY_RUN. It overrides the rule flag, so it decides the band. */
  processDryRun: boolean;
  onClose: () => void;
  onFire: (ruleId: string) => Promise<SniperResult<FireResponse>>;
}

/**
 * The manual test buy — the ONE path in this system that reaches executeFire.
 *
 * It shows the legs, the per-leg amount and fee, the trigger total, and which
 * wallets pay, because the operator is about to authorise exactly that. The
 * typed FIRE confirmation is the last of four separate deliberate acts (create →
 * arm → go live → fire); nothing here can be brushed past.
 */
export default function SniperFireModal({
  open,
  rule,
  wallets,
  processDryRun,
  onClose,
  onFire,
}: SniperFireModalProps) {
  const [typed, setTyped] = useState('');
  const [firing, setFiring] = useState(false);
  const [result, setResult] = useState<FireResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTyped('');
    setFiring(false);
    setResult(null);
    setError(null);
  }, [open, rule?.id]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !firing) onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, firing, onClose]);

  const legs = useMemo(() => (rule ? computeLegsPreview(rule) : []), [rule]);
  const total = useMemo(() => (rule ? triggerTotalPreview(rule) : 0), [rule]);

  if (!open || !rule) return null;

  // The process flag wins over the rule flag (backend registry.ts) — so the band
  // must be computed the same way, or it would promise DRY RUN on a rule that is
  // live, or vice versa.
  const isDry = processDryRun || rule.dryRun;
  const walletLabel = (walletId: string) => {
    const w = wallets.find((x) => x.walletId === walletId);
    return w?.label || walletId.slice(0, 8);
  };

  const handleFire = async () => {
    setFiring(true);
    setError(null);
    const res = await onFire(rule.id);
    setFiring(false);
    if (res.ok) setResult(res.data);
    else setError(res.detail ? `${describeAbortReason(res.reason)} (${res.detail})` : describeAbortReason(res.reason));
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4" onClick={() => !firing && onClose()}>
      <div
        className="w-full max-w-xl rounded-cockpit border-2 border-black bg-oct-surface shadow-oct-hard-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b-2 border-black">
          <h3 className="text-base font-extrabold uppercase text-oct-text">Fire &ldquo;{rule.name}&rdquo;</h3>
          <button
            type="button"
            onClick={onClose}
            disabled={firing}
            className="p-1.5 rounded-md text-oct-muted hover:text-oct-text hover:bg-oct-surface-raised transition-colors disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </div>

        <div
          className={`px-5 py-2.5 text-center font-mono text-xs font-bold uppercase tracking-[0.2em] border-b-2 border-black ${
            isDry ? 'bg-oct-green/15 text-oct-green' : 'bg-oct-accent text-white'
          }`}
        >
          {isDry ? 'Dry run — no money moves' : `Live — real funds at ${rule.venue}`}
        </div>

        <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {!result ? (
            <>
              <div className="font-mono text-xs text-oct-muted space-y-1">
                <div>
                  mint: <span className="text-oct-text">{rule.mint ?? '—'}</span>
                </div>
                <div>
                  slippage: <span className="text-oct-text">{rule.slippageBps} bps</span>
                </div>
              </div>

              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="font-mono text-[10px] font-bold uppercase tracking-wider text-oct-muted border-b-2 border-oct-border">
                    <th className="py-1.5">Wallet</th>
                    <th className="py-1.5">Leg</th>
                    <th className="py-1.5 text-right">Amount</th>
                    <th className="py-1.5 text-right">Est. fees</th>
                  </tr>
                </thead>
                <tbody>
                  {legs.map((leg) => (
                    <tr key={`${leg.walletId}:${leg.legNo}`} className="border-b border-oct-border/50 font-mono text-xs">
                      <td className="py-1.5 text-oct-text">{walletLabel(leg.walletId)}</td>
                      <td className="py-1.5 text-oct-muted">#{leg.legNo}</td>
                      <td className="py-1.5 text-right text-oct-text">{leg.amount}</td>
                      <td className="py-1.5 text-right text-oct-muted">
                        {estimateFeesPreview(rule, leg.amount).toLocaleString(undefined, { maximumFractionDigits: 6 })}
                      </td>
                    </tr>
                  ))}
                  {legs.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-3 font-mono text-xs text-oct-muted">
                        This rule targets no wallets, so it has no legs to fire.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>

              <p className="font-mono text-xs text-oct-text">
                Trigger total (amount + fees):{' '}
                <span className="font-bold">
                  {total.toLocaleString(undefined, { maximumFractionDigits: 6 })} {rule.sizeUnit}
                </span>{' '}
                <span className="text-oct-muted">against a per-trigger cap of {rule.perTriggerCap}</span>
              </p>

              <div>
                <label htmlFor="sniper-fire-confirm" className="block text-xs font-medium text-oct-muted mb-1.5 uppercase tracking-wide">
                  Type FIRE to enable the button
                </label>
                <input
                  id="sniper-fire-confirm"
                  type="text"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  className="w-full px-3 py-2 rounded-cockpit bg-oct-bg border-2 border-oct-border text-sm font-mono uppercase tracking-[0.3em] text-oct-text focus:outline-none focus:border-oct-accent"
                />
              </div>

              {error && (
                <p className="text-sm text-oct-accent bg-oct-accent-dim border-2 border-oct-accent rounded-cockpit px-3 py-2 font-mono">
                  {error}
                </p>
              )}
            </>
          ) : (
            <div className="space-y-3">
              <p className="font-mono text-xs text-oct-muted">
                outcome: <span className="text-oct-text font-bold uppercase">{result.outcome}</span>
                {result.reason && <> — {describeAbortReason(result.reason)}</>}
              </p>

              {result.outcome === 'suppressed' && (
                <p className="text-xs text-oct-text bg-oct-yellow/10 border-2 border-oct-yellow/60 rounded-cockpit px-3 py-2 leading-relaxed">
                  Suppressed — this exact trigger already fired. Press again; each press carries a fresh id.
                </p>
              )}

              {result.legs.map((leg) => (
                <div
                  key={`${leg.walletId}:${leg.legNo}`}
                  className="font-mono text-xs border-2 border-oct-border rounded-cockpit px-3 py-2 space-y-0.5"
                >
                  <div className="text-oct-text">
                    {walletLabel(leg.walletId)} · leg #{leg.legNo} · {leg.amount} {rule.sizeUnit}
                  </div>
                  <div className="text-oct-muted">
                    {leg.state}
                    {leg.reason && <> — {describeAbortReason(leg.reason)}</>}
                  </div>
                  {leg.signature && <div className="text-oct-muted break-all">sig: {leg.signature}</div>}
                  {leg.state === 'unknown' && (
                    <div className="text-oct-yellow">
                      Indeterminate — the reservation is held and this leg will not retry. Resolve it on the Fires tab
                      after checking the venue.
                    </div>
                  )}
                </div>
              ))}

              {result.ruleDisabled && (
                <p className="font-mono text-xs text-oct-muted">The rule disabled itself after moving money.</p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t-2 border-black bg-oct-bg">
          <button type="button" onClick={onClose} disabled={firing} className="brutal-btn-ghost px-4 py-2 text-sm">
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && (
            <button
              type="button"
              onClick={() => void handleFire()}
              disabled={firing || typed.trim().toUpperCase() !== 'FIRE'}
              className="brutal-btn px-4 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {firing ? 'Firing…' : isDry ? 'Fire (dry run)' : 'Fire live'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
