import { ExternalLink, Plus, RefreshCw, Trophy } from 'lucide-react';
import {
  formatPnlUsd,
  leaderboardLabel,
  leaderboardTrackState,
  PUMP_LEADERBOARD_WINDOWS,
  type PumpLeaderboardEntry,
  type PumpLeaderboardWindow,
} from '../../types/pumpfun';
import type { PumpLeaderboardHook } from '../../hooks/usePumpLeaderboard';
import { SortButton } from '../common/SortHeader';
import { useSort } from '../../hooks/useSort';
import { sortRows, type SortColumn } from '../../lib/sort';

// Sortable dimensions of the board. It renders as a list, not a <table>, so the sort
// controls are a small header STRIP of SortButtons above the rows rather than <th>s.
type LbSortKey = 'rank' | 'handle' | 'pnl';

// Rank and handle open ascending (1-first, A→Z); PnL opens descending (biggest gain
// on top). Module-level so useSort's handler stays referentially stable.
const LB_ASC_FIRST: readonly LbSortKey[] = ['rank', 'handle'];

const LB_COLUMNS: readonly SortColumn<PumpLeaderboardEntry, LbSortKey>[] = [
  { key: 'rank', type: 'numeric', get: (e) => e.rank },
  { key: 'handle', type: 'text', get: (e) => leaderboardLabel(e) },
  { key: 'pnl', type: 'numeric', get: (e) => e.pnlUsd },
];

interface PumpLeaderboardProps {
  board: PumpLeaderboardHook;
  /** Wallet addresses already on the tracked list, for the tracked/disabled state. */
  trackedAddresses: Set<string>;
  /** Append a wallet to the tracked list (synchronous localStorage reducer). */
  onTrack: (address: string) => void;
}

const WINDOW_LABEL: Record<PumpLeaderboardWindow, string> = {
  '1d': '1D',
  '1w': '1W',
  '1m': '1M',
};

// The ranked leaderboard list — a close mirror of FomoLeaderboard's chrome
// (brutal-card, timeframe pills, per-row Track button, "Tracked" disabled once
// added). The differences are pump-shaped: the window is 1D/1W/1M, the row key
// is the wallet, and a row without a usable wallet shows a disabled Track (there
// is nothing to add) rather than being dropped.
export default function PumpLeaderboard({ board, trackedAddresses, onTrack }: PumpLeaderboardProps) {
  const { window, setWindow, entries, loading, error, retryable, refresh } = board;

  // Default rank-ascending mirrors the server order; ties break back to rank so a
  // re-sort by handle or PnL still reads sensibly within equal groups.
  const { sortKey, sortDir, onSort } = useSort<LbSortKey>('rank', 'asc', LB_ASC_FIRST);
  const sortedEntries = sortRows(
    entries,
    LB_COLUMNS,
    sortKey,
    sortDir,
    (a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity),
  );

  return (
    <div className="flex flex-col min-h-0 overflow-hidden h-full oct-card oct-card-flush">
      <div className="oct-headerbar shrink-0 flex flex-wrap items-center gap-2 px-4 py-3">
        <Trophy size={16} className="text-oct-accent-2" />
        <h2 className="oct-section-title uppercase tracking-wide">Leaderboard</h2>
        <div className="flex gap-1">
          {PUMP_LEADERBOARD_WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWindow(w)}
              className={`px-2.5 py-1 rounded-oct-sm text-[11px] font-mono font-bold border transition-all ${
                window === w
                  ? 'bg-oct-accent text-white border-oct-accent/50 shadow-oct-glow-accent'
                  : 'text-oct-muted border-transparent hover:border-oct-border-bright hover:text-oct-text'
              }`}
            >
              {WINDOW_LABEL[w]}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <span className="font-mono text-[10px] tracking-[0.12em] text-oct-muted uppercase">via pump.fun</span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="oct-icon-btn p-2"
          title="Refresh leaderboard"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {entries.length > 0 && (
        <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-oct-border bg-oct-surface/40 font-mono text-[11px] font-bold uppercase tracking-wider">
          <span className="text-oct-muted">sort</span>
          <SortButton<LbSortKey> label="Rank" sortKey="rank" activeKey={sortKey} dir={sortDir} onSort={onSort} />
          <SortButton<LbSortKey> label="Handle" sortKey="handle" activeKey={sortKey} dir={sortDir} onSort={onSort} />
          <SortButton<LbSortKey> label="PnL" sortKey="pnl" activeKey={sortKey} dir={sortDir} onSort={onSort} />
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {error && (
          <div className="m-4 px-4 py-3 rounded-oct border border-oct-flame/40 bg-oct-flame/10 text-sm text-oct-text">
            <p className="break-words">{error}</p>
            {retryable && (
              <button
                type="button"
                onClick={() => void refresh()}
                className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-oct-sm text-[11px] font-mono font-bold uppercase border border-oct-flame/60 text-oct-flame hover:bg-oct-flame hover:text-white transition-colors"
              >
                <RefreshCw size={11} />
                retry
              </button>
            )}
          </div>
        )}
        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : entries.length === 0 && !error ? (
          <div className="py-16 px-6 text-center text-sm text-oct-muted">No leaderboard data.</div>
        ) : (
          <ul className="divide-y divide-oct-border">
            {sortedEntries.map((entry, i) => {
              const state = leaderboardTrackState(entry, trackedAddresses);
              const disabled = state !== 'trackable';
              const pnl = entry.pnlUsd;
              return (
                <li
                  key={entry.walletAddress ?? `${entry.username ?? 'row'}-${i}`}
                  className="flex items-center gap-3 px-4 py-3 oct-row-hover"
                >
                  <span className="w-6 text-[13px] font-mono font-bold text-oct-muted tabular-nums">
                    {entry.rank ?? i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[15px] font-bold text-oct-text truncate">{leaderboardLabel(entry)}</span>
                      {entry.xUsername && (
                        <a
                          href={`https://x.com/${entry.xUsername}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          title={`@${entry.xUsername} on X`}
                          className="shrink-0 inline-flex items-center gap-0.5 text-[10px] font-mono text-oct-muted hover:text-oct-accent transition-colors"
                        >
                          <ExternalLink size={10} />
                          <span className="truncate max-w-[80px]">@{entry.xUsername}</span>
                        </a>
                      )}
                    </div>
                    <div className="text-[13px] text-oct-muted truncate">
                      PnL{' '}
                      <span
                        className={`font-semibold tabular-nums ${
                          pnl == null ? 'text-oct-muted' : pnl >= 0 ? 'text-oct-green' : 'text-oct-flame'
                        }`}
                      >
                        {formatPnlUsd(pnl)}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => entry.walletAddress && onTrack(entry.walletAddress)}
                    disabled={disabled}
                    title={state === 'no-wallet' ? 'No wallet on this row to track' : undefined}
                    className={`shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-oct-sm text-xs font-bold uppercase border transition-all disabled:opacity-50 ${
                      disabled
                        ? 'border-oct-border text-oct-muted'
                        : 'border-oct-accent/50 bg-oct-accent text-white shadow-oct-glow-accent hover:brightness-110'
                    }`}
                  >
                    {state === 'trackable' && <Plus size={12} />}
                    {state === 'tracked' ? 'Tracked' : state === 'no-wallet' ? 'No wallet' : 'Track'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
