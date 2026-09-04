import { useState } from 'react';
import { AlertTriangle, RefreshCw, ScrollText } from 'lucide-react';
import ConsoleEmptyState from '../console/ConsoleEmptyState';
import SniperBadge from './SniperBadge';
import SniperModalShell from './SniperModalShell';
import { describeAbortReason, type SniperFire } from '../../types/sniper';
import type { useSniperFires } from '../../hooks/useSniperFires';

const TH = 'px-comfy py-snug font-semibold';
const TD = 'px-comfy py-snug';

interface SniperFiresTableProps {
  fires: ReturnType<typeof useSniperFires>;
}

function stateLabel(f: SniperFire): string {
  if (f.state === 'aborted') return `aborted: ${f.abortReason ?? 'unknown reason'}`;
  return f.state;
}

/**
 * The fire state column, coloured by what it means for money:
 *   filled   good      — the buy landed (or, on a dry-run row, would have)
 *   unknown  warn      — a reservation is held pending a human decision
 *   aborted  critical  — a fire that was refused or failed; the reason follows
 *   expired  muted     — the window closed before anything was sent
 */
const stateClass = (state: SniperFire['state']) =>
  state === 'filled'
    ? 'text-oct-good'
    : state === 'unknown'
      ? 'text-oct-warn'
      : state === 'aborted'
        ? 'text-oct-critical'
        : 'text-oct-muted';

export default function SniperFiresTable({ fires }: SniperFiresTableProps) {
  const [resolving, setResolving] = useState<SniperFire | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const resolve = async (resolution: 'filled' | 'not_filled') => {
    if (!resolving) return;
    setBusy(true);
    const res = await fires.resolveFire(resolving.id, resolution);
    setBusy(false);
    setResolving(null);
    if (!res.ok) setNotice(res.reason);
  };

  if (!fires.loading && fires.fires.length === 0) {
    return (
      <ConsoleEmptyState
        icon={ScrollText}
        eyebrow="[ SNIPER · FIRES ]"
        title="Nothing has fired"
        description="Every buy this console sends lands here, dry run or live, filled or refused — with the reason spelled out."
        actionLabel="REFRESH"
        onActionClick={() => void fires.refresh()}
      />
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0 bg-oct-bg overflow-hidden">
      {fires.unresolvedUnknown > 0 && (
        <div className="shrink-0 flex items-start gap-cozy px-roomy py-cozy border-b border-oct-border bg-oct-warn-dim border-l-4 border-l-oct-warn">
          <AlertTriangle size={15} className="text-oct-warn shrink-0 mt-hair" strokeWidth={2.5} />
          <p className="font-mono text-xs leading-relaxed text-oct-text">
            {fires.unresolvedUnknown} leg{fires.unresolvedUnknown === 1 ? '' : 's'} holding a reservation — check
            Slotshark and resolve. An indeterminate send may have landed, so OCT keeps its budget debited and never
            retries it. There is no automatic reconciler: no venue fill-history endpoint is known to this codebase, so a
            person has to look and say which way it went.
          </p>
        </div>
      )}

      <div className="oct-headerbar shrink-0 flex items-center gap-comfy px-roomy py-cozy">
        <span className="oct-eyebrow">view: fires</span>
        <div className="flex-1" />
        {notice && <span className="type-caption font-mono text-oct-critical">{notice}</span>}
        <span className="type-data text-oct-muted">{fires.fires.length} rows</span>
        <button
          type="button"
          onClick={() => void fires.refresh()}
          className="oct-icon-btn flex items-center gap-snug px-cozy py-snug type-label uppercase"
        >
          <RefreshCw size={12} />
          refresh
        </button>
      </div>

      {/* Rows re-render on every refresh and are never animated: this is the
          stream, not the chrome. */}
      <div className="flex-1 min-h-0 overflow-auto overscroll-contain" style={{ overflowAnchor: 'none' }}>
        <table className="w-full text-left border-collapse min-w-[1000px]">
          <thead className="oct-thead sticky top-0 z-10">
            <tr className="type-caption font-mono uppercase tracking-wider text-oct-muted">
              <th className={TH}>When</th>
              <th className={TH}>Mode</th>
              <th className={TH}>Venue</th>
              <th className={TH}>Mint</th>
              <th className={`${TH} text-right`}>Amount</th>
              <th className={`${TH} text-right`}>Leg</th>
              <th className={`${TH} text-right`}>Attempts</th>
              <th className={TH}>State</th>
              <th className={TH} />
            </tr>
          </thead>
          <tbody>
            {fires.fires.map((f) => (
              <tr key={f.id} className="border-b border-oct-border/50 oct-row-hover">
                <td className={`${TD} type-data text-oct-muted`}>{new Date(f.at).toLocaleString()}</td>
                <td className={TD}>
                  {/* The one column that must never be ambiguous: a `filled`
                      dry-run row moved no money at all. Live is solid amber —
                      louder than anything else on the row, and not the accent,
                      so it reads as "caution" rather than "button". */}
                  <SniperBadge tone={f.dryRun ? 'good' : 'warnSolid'}>{f.dryRun ? 'dry' : 'live'}</SniperBadge>
                </td>
                <td className={`${TD} type-data text-oct-muted`}>{f.venue}</td>
                <td className={`${TD} type-data text-oct-text`} title={f.mint}>
                  {f.mint ? `${f.mint.slice(0, 6)}…${f.mint.slice(-4)}` : '—'}
                </td>
                <td className={`${TD} type-data text-oct-text text-right`}>{f.amount}</td>
                <td className={`${TD} type-data text-oct-muted text-right`}>#{f.legNo}</td>
                <td className={`${TD} type-data text-oct-muted text-right`}>{f.attempts}</td>
                <td className={`${TD} type-data`}>
                  <span className={stateClass(f.state)}>{stateLabel(f)}</span>
                  {f.abortReason && (
                    <div className="type-caption font-sans text-oct-muted">{describeAbortReason(f.abortReason)}</div>
                  )}
                  {f.resolution && (
                    <div className="type-caption font-sans text-oct-muted">resolved: {f.resolution.replace('_', ' ')}</div>
                  )}
                </td>
                <td className={`${TD} text-right`}>
                  {f.state === 'unknown' && !f.resolution && (
                    <button
                      type="button"
                      onClick={() => setResolving(f)}
                      className="px-cozy py-hair rounded-oct-sm type-caption font-mono font-bold uppercase border border-oct-accent text-oct-accent hover:bg-oct-accent hover:text-white transition-colors"
                    >
                      resolve
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SniperModalShell open={!!resolving} onBackdropClick={() => !busy && setResolving(null)} className="max-w-md">
        {resolving && (
          <>
            <div className="oct-headerbar px-roomy py-comfy">
              <h3 className="type-title uppercase tracking-wide text-oct-text">Resolve this leg</h3>
            </div>
            <div className="px-roomy py-comfy space-y-cozy font-mono text-xs text-oct-muted">
              <p>
                Check Slotshark for a buy of{' '}
                <span className="type-data text-oct-text">
                  {resolving.amount} on {resolving.mint.slice(0, 6)}…{resolving.mint.slice(-4)}
                </span>{' '}
                around <span className="type-data text-oct-text">{new Date(resolving.at).toLocaleString()}</span>, then
                say what you found.
              </p>
              <p className="text-oct-text">
                <strong className="text-oct-good">Filled</strong> — the buy landed; keep the budget debited.
              </p>
              <p className="text-oct-text">
                <strong>Not filled</strong> — release the reservation back to today&rsquo;s budget.
              </p>
            </div>
            <div className="flex items-center justify-end gap-cozy px-roomy py-comfy border-t border-oct-border bg-oct-bg">
              <button type="button" disabled={busy} onClick={() => setResolving(null)} className="oct-icon-btn px-comfy py-cozy type-body">
                Cancel
              </button>
              <button type="button" disabled={busy} onClick={() => void resolve('not_filled')} className="oct-icon-btn px-comfy py-cozy type-body">
                Not filled
              </button>
              <button type="button" disabled={busy} onClick={() => void resolve('filled')} className="oct-btn-primary px-comfy py-cozy type-body">
                Filled
              </button>
            </div>
          </>
        )}
      </SniperModalShell>
    </div>
  );
}
