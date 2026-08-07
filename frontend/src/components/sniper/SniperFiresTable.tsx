import { useState } from 'react';
import { AlertTriangle, RefreshCw, ScrollText } from 'lucide-react';
import ConsoleEmptyState from '../console/ConsoleEmptyState';
import { describeAbortReason, type SniperFire } from '../../types/sniper';
import type { useSniperFires } from '../../hooks/useSniperFires';

const TH = 'px-3 py-2 font-medium';

interface SniperFiresTableProps {
  fires: ReturnType<typeof useSniperFires>;
}

function stateLabel(f: SniperFire): string {
  if (f.state === 'aborted') return `aborted: ${f.abortReason ?? 'unknown reason'}`;
  return f.state;
}

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
        <div className="shrink-0 flex items-start gap-2.5 px-4 py-2.5 border-b-2 border-black bg-oct-accent/10 border-l-4 border-l-oct-accent">
          <AlertTriangle size={14} className="text-oct-accent shrink-0 mt-0.5" strokeWidth={2.5} />
          <p className="font-mono text-[11px] leading-relaxed text-oct-text">
            {fires.unresolvedUnknown} leg{fires.unresolvedUnknown === 1 ? '' : 's'} holding a reservation — check
            Slotshark and resolve. An indeterminate send may have landed, so OCT keeps its budget debited and never
            retries it. There is no automatic reconciler: no venue fill-history endpoint is known to this codebase, so a
            person has to look and say which way it went.
          </p>
        </div>
      )}

      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b-2 border-black bg-oct-surface">
        <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-oct-muted">view: fires</span>
        <div className="flex-1" />
        {notice && <span className="font-mono text-[11px] text-oct-flame">{notice}</span>}
        <span className="font-mono text-[11px] text-oct-muted">{fires.fires.length} rows</span>
        <button
          type="button"
          onClick={() => void fires.refresh()}
          className="flex items-center gap-1.5 px-2 py-1 rounded-cockpit text-xs font-bold uppercase text-oct-muted hover:text-oct-text border-2 border-oct-border-bright hover:border-oct-text transition-colors"
        >
          <RefreshCw size={12} />
          refresh
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto overscroll-contain" style={{ overflowAnchor: 'none' }}>
        <table className="w-full text-left border-collapse min-w-[1000px]">
          <thead className="sticky top-0 bg-oct-surface border-b-2 border-black z-10">
            <tr className="font-mono text-[10px] font-bold uppercase tracking-wider text-oct-muted">
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
              <tr key={f.id} className="border-b border-oct-border/50 hover:bg-oct-surface-raised/50 transition-colors">
                <td className="px-3 py-2 font-mono text-xs text-oct-muted">{new Date(f.at).toLocaleString()}</td>
                <td className="px-3 py-2">
                  {/* The one column that must never be ambiguous: a `filled`
                      dry-run row moved no money at all. */}
                  <span
                    className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-cockpit border-2 ${
                      f.dryRun
                        ? 'border-oct-green/60 bg-oct-green/15 text-oct-green'
                        : 'border-oct-accent bg-oct-accent text-white'
                    }`}
                  >
                    {f.dryRun ? 'dry' : 'live'}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-oct-muted">{f.venue}</td>
                <td className="px-3 py-2 font-mono text-xs text-oct-text" title={f.mint}>
                  {f.mint ? `${f.mint.slice(0, 6)}…${f.mint.slice(-4)}` : '—'}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-oct-text text-right">{f.amount}</td>
                <td className="px-3 py-2 font-mono text-xs text-oct-muted text-right">#{f.legNo}</td>
                <td className="px-3 py-2 font-mono text-xs text-oct-muted text-right">{f.attempts}</td>
                <td className="px-3 py-2 font-mono text-xs">
                  <span
                    className={
                      f.state === 'filled'
                        ? 'text-oct-green'
                        : f.state === 'unknown'
                          ? 'text-oct-yellow'
                          : 'text-oct-muted'
                    }
                  >
                    {stateLabel(f)}
                  </span>
                  {f.abortReason && (
                    <div className="text-[10px] text-oct-muted">{describeAbortReason(f.abortReason)}</div>
                  )}
                  {f.resolution && (
                    <div className="text-[10px] text-oct-muted">resolved: {f.resolution.replace('_', ' ')}</div>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  {f.state === 'unknown' && !f.resolution && (
                    <button
                      type="button"
                      onClick={() => setResolving(f)}
                      className="px-2 py-0.5 rounded-cockpit text-[10px] font-mono font-bold uppercase border-2 border-oct-accent text-oct-accent hover:bg-oct-accent hover:text-white transition-colors"
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

      {resolving && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4" onClick={() => !busy && setResolving(null)}>
          <div
            className="w-full max-w-md rounded-cockpit border-2 border-black bg-oct-surface shadow-oct-hard-lg overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b-2 border-black">
              <h3 className="text-base font-extrabold uppercase text-oct-text">Resolve this leg</h3>
            </div>
            <div className="px-5 py-4 space-y-3 font-mono text-xs text-oct-muted">
              <p>
                Check Slotshark for a buy of{' '}
                <span className="text-oct-text">
                  {resolving.amount} on {resolving.mint.slice(0, 6)}…{resolving.mint.slice(-4)}
                </span>{' '}
                around {new Date(resolving.at).toLocaleString()}, then say what you found.
              </p>
              <p className="text-oct-text">
                <strong>Filled</strong> — the buy landed; keep the budget debited.
              </p>
              <p className="text-oct-text">
                <strong>Not filled</strong> — release the reservation back to today&rsquo;s budget.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t-2 border-black bg-oct-bg">
              <button type="button" disabled={busy} onClick={() => setResolving(null)} className="brutal-btn-ghost px-3 py-2 text-sm">
                Cancel
              </button>
              <button type="button" disabled={busy} onClick={() => void resolve('not_filled')} className="brutal-btn-ghost px-3 py-2 text-sm">
                Not filled
              </button>
              <button type="button" disabled={busy} onClick={() => void resolve('filled')} className="brutal-btn px-3 py-2 text-sm">
                Filled
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
