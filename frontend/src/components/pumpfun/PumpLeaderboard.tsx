import { Plus, RefreshCw, Trophy } from 'lucide-react';
import {
  formatPnlUsd,
  leaderboardLabel,
  leaderboardTrackState,
  PUMP_LEADERBOARD_WINDOWS,
  type PumpLeaderboardEntry,
  type PumpLeaderboardWindow,
} from '../../types/pumpfun';
import type { PumpLeaderboardHook } from '../../hooks/usePumpLeaderboard';

interface PumpLeaderboardProps {
  board: PumpLeaderboardHook;
  /** Wallet addresses already on the tracked list, for the tracked/disabled state. */
  trackedAddresses: Set<string>;
  /** Append a wallet to the tracked list (synchronous localStorage reducer). */
  onTrack: (address: string) => void;
}

const WINDOW_LABEL: Record<PumpLeaderboardWindow, string> = {
  '7d': '7D',
  '30d': '30D',
  all: 'ALL',
};

// The ranked leaderboard list — a close mirror of FomoLeaderboard's chrome
// (brutal-card, timeframe pills, per-row Track button, "Tracked" disabled once
// added). The differences are pump-shaped: the window is 7d/30d/all, the row key
// is the wallet, and a row without a usable wallet shows a disabled Track (there
// is nothing to add) rather than being dropped.
export default function PumpLeaderboard({ board, trackedAddresses, onTrack }: PumpLeaderboardProps) {
  const { window, setWindow, entries, loading, error, retryable, refresh } = board;

  return (
    <div className="flex flex-col min-h-0 overflow-hidden h-full brutal-card">
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-3 border-b-2 border-black bg-oct-surface">
        <Trophy size={16} className="text-oct-accent" />
        <h2 className="text-sm font-extrabold uppercase tracking-wide text-oct-text">Leaderboard</h2>
        <div className="flex gap-1">
          {PUMP_LEADERBOARD_WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWindow(w)}
              className={`px-2 py-0.5 rounded-cockpit text-[10px] font-mono font-bold border-2 transition-all ${
                window === w
                  ? 'bg-oct-accent text-white border-black shadow-oct-hard-sm'
                  : 'text-oct-muted border-transparent hover:border-oct-border-bright'
              }`}
            >
              {WINDOW_LABEL[w]}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <span className="font-mono text-[9px] tracking-[0.12em] text-oct-muted uppercase">via pump.fun</span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="p-1.5 rounded-cockpit border-2 border-oct-border-bright text-oct-muted hover:text-oct-text transition-colors disabled:opacity-50"
          title="Refresh leaderboard"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {error && (
          <div className="m-4 px-4 py-3 rounded-cockpit border-2 border-oct-flame/50 bg-oct-flame/10 text-sm text-oct-text">
            <p className="break-words">{error}</p>
            {retryable && (
              <button
                type="button"
                onClick={() => void refresh()}
                className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 rounded-cockpit text-[10px] font-mono font-bold uppercase border-2 border-oct-flame text-oct-flame hover:bg-oct-flame hover:text-white transition-colors"
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
            {entries.map((entry, i) => {
              const state = leaderboardTrackState(entry, trackedAddresses);
              const disabled = state !== 'trackable';
              const pnl = entry.pnl;
              return (
                <li
                  key={entry.walletAddress ?? `${entry.handle ?? entry.displayName ?? 'row'}-${i}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-oct-surface-raised/60 transition-colors"
                >
                  <span className="w-6 text-xs font-mono font-bold text-oct-muted tabular-nums">
                    {entry.rank ?? i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-oct-text truncate">{leaderboardLabel(entry)}</div>
                    <div className="text-xs text-oct-muted truncate">
                      PnL{' '}
                      <span
                        className={
                          pnl == null ? 'text-oct-muted' : pnl >= 0 ? 'text-oct-green' : 'text-oct-flame'
                        }
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
                    className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded-cockpit text-xs font-bold uppercase border-2 transition-colors disabled:opacity-50 ${
                      disabled
                        ? 'border-oct-border text-oct-muted'
                        : 'border-black bg-oct-accent text-white shadow-oct-hard-sm hover:opacity-90'
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
