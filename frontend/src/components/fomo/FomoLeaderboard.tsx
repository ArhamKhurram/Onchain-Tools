import { Plus, RefreshCw, Trophy } from 'lucide-react';
import { useFomoLeaderboard } from '../../hooks/useFomoTracking';
import { cn } from '../../lib/utils';
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

/** PnL carries meaning, so it gets the semantic colours; unknown stays muted. */
function pnlTone(value: number | null | undefined): string {
  if (value == null) return 'text-oct-muted';
  return value >= 0 ? 'text-oct-good' : 'text-oct-critical';
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
    <div className={cn('flex flex-col min-h-0 overflow-hidden h-full', !embedded && 'oct-card oct-card-flush')}>
      <div
        className={cn(
          'oct-headerbar shrink-0 flex flex-wrap items-center gap-cozy px-comfy',
          embedded ? 'py-tight' : 'py-cozy',
        )}
      >
        {!embedded && (
          <>
            <Trophy size={14} className="text-oct-accent-2" />
            <h2 className="type-title uppercase tracking-wide text-oct-text">Top Traders</h2>
          </>
        )}
        <div className="flex gap-tight">
          {(['24h', 'all'] as const).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWindow(w)}
              className={cn(
                'px-cozy py-tight rounded-oct-sm type-caption font-mono font-bold border transition-all duration-fast',
                window === w
                  ? 'bg-oct-accent text-white border-oct-accent/50 shadow-oct-glow-accent'
                  : 'text-oct-muted border-transparent hover:border-oct-border-bright hover:text-oct-text',
              )}
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
          className="oct-icon-btn p-snug"
          title="Refresh leaderboard"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {error && (
          <div
            role="alert"
            className="m-comfy px-comfy py-cozy rounded-oct border border-oct-critical/50 bg-oct-critical-dim type-body text-oct-critical"
          >
            {error}
          </div>
        )}
        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center py-gutter">
            <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : entries.length === 0 && !error ? (
          <div className="py-gutter px-section text-center type-body text-oct-muted">No leaderboard data.</div>
        ) : (
          <ul className="divide-y divide-oct-border">
            {entries.map((entry) => {
              const tracked = isTracked(entry);
              const tracking = trackingId === entry.fomoUserId;
              return (
                <li
                  key={entry.fomoUserId}
                  className="flex items-center gap-comfy px-comfy py-snug oct-row-hover"
                >
                  <span className="w-6 type-data text-oct-muted text-right shrink-0">{entry.rank ?? '·'}</span>
                  <div className="min-w-0 flex-1">
                    <div className="type-body font-bold text-oct-text truncate">{entryLabel(entry)}</div>
                    {entry.fomoHandle && entry.displayName && (
                      <div className="type-caption text-oct-muted truncate">@{entry.fomoHandle}</div>
                    )}
                  </div>
                  {/* PnL is its own right-aligned column so the signs and magnitudes line up down the board. */}
                  <div className="shrink-0 text-right">
                    <div className={cn('type-data', pnlTone(entry.pnl))}>{formatPnl(entry.pnl ?? null)}</div>
                    <div className="type-caption text-oct-muted">PnL</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleTrack(entry)}
                    disabled={tracked || tracking}
                    className={cn(
                      'shrink-0 flex items-center gap-tight px-cozy py-tight rounded-oct-sm type-caption font-bold uppercase border transition-all duration-fast disabled:opacity-50',
                      tracked
                        ? 'border-oct-border text-oct-muted'
                        : 'border-oct-accent/50 bg-oct-accent text-white shadow-oct-glow-accent hover:brightness-110',
                    )}
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
