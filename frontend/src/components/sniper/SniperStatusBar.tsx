import { useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import ConfirmModal from '../ConfirmModal';
import { routes } from '../../lib/routes';
import type { SniperStatus } from '../../types/sniper';

const BADGE = 'text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-oct-sm border';

interface SniperStatusBarProps {
  status: SniperStatus | null;
  error: string | null;
  onSetKill: (on: boolean) => Promise<unknown>;
  onRefresh: () => void;
}

/**
 * Always-on-screen chrome: which mode, whether the process dry-run flag is set,
 * whether a venue is connected, how many legs are holding a reservation — and
 * the kill switch, which must be reachable from every tab without navigating.
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
        className={`oct-headerbar shrink-0 flex items-center flex-wrap gap-2 px-4 sm:px-6 py-2 ${
          killed ? 'border-b-oct-accent shadow-[inset_0_-2px_0_0_rgb(var(--oct-accent))]' : ''
        }`}
      >
        <span className="oct-eyebrow tracking-[0.2em] text-oct-accent">[ SNIPER ]</span>

        {status && (
          <>
            <span className={`${BADGE} border-oct-border text-oct-muted`}>{status.mode}</span>
            {/* The process flag is env-only and invisible to the browser, so the
                API reports it and the bar shows it. Mis-reading it is a money bug. */}
            <span
              className={
                status.processDryRun
                  ? `${BADGE} border-oct-green/60 bg-oct-green/15 text-oct-green`
                  : `${BADGE} border-oct-accent/60 bg-oct-accent/15 text-oct-accent`
              }
            >
              {status.processDryRun ? 'process dry-run' : 'live-capable'}
            </span>
            <span
              className={
                status.venue.connected
                  ? `${BADGE} border-oct-green/60 bg-oct-green/15 text-oct-green`
                  : `${BADGE} border-oct-border text-oct-muted`
              }
            >
              {status.venue.connected ? 'venue connected' : 'venue not connected'}
            </span>
            <span className={`${BADGE} border-oct-border text-oct-muted`}>
              {status.counts.armedRules}/{status.counts.rules} armed
            </span>
            {unresolved > 0 && (
              <Link
                to={`${routes.sniper}?view=fires`}
                className={`${BADGE} border-oct-accent/60 bg-oct-accent/15 text-oct-accent hover:bg-oct-accent hover:text-white transition-colors`}
              >
                {unresolved} unresolved
              </Link>
            )}
          </>
        )}

        {error && <span className="font-mono text-[10px] text-oct-flame">status: {error}</span>}

        <div className="flex-1" />

        <button
          type="button"
          onClick={onRefresh}
          className="oct-icon-btn flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold uppercase"
        >
          <RefreshCw size={12} />
          refresh
        </button>

        <button
          type="button"
          disabled={busy || !status}
          onClick={() => setConfirming(killed ? 'resume' : 'kill')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-bold uppercase tracking-wider rounded-oct-sm border transition-all disabled:opacity-50 ${
            killed
              ? 'bg-oct-accent text-white border-oct-accent/50 shadow-oct-glow-accent'
              : 'bg-oct-surface-raised text-oct-text border-oct-border-bright hover:bg-oct-accent hover:text-white hover:border-oct-accent/50'
          }`}
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
