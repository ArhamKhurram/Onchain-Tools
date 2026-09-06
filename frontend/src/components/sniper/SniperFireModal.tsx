import { useEffect, useMemo, useState } from 'react';
import SniperModalShell, { SniperModalHeader } from './SniperModalShell';
import {
  computeLegsPreview,
  describeAbortReason,
  estimateFeesPreview,
  triggerTotalPreview,
  type FireResponse,
  type SnipeRule,
  type SniperFeeSettings,
  type SniperWallet,
} from '../../types/sniper';
import type { SniperResult } from '../../lib/sniperApi';
import { cn } from '../../lib/utils';

interface SniperFireModalProps {
  open: boolean;
  rule: SnipeRule | null;
  wallets: SniperWallet[];
  /** Account-level fees this rule inherits where it sets none of its own. */
  fees: SniperFeeSettings;
  /** OCT_SNIPER_DRY_RUN. It overrides the rule flag, so it decides the band. */
  processDryRun: boolean;
  onClose: () => void;
  onFire: (ruleId: string) => Promise<SniperResult<FireResponse>>;
}

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 6 });

/**
 * The manual test buy — the ONE path in this system that reaches executeFire.
 *
 * It shows the legs, the per-leg amount and fee, the trigger total, and which
 * wallets pay, because the operator is about to authorise exactly that. The
 * typed FIRE confirmation is the last of four separate deliberate acts (create →
 * arm → go live → fire); nothing here can be brushed past.
 *
 * Colour discipline, because this is where it matters most:
 *   - the FIRE button is the primary action and wears the accent (oct-btn-primary)
 *   - the LIVE band is solid `warn` — a caution, distinct from the button
 *   - a refused / failed fire is `critical`
 *   - an indeterminate leg is `warn`, a filled one `good`
 * so no state can be mistaken for the button, and the button for no state.
 */
export default function SniperFireModal({
  open,
  rule,
  wallets,
  fees,
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
  const total = useMemo(() => (rule ? triggerTotalPreview(rule, fees) : 0), [rule, fees]);

  // The process flag wins over the rule flag (backend registry.ts) — so the band
  // must be computed the same way, or it would promise DRY RUN on a rule that is
  // live, or vice versa.
  const isDry = processDryRun || (rule?.dryRun ?? true);
  const walletLabel = (walletId: string) => {
    const w = wallets.find((x) => x.walletId === walletId);
    return w?.label || walletId.slice(0, 8);
  };

  const handleFire = async () => {
    if (!rule) return;
    setFiring(true);
    setError(null);
    const res = await onFire(rule.id);
    setFiring(false);
    if (res.ok) setResult(res.data);
    else setError(res.detail ? `${describeAbortReason(res.reason)} (${res.detail})` : describeAbortReason(res.reason));
  };

  // The shell keeps the last-rendered children through the exit fade, so the
  // parent may null `rule` and `open` together without the card going blank.
  return (
    <SniperModalShell open={open && !!rule} onBackdropClick={() => !firing && onClose()} className="max-w-xl">
      {rule && (
        <>
          <SniperModalHeader title={<>Fire &ldquo;{rule.name}&rdquo;</>} onClose={onClose} disabled={firing} />

          <div
            className={cn(
              'px-roomy py-cozy text-center type-label font-mono uppercase tracking-[0.2em] border-b border-oct-border',
              isDry ? 'bg-oct-good-dim text-oct-good' : 'bg-oct-warn text-oct-bg',
            )}
          >
            {isDry ? 'Dry run — no money moves' : `Live — real funds at ${rule.venue}`}
          </div>

          <div className="px-roomy py-comfy space-y-roomy max-h-[60vh] overflow-y-auto">
            {!result ? (
              <>
                <dl className="grid grid-cols-[auto_1fr] gap-x-comfy gap-y-tight type-caption font-mono uppercase tracking-wider text-oct-muted">
                  <dt>mint</dt>
                  <dd className="type-data normal-case tracking-normal text-oct-text break-all">{rule.mint ?? '—'}</dd>
                  <dt>slippage</dt>
                  <dd className="type-data normal-case tracking-normal text-oct-text">{rule.slippageBps} bps</dd>
                </dl>

                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="type-caption font-mono uppercase tracking-wider text-oct-muted border-b border-oct-border">
                      <th className="py-snug font-semibold">Wallet</th>
                      <th className="py-snug font-semibold">Leg</th>
                      <th className="py-snug font-semibold text-right">Amount</th>
                      <th className="py-snug font-semibold text-right">Est. fees</th>
                    </tr>
                  </thead>
                  <tbody>
                    {legs.map((leg) => (
                      <tr key={`${leg.walletId}:${leg.legNo}`} className="border-b border-oct-border/50">
                        <td className="py-snug type-body text-oct-text">{walletLabel(leg.walletId)}</td>
                        <td className="py-snug type-data text-oct-muted">#{leg.legNo}</td>
                        <td className="py-snug type-data text-right text-oct-text">{leg.amount}</td>
                        <td className="py-snug type-data text-right text-oct-muted">
                          {fmt(estimateFeesPreview(rule, leg.amount, fees))}
                        </td>
                      </tr>
                    ))}
                    {legs.length === 0 && (
                      <tr>
                        <td colSpan={4} className="py-comfy type-body text-oct-muted">
                          This rule targets no wallets, so it has no legs to fire.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>

                {/* The figure the operator is authorising, in the stat-tile role. */}
                <div className="flex items-baseline justify-between gap-comfy border-t border-oct-border pt-comfy">
                  <span className="type-caption font-mono uppercase tracking-wider text-oct-muted">
                    Trigger total (amount + fees)
                  </span>
                  <span className="text-right">
                    <span className={cn('type-metric', total > rule.perTriggerCap ? 'text-oct-critical' : 'text-oct-text')}>
                      {fmt(total)}
                    </span>{' '}
                    <span className="type-data text-oct-text">{rule.sizeUnit}</span>
                    <span className="block type-caption font-mono text-oct-muted">
                      per-trigger cap <span className="type-data">{rule.perTriggerCap}</span>
                    </span>
                  </span>
                </div>

                <div>
                  <label
                    htmlFor="sniper-fire-confirm"
                    className="block type-label text-oct-muted mb-snug uppercase tracking-wide"
                  >
                    Type FIRE to enable the button
                  </label>
                  <input
                    id="sniper-fire-confirm"
                    type="text"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    autoComplete="off"
                    className="oct-input w-full px-comfy py-cozy type-body font-mono uppercase tracking-[0.3em]"
                  />
                </div>

                {error && (
                  <p
                    role="alert"
                    className="type-body font-mono text-oct-critical bg-oct-critical-dim border border-oct-critical/50 rounded-oct px-comfy py-cozy"
                  >
                    {error}
                  </p>
                )}
              </>
            ) : (
              <div className="space-y-cozy">
                <p className="type-body font-mono text-oct-muted">
                  outcome:{' '}
                  <span
                    className={cn(
                      'font-bold uppercase',
                      result.outcome === 'fired'
                        ? 'text-oct-good'
                        : result.outcome === 'aborted'
                          ? 'text-oct-critical'
                          : 'text-oct-warn',
                    )}
                  >
                    {result.outcome}
                  </span>
                  {result.reason && <> — {describeAbortReason(result.reason)}</>}
                </p>

                {result.outcome === 'suppressed' && (
                  <p className="type-body text-oct-text bg-oct-warn-dim border border-oct-warn/60 rounded-oct px-comfy py-cozy leading-relaxed">
                    Suppressed — this exact trigger already fired. Press again; each press carries a fresh id.
                  </p>
                )}

                {result.legs.map((leg) => (
                  <div
                    key={`${leg.walletId}:${leg.legNo}`}
                    className="font-mono text-xs border border-oct-border rounded-oct px-comfy py-cozy space-y-hair"
                  >
                    <div className="text-oct-text">
                      {walletLabel(leg.walletId)} · leg <span className="type-data">#{leg.legNo}</span> ·{' '}
                      <span className="type-data">{leg.amount}</span> {rule.sizeUnit}
                    </div>
                    <div
                      className={
                        leg.state === 'filled'
                          ? 'text-oct-good'
                          : leg.state === 'unknown'
                            ? 'text-oct-warn'
                            : leg.state === 'aborted'
                              ? 'text-oct-critical'
                              : 'text-oct-muted'
                      }
                    >
                      {leg.state}
                      {leg.reason && <> — {describeAbortReason(leg.reason)}</>}
                    </div>
                    {leg.signature && <div className="type-data text-oct-muted break-all">sig: {leg.signature}</div>}
                    {leg.state === 'unknown' && (
                      <div className="text-oct-warn">
                        Indeterminate — the reservation is held and this leg will not retry. Resolve it on the Fires tab
                        after checking the venue.
                      </div>
                    )}
                  </div>
                ))}

                {result.ruleDisabled && (
                  <p className="type-body font-mono text-oct-muted">The rule disabled itself after moving money.</p>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-cozy px-roomy py-comfy border-t border-oct-border bg-oct-bg">
            <button type="button" onClick={onClose} disabled={firing} className="oct-icon-btn px-roomy py-cozy type-body">
              {result ? 'Close' : 'Cancel'}
            </button>
            {!result && (
              <button
                type="button"
                onClick={() => void handleFire()}
                disabled={firing || typed.trim().toUpperCase() !== 'FIRE'}
                className="oct-btn-primary px-roomy py-cozy type-body disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {firing ? 'Firing…' : isDry ? 'Fire (dry run)' : 'Fire live'}
              </button>
            )}
          </div>
        </>
      )}
    </SniperModalShell>
  );
}
