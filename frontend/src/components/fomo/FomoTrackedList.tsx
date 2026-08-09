// The FOMO "Tracking" tab: add a trader by handle, see who you track, toggle
// Pushover, untrack. Extracted from the old FomoTracker, which nested this with
// the leaderboard and live feed under a sub-toggle — those are now their own
// FOMO tabs. The tracking hook is owned by FomoPage and passed in so the
// Leaderboard tab shares the same tracked set.

import { useState } from 'react';
import { AlertTriangle, Bell, BellOff, CheckCircle2, Plus, RefreshCw, Trash2, UserPlus, Users } from 'lucide-react';
import type { useFomoTracking } from '../../hooks/useFomoTracking';
import type { FomoTrackedUser } from '../../types/fomo';

type Tracking = ReturnType<typeof useFomoTracking>;
type Feedback = { tone: 'success' | 'warning' | 'error'; text: string };

function trackedLabel(user: FomoTrackedUser): string {
  return user.display_name || (user.fomo_handle ? `@${user.fomo_handle}` : user.fomo_user_id);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

interface FomoTrackedListProps {
  tracking: Tracking;
  /** From useFomoServiceStatus — false shows the "configure FOMO" banner. */
  configured: boolean;
}

export default function FomoTrackedList({ tracking, configured }: FomoTrackedListProps) {
  const { tracked, loading, error, refresh, track, untrack, updateNotifyPushover } = tracking;
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [togglingPushoverId, setTogglingPushoverId] = useState<string | null>(null);

  const handleTrack = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || !query.trim()) return;
    setSubmitting(true);
    setFeedback(null);
    const result = await track(query);
    if (result.ok) {
      setFeedback({ tone: 'success', text: `Now tracking ${trackedLabel(result.user)}.` });
      setQuery('');
    } else if (result.status === 404) {
      setFeedback({ tone: 'warning', text: result.error || `No FOMO user found for "${query.trim()}".` });
    } else if (result.status === 409) {
      setFeedback({ tone: 'warning', text: 'You are already tracking this FOMO user.' });
    } else if (result.status === 503) {
      setFeedback({
        tone: 'error',
        text: 'FOMO integration not configured on the server. Add FOMO_REFRESH_TOKEN to backend/.env (see .env.example).',
      });
    } else {
      setFeedback({ tone: 'error', text: result.error || 'Failed to track user.' });
    }
    setSubmitting(false);
  };

  const handleRemove = async (user: FomoTrackedUser) => {
    setRemovingId(user.id);
    const res = await untrack(user.id);
    if (!res.ok) setFeedback({ tone: 'error', text: res.error || 'Failed to untrack user.' });
    setRemovingId(null);
  };

  const handleTogglePushover = async (user: FomoTrackedUser) => {
    setTogglingPushoverId(user.id);
    const res = await updateNotifyPushover(user.id, !user.notify_pushover);
    if (!res.ok) setFeedback({ tone: 'error', text: res.error || 'Failed to update Pushover setting.' });
    setTogglingPushoverId(null);
  };

  const feedbackClass =
    feedback?.tone === 'success'
      ? 'border-oct-green/50 bg-oct-green/10 text-oct-green'
      : feedback?.tone === 'warning'
        ? 'border-oct-border-bright text-oct-text'
        : 'border-oct-flame/40 bg-oct-flame/10 text-oct-flame';

  return (
    <div className="flex flex-col h-full min-h-0 bg-oct-bg">
      <div className="oct-headerbar shrink-0 px-4 sm:px-6 py-3.5">
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div className="flex items-center gap-2">
            <Users size={18} className="text-oct-accent" />
            <h2 className="oct-section-title uppercase tracking-wide">Tracked Traders</h2>
            <span className="oct-chip tabular-nums">{tracked.length}</span>
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => refresh()}
            disabled={loading}
            className="oct-icon-btn p-2"
            title="Refresh"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {!configured && (
          <div className="mb-3 flex items-start gap-2 px-3 py-2.5 rounded-oct border border-oct-flame/40 bg-oct-flame/10 text-sm text-oct-text">
            <AlertTriangle size={16} className="shrink-0 mt-0.5 text-oct-flame" />
            <span>
              FOMO service account is not configured. Set <code className="font-mono text-xs">FOMO_REFRESH_TOKEN</code> in{' '}
              <code className="font-mono text-xs">backend/.env</code> or seed{' '}
              <code className="font-mono text-xs">fomo_poll_state.refresh_token</code> in Supabase.
            </span>
          </div>
        )}

        <form onSubmit={handleTrack} className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <UserPlus size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-oct-muted pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Track a FOMO trader by username…"
              className="oct-input w-full pl-9 pr-3 py-2.5 text-sm"
            />
          </div>
          <button type="submit" disabled={submitting || !query.trim()} className="oct-btn-primary px-4 py-2.5 text-sm uppercase tracking-wide">
            {submitting ? (
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <Plus size={16} />
            )}
            Track
          </button>
        </form>

        {feedback && (
          <div className={`mt-2 flex items-start gap-2 px-3 py-2 rounded-oct border text-sm ${feedbackClass}`}>
            {feedback.tone === 'success' ? (
              <CheckCircle2 size={16} className="shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            )}
            <span>{feedback.text}</span>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {error && (
          <div className="m-4 px-4 py-3 rounded-oct border border-oct-flame/40 bg-oct-flame/10 text-sm text-oct-text">
            {error}
          </div>
        )}
        {loading && tracked.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : tracked.length === 0 && !error ? (
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
            <div className="w-14 h-14 rounded-oct-lg border border-oct-accent/40 bg-gradient-to-b from-oct-flame to-oct-accent shadow-oct-glow-accent flex items-center justify-center mb-4">
              <Users size={24} className="text-white" />
            </div>
            <p className="text-oct-text font-bold uppercase tracking-wide mb-1.5">No traders tracked yet</p>
            <p className="text-sm text-oct-muted max-w-xs leading-relaxed">
              Add a FOMO username above to start following their buys and sells. Their trades show under the Live tab.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-oct-border max-w-3xl mx-auto">
            {tracked.map((user) => (
              <li
                key={user.id}
                className="flex items-center gap-3 px-4 py-3 oct-row-hover group"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-bold text-oct-text truncate">{trackedLabel(user)}</div>
                  <div className="text-[13px] text-oct-muted truncate">
                    {user.fomo_handle && user.display_name ? `@${user.fomo_handle} · ` : ''}
                    Tracked {formatDate(user.created_at)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleTogglePushover(user)}
                  disabled={togglingPushoverId === user.id}
                  className={`p-1.5 rounded-md transition-colors disabled:opacity-50 ${
                    user.notify_pushover
                      ? 'text-oct-accent hover:bg-oct-accent-dim'
                      : 'text-oct-muted hover:text-oct-text hover:bg-oct-bg'
                  }`}
                  title={user.notify_pushover ? 'Pushover on — click to disable' : 'Pushover off — click to enable'}
                >
                  {togglingPushoverId === user.id ? (
                    <span className="block w-3.5 h-3.5 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
                  ) : user.notify_pushover ? (
                    <Bell size={14} />
                  ) : (
                    <BellOff size={14} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => handleRemove(user)}
                  disabled={removingId === user.id}
                  className="p-1.5 rounded-md text-oct-muted hover:text-oct-accent hover:bg-oct-accent-dim transition-colors disabled:opacity-50"
                  title="Untrack"
                >
                  {removingId === user.id ? (
                    <span className="block w-3.5 h-3.5 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <Trash2 size={14} />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
