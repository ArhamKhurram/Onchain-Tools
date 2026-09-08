import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Plus, RefreshCw, Trophy } from 'lucide-react';
import { useFomoLeaderboard } from '../../hooks/useFomoTracking';
import { cn } from '../../lib/utils';
import type { FomoLeaderboardEntry, FomoLeaderboardSource } from '../../types/fomo';

// Windows offered. 24h/all can be served live by fomo.family; 7d and 30d exist
// only on the 985monitor snapshot, and the backend routes accordingly.
const WINDOWS = [
  { value: '24h' as const, label: '24H' },
  { value: '7d' as const, label: '7D' },
  { value: '30d' as const, label: '30D' },
  { value: 'all' as const, label: 'ALL' },
];

function formatAge(updatedAt: number | null): string {
  if (!updatedAt) return 'age unknown';
  const minutes = Math.max(0, Math.round((Date.now() - updatedAt) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * Names the source under the board. This is load-bearing, not decoration: the
 * fomo.family service account has been Forbidden upstream since 2026-08-26, so
 * in practice these rows come from a third-party snapshot, and presenting them
 * as OCT's own live feed would be misleading.
 */
function SourceNote({ meta }: { meta: FomoLeaderboardSource }) {
  return (
    <div className="shrink-0 px-comfy py-tight border-b border-oct-border bg-oct-surface-2">
      <p className="type-caption text-oct-muted">
        {meta.live ? (
          <>Live from <span className="font-bold text-oct-text">{meta.sourceLabel}</span>.</>
        ) : (
          <>
            Snapshot from{' '}
            {meta.sourceUrl ? (
              <a
                href={meta.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-bold text-oct-text underline decoration-dotted"
              >
                {meta.sourceLabel}
              </a>
            ) : (
              <span className="font-bold text-oct-text">{meta.sourceLabel}</span>
            )}{' '}
            — updated {formatAge(meta.updatedAt)}. Third-party data, not OCT's live feed.{' '}
            {/* The button works again, but the poller behind it does not: saying so
                here is the honest version. A TRACK that silently succeeds and then
                shows nothing forever is worse than one that errors. */}
            <span className="text-oct-text">
              Tracking is saved, but live trades stay unavailable while fomo.family blocks us.
            </span>
          </>
        )}
      </p>
    </div>
  );
}

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
  /**
   * Takes the whole row, not a search string: the row already carries the
   * resolved identity (uid / handle / name) from whichever source served the
   * board, and passing it through means TRACK never needs the blocked
   * fomo.family service account to resolve anything.
   */
  onTrack: (entry: FomoLeaderboardEntry) => Promise<{ ok: boolean; status?: number; error?: string }>;
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
  const { window, setWindow, entries, meta, loading, error, refresh } = useFomoLeaderboard();

  const isTracked = (entry: FomoLeaderboardEntry) =>
    trackedIds.has(entry.fomoUserId) ||
    (entry.fomoHandle ? trackedHandles.has(entry.fomoHandle.toLowerCase()) : false);

  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const handleTrack = async (entry: FomoLeaderboardEntry) => {
    setFeedback(null);
    const result = await onTrack(entry);
    if (result.ok) {
      setFeedback({
        tone: 'success',
        text: meta && !meta.live
          ? `Now tracking ${entryLabel(entry)}. Their trades will appear under Live once fomo.family access is restored — the feed is down at the source right now.`
          : `Now tracking ${entryLabel(entry)}.`,
      });
      return;
    }
    setFeedback({
      tone: result.status === 409 ? 'success' : 'error',
      text:
        result.status === 409
          ? 'You are already tracking this trader.'
          : result.error || 'Failed to track trader.',
    });
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
          {WINDOWS.map((w) => (
            <button
              key={w.value}
              type="button"
              onClick={() => setWindow(w.value)}
              className={cn(
                'px-cozy py-tight rounded-oct-sm type-caption font-mono font-bold border transition-all duration-fast',
                window === w.value
                  ? 'bg-oct-accent text-white border-oct-accent/50 shadow-oct-glow-accent'
                  : 'text-oct-muted border-transparent hover:border-oct-border-bright hover:text-oct-text',
              )}
            >
              {w.label}
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

      {meta && <SourceNote meta={meta} />}

      {feedback && (
        <div
          role="status"
          className={cn(
            'shrink-0 flex items-start gap-tight px-comfy py-tight border-b type-caption',
            feedback.tone === 'success'
              ? 'border-oct-border bg-oct-surface-2 text-oct-text'
              : 'border-oct-critical/40 bg-oct-critical-dim text-oct-critical',
          )}
        >
          {feedback.tone === 'success' ? (
            <CheckCircle2 size={14} className="shrink-0 mt-px" />
          ) : (
            <AlertTriangle size={14} className="shrink-0 mt-px" />
          )}
          <span>{feedback.text}</span>
        </div>
      )}

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
