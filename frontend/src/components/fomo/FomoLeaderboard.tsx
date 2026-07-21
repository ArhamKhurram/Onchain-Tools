import { Plus, RefreshCw, Trophy } from 'lucide-react';
import { useFomoLeaderboard } from '../../hooks/useFomoTracking';
import type { FomoLeaderboardEntry } from '../../types/fomo';

function entryLabel(entry: FomoLeaderboardEntry): string {
  return entry.displayName || (entry.fomoHandle ? `@${entry.fomoHandle}` : entry.fomoUserId);
}

function formatPnl(value: number | null | undefined): string {
  if (value == null) return '—';
  const sign = value >= 0 ? '+' : '-';
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

interface FomoLeaderboardProps {
  trackedIds: Set<string>;
  trackedHandles: Set<string>;
  onTrack: (query: string, fomoUserId: string) => Promise<{ ok: boolean; status?: number; error?: string }>;
  trackingId: string | null;
  embedded?: boolean;
}

export default function FomoLeaderboard({
  trackedIds,
  trackedHandles,
  onTrack,
  trackingId,
  embedded = false,
}: FomoLeaderboardProps) {
  const { window, setWindow, entries, loading, error, refresh } = useFomoLeaderboard();

  const isTracked = (entry: FomoLeaderboardEntry) =>
    trackedIds.has(entry.fomoUserId) ||
    (entry.fomoHandle ? trackedHandles.has(entry.fomoHandle.toLowerCase()) : false);

  const handleTrack = async (entry: FomoLeaderboardEntry) => {
    const query = entry.fomoHandle ?? entry.displayName ?? entry.fomoUserId;
    await onTrack(query, entry.fomoUserId);
  };

  return (
    <div className={`flex flex-col min-h-0 overflow-hidden h-full ${embedded ? '' : 'brutal-card'}`}>
      <div className={`shrink-0 flex flex-wrap items-center gap-2 px-4 py-3 border-b-2 border-black bg-oct-surface ${embedded ? 'py-2' : ''}`}>
        {!embedded && (
          <>
            <Trophy size={16} className="text-oct-accent" />
            <h2 className="text-sm font-extrabold uppercase tracking-wide text-oct-text">Top Traders</h2>
          </>
        )}
        <div className="flex gap-1">
          {(['24h', 'all'] as const).map((w) => (
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
              {w === '24h' ? '24H' : 'ALL'}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => refresh()}
          disabled={loading}
          className="p-1.5 rounded-cockpit border-2 border-oct-border-bright text-oct-muted hover:text-oct-text transition-colors disabled:opacity-50"
          title="Refresh leaderboard"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {error && (
          <div className="m-4 px-4 py-3 rounded-cockpit border-2 border-oct-accent bg-oct-accent-dim text-sm text-oct-accent">
            {error}
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
            {entries.map((entry) => {
              const tracked = isTracked(entry);
              const tracking = trackingId === entry.fomoUserId;
              return (
                <li
                  key={entry.fomoUserId}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-oct-surface-raised/60 transition-colors"
                >
                  <span className="w-6 text-xs font-mono font-bold text-oct-muted tabular-nums">
                    {entry.rank ?? '·'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-oct-text truncate">{entryLabel(entry)}</div>
                    <div className="text-xs text-oct-muted truncate">
                      {entry.fomoHandle && entry.displayName ? `@${entry.fomoHandle} · ` : ''}
                      PnL {formatPnl(entry.pnl ?? null)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleTrack(entry)}
                    disabled={tracked || tracking}
                    className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded-cockpit text-xs font-bold uppercase border-2 transition-colors disabled:opacity-50 ${
                      tracked
                        ? 'border-oct-border text-oct-muted'
                        : 'border-black bg-oct-accent text-white shadow-oct-hard-sm hover:opacity-90'
                    }`}
                  >
                    {tracking ? (
                      <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <Plus size={12} />
                    )}
                    {tracked ? 'Tracked' : 'Track'}
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
