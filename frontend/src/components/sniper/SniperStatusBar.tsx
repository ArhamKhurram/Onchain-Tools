import { useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import ConfirmModal from '../ConfirmModal';
import SniperBadge, { sniperBadgeClass } from './SniperBadge';
import { routes } from '../../lib/routes';
import { cn } from '../../lib/utils';
import type { SniperStatus } from '../../types/sniper';

interface SniperStatusBarProps {
  status: SniperStatus | null;
  error: string | null;
  onSetKill: (on: boolean) => Promise<unknown>;
  onRefresh: () => void;
}

/**
 * A headline figure in the bar. `type-metric` is the stat-tile role, sized
 * down to `text-lg` so it sits in a 40px bar — it keeps the bold weight and
 * tabular digits, which is what makes `3/7` read as a figure and not a label.
 */
function Figure({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'critical' }) {
  return (
    <span className="inline-flex items-baseline gap-tight">
      <span
        className={cn(
          'type-metric text-lg',
          tone === 'warn' ? 'text-oct-warn' : tone === 'critical' ? 'text-oct-critical' : 'text-oct-text',
        )}
      >
        {value}
      </span>
      <span className="type-caption font-mono uppercase tracking-wider text-oct-muted">{label}</span>
    </span>
  );
}

/**
 * Always-on-screen chrome: which mode, whether the process dry-run flag is set,
 * whether a venue is connected, how many legs are holding a reservation — and
 * the kill switch, which must be reachable from every tab without navigating.
 *
 * Colour here is a safety signal, not decoration. Kill engaged is `critical`;
 * live-capable and armed are `warn` (money can move); dry-run and connected are
 * `good`. None of them borrow the accent, which in the dark theme is a red —
 * the old bar drew the kill border AND the live-capable pill in it, so "armed
 * and about to spend" and "everything stopped" were the same colour.
 */
export default function SniperStatusBar({ status, error, onSetKill, onRefresh }: SniperStatusBarProps) {
  const [confirming, setConfirming] = useState<'kill' | 'resume' | null>(null);
  const [busy, setBusy] = useState(false);

  const killed = status?.kill.on ?? false;
  const unresolved = status?.counts.unresolvedUnknown ?? 0;

  const apply = async (on: boolean) => {
    setBusy(true);
    await onSetKill(on);
    setBusy(false);
    setConfirming(null);
  };

  return (
    <>
      <div
        className={cn(
          'oct-headerbar shrink-0 flex items-center flex-wrap gap-x-comfy gap-y-snug px-roomy sm:px-section py-cozy',
          killed && 'border-b-oct-critical shadow-[inset_0_-2px_0_0_rgb(var(--oct-critical))]',
        )}
      >
        <span className="oct-eyebrow tracking-[0.2em] text-oct-accent">[ SNIPER ]</span>

        {status && (
          <>
            <div className="flex items-center gap-snug flex-wrap">
              <SniperBadge tone="neutral">{status.mode}</SniperBadge>
              {/* The process flag is env-only and invisible to the browser, so the
                  API reports it and the bar shows it. Mis-reading it is a money bug. */}
              <SniperBadge tone={status.processDryRun ? 'good' : 'warn'}>
                {status.processDryRun ? 'process dry-run' : 'live-capable'}
              </SniperBadge>
              <SniperBadge tone={status.venue.connected ? 'good' : 'neutral'}>
                {status.venue.connected ? 'venue connected' : 'venue not connected'}
              </SniperBadge>
              {killed && <SniperBadge tone="critical">kill switch on</SniperBadge>}
            </div>

            {/* The counts the status endpoint carries. Per-wallet spend and open
                positions live on the Wallets tab against their caps. */}
            <div className="flex items-center gap-comfy pl-comfy border-l border-oct-border">
              <Figure
                label="armed"
                value={`${status.counts.armedRules}/${status.counts.rules}`}
                tone={status.counts.armedRules > 0 && !status.processDryRun ? 'warn' : undefined}
              />
              <Figure label="wallets" value={String(status.counts.wallets)} />
              {unresolved > 0 && (
                <Link
                  to={`${routes.sniper}?view=fires`}
                  className={sniperBadgeClass('warn', 'hover:bg-oct-warn hover:text-oct-bg transition-colors')}
                >
                  {unresolved} unresolved
                </Link>
              )}
            </div>
          </>
        )}

        {error && <span className="type-caption font-mono text-oct-critical">status: {error}</span>}

        <div className="flex-1" />

        <button
          type="button"
          onClick={onRefresh}
          className="oct-icon-btn flex items-center gap-snug px-cozy py-snug type-label uppercase"
        >
          <RefreshCw size={12} />
          refresh
        </button>

        {/* Engaged = critical, solid. Disengaged = a neutral button whose hover
            previews the critical state, so the operator sees what pressing it
            means before the confirm modal even opens. */}
        <button
          type="button"
          disabled={busy || !status}
          onClick={() => setConfirming(killed ? 'resume' : 'kill')}
          className={cn(
            'flex items-center gap-snug px-comfy py-snug type-label font-mono uppercase tracking-wider rounded-oct-sm border transition-all disabled:opacity-50',
            killed
              ? 'bg-oct-critical text-white border-oct-critical'
              : 'bg-oct-surface-raised text-oct-text border-oct-border-bright hover:bg-oct-critical hover:text-white hover:border-oct-critical',
          )}
        >
          {killed ? <ShieldAlert size={12} /> : <ShieldCheck size={12} />}
          {killed ? 'Kill switch on — resume' : 'Kill switch'}
        </button>
      </div>

      <ConfirmModal
        open={confirming === 'kill'}
        title="Turn the kill switch ON?"
        message={
          'Kill switch ON stops every buy fired from this console. It does not stop Slotshark’s own Twitter triggers — ' +
          'to stop those, disable them in Slotshark or defund the wallet.'
        }
        confirmLabel={busy ? 'Working…' : 'Turn it on'}
        onConfirm={() => void apply(true)}
        onCancel={() => setConfirming(null)}
      />

      <ConfirmModal
        open={confirming === 'resume'}
        title="Turn the kill switch OFF?"
        message={
          'Console-fired buys become possible again, subject to each rule’s caps and dry-run flag. This has never had ' +
          'any effect on Slotshark’s own Twitter triggers, which run whether this switch is on or off.'
        }
        confirmLabel={busy ? 'Working…' : 'Resume'}
        onConfirm={() => void apply(false)}
        onCancel={() => setConfirming(null)}
      />
    </>
  );
}
