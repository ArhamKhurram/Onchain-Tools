import { ExternalLink, Heart, MessageCircle } from 'lucide-react';
import { SortHeader } from '../common/SortHeader';
import { useSort } from '../../hooks/useSort';
import { sortRows, type SortColumn } from '../../lib/sort';
import { formatMcap, formatMultiplier, truncateAddress, type PumpCallout } from '../../types/pumpfun';

const TH = 'px-3 py-2 font-medium';

// The sortable keys of the callout table. The Token column is intentionally NOT
// here — it identifies the coin, it does not rank the row — so it renders as a plain
// header while the other five are click-to-sort.
type CalloutSortKey = 'caller' | 'mcap' | 'now' | 'max' | 'when';

// Text columns open A→Z; the numeric ones open biggest-first. Module-level so
// useSort's memoised handler stays stable.
const CALLOUT_ASC_FIRST: readonly CalloutSortKey[] = ['caller'];

// How each sortable column pulls its value out of a callout. The numeric columns
// read the RAW vendor fields (not the formatted cell text), so "$17.83M" sorts above
// "$18M"-that-rounds-from-17.6M correctly — sorting by value, never by the display
// string. `when` parses the ISO timestamp to epoch ms.
const CALLOUT_COLUMNS: readonly SortColumn<PumpCallout, CalloutSortKey>[] = [
  { key: 'caller', type: 'text', get: (c) => c.displayName ?? c.username ?? '' },
  { key: 'mcap', type: 'numeric', get: (c) => c.calloutMarketCap },
  { key: 'now', type: 'numeric', get: (c) => c.multiplier },
  { key: 'max', type: 'numeric', get: (c) => c.maxMultiplier },
  { key: 'when', type: 'numeric', get: (c) => (c.createdAt ? Date.parse(c.createdAt) : null) },
];

// A callout table, shared by the wallet panel (a caller's history) and the token
// panel (a token's calls). Callouts are pump.fun's own attribution — the header
// says so — and every numeric cell degrades to an em dash rather than a zero when
// the vendor omitted it (formatMultiplier/formatMcap), so a missing basis never
// reads as a wipe.
//
// The columns are click-to-sort (shared SortHeader), defaulting to newest-first. A
// Token column surfaces WHICH coin each callout is for: its ticker when the caller
// supplied one (the token panel knows the symbol for every row and passes it), else
// the short mint from the callout's own tokenAddress.
export default function PumpCalloutList({
  callouts,
  tokenSymbol,
}: {
  callouts: PumpCallout[];
  /** Ticker for the coin when the whole list is one known token (the token panel).
   *  Omitted in the wallet panel, where each row is a different coin. */
  tokenSymbol?: string | null;
}) {
  const { sortKey, sortDir, onSort } = useSort<CalloutSortKey>('when', 'desc', CALLOUT_ASC_FIRST);

  // Break ties on recency so equal-ranked calls stay newest-first, matching the
  // default view rather than falling back to arrival order.
  const sorted = sortRows(callouts, CALLOUT_COLUMNS, sortKey, sortDir, (a, b) => {
    const at = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
    return bt - at;
  });

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse min-w-[960px]">
        <thead className="oct-thead sticky top-0 z-10">
          <tr className="font-mono text-[11px] font-bold uppercase tracking-wider text-oct-muted">
            <SortHeader<CalloutSortKey> label="Caller" sortKey="caller" activeKey={sortKey} dir={sortDir} onSort={onSort} />
            <th className={TH}>Token</th>
            <th className={`${TH} w-full`}>Call</th>
            <SortHeader<CalloutSortKey> label="Mcap @ call" sortKey="mcap" activeKey={sortKey} dir={sortDir} onSort={onSort} align="right" />
            <SortHeader<CalloutSortKey> label="Now" sortKey="now" activeKey={sortKey} dir={sortDir} onSort={onSort} align="right" />
            <SortHeader<CalloutSortKey> label="Max" sortKey="max" activeKey={sortKey} dir={sortDir} onSort={onSort} align="right" />
            <SortHeader<CalloutSortKey> label="When" sortKey="when" activeKey={sortKey} dir={sortDir} onSort={onSort} align="right" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => (
            <tr key={c.id} className="border-b border-oct-border/50 oct-row-hover align-top">
              <td className="px-3 py-2.5 font-mono text-[13px] text-oct-text">
                <div className="flex items-center gap-2">
                  {c.profileImageUrl ? (
                    <img
                      src={c.profileImageUrl}
                      alt=""
                      loading="lazy"
                      className="h-6 w-6 rounded-full object-cover shrink-0 bg-oct-surface-raised"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                      }}
                    />
                  ) : (
                    <span className="h-6 w-6 rounded-full bg-oct-surface-raised shrink-0" />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate max-w-[110px]" title={c.displayName ?? c.username ?? undefined}>
                        {c.displayName ?? c.username ?? '—'}
                      </span>
                      {c.userTwitterUrl && (
                        <a href={c.userTwitterUrl} target="_blank" rel="noreferrer noopener" className="text-oct-muted hover:text-oct-accent shrink-0">
                          <ExternalLink size={11} />
                        </a>
                      )}
                    </div>
                    {c.username && c.displayName && (
                      <div className="text-[10px] text-oct-muted truncate">@{c.username}</div>
                    )}
                  </div>
                </div>
              </td>
              <td className="px-3 py-2">
                <CalloutToken symbol={tokenSymbol} mint={c.tokenAddress} />
              </td>
              {/* The thesis itself — the whole point of a callout, and the thing the
                  bare table left out. Wraps to a couple of lines; likes/replies sit
                  under it as the engagement footer the app shows. */}
              <td className="px-3 py-2 align-top">
                {c.content ? (
                  <p className="text-[13px] text-oct-text leading-snug whitespace-pre-wrap break-words line-clamp-3 max-w-[420px]">
                    {c.content}
                  </p>
                ) : (
                  <span className="text-[13px] text-oct-muted">—</span>
                )}
                {((c.likeCount ?? 0) > 0 || (c.replyCount ?? 0) > 0) && (
                  <div className="mt-1 flex items-center gap-3 text-[10px] text-oct-muted">
                    {(c.likeCount ?? 0) > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <Heart size={10} /> {c.likeCount}
                      </span>
                    )}
                    {(c.replyCount ?? 0) > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <MessageCircle size={10} /> {c.replyCount}
                      </span>
                    )}
                  </div>
                )}
              </td>
              <td className="px-3 py-2.5 font-mono text-[13px] text-oct-text text-right tabular-nums">{formatMcap(c.calloutMarketCap)}</td>
              <td className={`px-3 py-2.5 font-mono text-[13px] font-semibold text-right tabular-nums ${multiplierClass(c.multiplier)}`}>
                {formatMultiplier(c.multiplier)}
              </td>
              <td className="px-3 py-2.5 font-mono text-[13px] text-oct-muted text-right tabular-nums">{formatMultiplier(c.maxMultiplier)}</td>
              <td className="px-3 py-2.5 font-mono text-xs text-oct-muted text-right whitespace-nowrap">
                {c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The coin a callout is about. Shows the `$TICKER` (same mono ticker styling the feed
 * uses) when a symbol is known, and the short mint underneath as the durable
 * identifier. With no symbol the short mint stands alone; with neither, an em dash —
 * a callout should never look like it is about nothing.
 */
function CalloutToken({ symbol, mint }: { symbol?: string | null; mint: string | null }) {
  const short = mint ? truncateAddress(mint) : null;
  if (!symbol && !short) return <span className="font-mono text-xs text-oct-muted">—</span>;
  return (
    <div className="min-w-0">
      {symbol && (
        <span className="font-mono text-xs font-semibold text-oct-text truncate block" title={mint ?? undefined}>
          ${symbol}
        </span>
      )}
      {short && (
        <span
          className={`font-mono text-[10px] text-oct-muted truncate block ${symbol ? '' : 'text-xs text-oct-text'}`}
          title={mint ?? undefined}
        >
          {short}
        </span>
      )}
    </div>
  );
}

/** Green above 1x, red below, muted when unknown — the one cell worth colouring. */
function multiplierClass(m: number | null): string {
  if (m === null || !Number.isFinite(m)) return 'text-oct-muted';
  if (m >= 1) return 'text-oct-green';
  return 'text-oct-flame';
}
