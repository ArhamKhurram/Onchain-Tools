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
    <div className={`flex flex-col min-h-0 overflow-hidden h-full ${embedded ? '' : 'oct-card oct-card-flush'}`}>
      <div className={`oct-headerbar shrink-0 flex flex-wrap items-center gap-2 px-4 ${embedded ? 'py-2' : 'py-3'}`}>
        {!embedded && (
          <>
            <Trophy size={16} className="text-oct-accent-2" />
            <h2 className="oct-section-title uppercase tracking-wide">Top Traders</h2>
          </>
        )}
        <div className="flex gap-1">
          {(['24h', 'all'] as const).map((w) => (
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
              {w === '24h' ? '24H' : 'ALL'}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => refresh()}
          disabled={loading}
          className="oct-icon-btn p-2"
          title="Refresh leaderboard"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {error && (
          <div className="m-4 px-4 py-3 rounded-oct border border-oct-flame/40 bg-oct-flame/10 text-sm text-oct-text">
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
                  className="flex items-center gap-3 px-4 py-3 oct-row-hover"
                >
                  <span className="w-6 text-[13px] font-mono font-bold text-oct-muted tabular-nums">
                    {entry.rank ?? '·'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-bold text-oct-text truncate">{entryLabel(entry)}</div>
                    <div className="text-[13px] text-oct-muted truncate">
                      {entry.fomoHandle && entry.displayName ? `@${entry.fomoHandle} · ` : ''}
                      PnL <span className="tabular-nums">{formatPnl(entry.pnl ?? null)}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleTrack(entry)}
                    disabled={tracked || tracking}
                    className={`shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-oct-sm text-xs font-bold uppercase border transition-all disabled:opacity-50 ${
                      tracked
                        ? 'border-oct-border text-oct-muted'
                        : 'border-oct-accent/50 bg-oct-accent text-white shadow-oct-glow-accent hover:brightness-110'
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
