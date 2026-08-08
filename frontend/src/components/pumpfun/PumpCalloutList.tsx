import { ExternalLink } from 'lucide-react';
import { formatMcap, formatMultiplier, type PumpCallout } from '../../types/pumpfun';

const TH = 'px-3 py-2 font-medium';

// A callout table, shared by the wallet panel (a caller's history) and the token
// panel (a token's calls). Callouts are pump.fun's own attribution — the header
// says so — and every numeric cell degrades to an em dash rather than a zero when
// the vendor omitted it (formatMultiplier/formatMcap), so a missing basis never
// reads as a wipe.
export default function PumpCalloutList({ callouts }: { callouts: PumpCallout[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse min-w-[720px]">
        <thead className="sticky top-0 bg-oct-surface border-b-2 border-black z-10">
          <tr className="font-mono text-[10px] font-bold uppercase tracking-wider text-oct-muted">
            <th className={TH}>Caller</th>
            <th className={TH}>Call</th>
            <th className={`${TH} text-right`}>Mcap @ call</th>
            <th className={`${TH} text-right`}>Now</th>
            <th className={`${TH} text-right`}>Max</th>
            <th className={`${TH} text-right`}>When</th>
          </tr>
        </thead>
        <tbody>
          {callouts.map((c) => (
            <tr key={c.id} className="border-b border-oct-border/50 hover:bg-oct-surface-raised/50 transition-colors align-top">
              <td className="px-3 py-2 font-mono text-xs text-oct-text">
                <div className="flex items-center gap-1.5">
                  <span className="truncate max-w-[120px]" title={c.displayName ?? c.username ?? undefined}>
                    {c.displayName ?? c.username ?? '—'}
                  </span>
                  {c.userTwitterUrl && (
                    <a href={c.userTwitterUrl} target="_blank" rel="noreferrer noopener" className="text-oct-muted hover:text-oct-accent shrink-0">
                      <ExternalLink size={11} />
                    </a>
                  )}
                </div>
                {c.username && c.displayName && (
                  <div className="text-[10px] text-oct-muted">@{c.username}</div>
                )}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-oct-muted max-w-[280px]">
                <span className="line-clamp-2 break-words">{c.content ?? '—'}</span>
              </td>
              <td className="px-3 py-2 font-mono text-xs text-oct-text text-right">{formatMcap(c.calloutMarketCap)}</td>
              <td className={`px-3 py-2 font-mono text-xs text-right ${multiplierClass(c.multiplier)}`}>
                {formatMultiplier(c.multiplier)}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-oct-muted text-right">{formatMultiplier(c.maxMultiplier)}</td>
              <td className="px-3 py-2 font-mono text-[11px] text-oct-muted text-right whitespace-nowrap">
                {c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Green above 1x, red below, muted when unknown — the one cell worth colouring. */
function multiplierClass(m: number | null): string {
  if (m === null || !Number.isFinite(m)) return 'text-oct-muted';
  if (m >= 1) return 'text-oct-green';
  return 'text-oct-flame';
}
