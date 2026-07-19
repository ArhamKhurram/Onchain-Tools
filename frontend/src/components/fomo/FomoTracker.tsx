import { useMemo, useState } from 'react';
import { AlertTriangle, Bell, BellOff, CheckCircle2, Plus, RefreshCw, Trash2, UserPlus, Users } from 'lucide-react';
import { useFomoServiceStatus, useFomoTracking } from '../../hooks/useFomoTracking';
import type { FomoTrackedUser } from '../../types/fomo';
import FomoLeaderboard from './FomoLeaderboard';
import FomoTradeFeed from './FomoTradeFeed';

type Feedback = { tone: 'success' | 'warning' | 'error'; text: string };
type FomoSubview = 'tracking' | 'leaderboard';

function trackedLabel(user: FomoTrackedUser): string {
  return user.display_name || (user.fomo_handle ? `@${user.fomo_handle}` : user.fomo_user_id);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function FomoTracker({ userId }: { userId: string }) {
  const { tracked, loading, error, refresh, track, untrack, updateNotifyPushover } = useFomoTracking(userId);
  const { status: serviceStatus } = useFomoServiceStatus();
  const [subview, setSubview] = useState<FomoSubview>('tracking');
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [trackingLeaderId, setTrackingLeaderId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [togglingPushoverId, setTogglingPushoverId] = useState<string | null>(null);

  const trackedIds = useMemo(() => new Set(tracked.map((u) => u.fomo_user_id)), [tracked]);
  const trackedHandles = useMemo(
    () => new Set(tracked.map((u) => u.fomo_handle?.toLowerCase()).filter(Boolean) as string[]),
    [tracked],
  );

  const trackFromLeaderboard = async (q: string, fomoUserId: string) => {
    setTrackingLeaderId(fomoUserId);
    const result = await track(q);
    if (result.ok) {
      setFeedback({ tone: 'success', text: `Now tracking ${trackedLabel(result.user)}.` });
    } else if (result.status === 409) {
      setFeedback({ tone: 'warning', text: 'You are already tracking this FOMO user.' });
    } else if (result.status === 503) {
      setFeedback({
        tone: 'error',
        text: 'FOMO integration not configured on the server. Add FOMO_REFRESH_TOKEN to backend/.env.',
      });
    } else {
      setFeedback({ tone: 'error', text: result.error || 'Failed to track user.' });
    }
    setTrackingLeaderId(null);
    if (result.ok) return { ok: true as const };
    return { ok: false as const, status: result.status, error: result.error };
  };

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
    if (!res.ok) {
      setFeedback({ tone: 'error', text: res.error || 'Failed to untrack user.' });
    }
    setRemovingId(null);
  };

  const handleTogglePushover = async (user: FomoTrackedUser) => {
    setTogglingPushoverId(user.id);
    const res = await updateNotifyPushover(user.id, !user.notify_pushover);
    if (!res.ok) {
      setFeedback({ tone: 'error', text: res.error || 'Failed to update Pushover setting.' });
    }
    setTogglingPushoverId(null);
  };

  const feedbackClass =
    feedback?.tone === 'success'
      ? 'border-oct-green text-oct-green'
      : feedback?.tone === 'warning'
        ? 'border-oct-border-bright text-oct-text'
        : 'border-oct-accent bg-oct-accent-dim text-oct-accent';

  return (
    <div className="flex flex-col h-full min-h-0 bg-oct-bg">
      {/* Toolbar / add form */}
      <div className="shrink-0 border-b-2 border-black bg-oct-surface px-4 sm:px-6 py-3">
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div className="flex items-center gap-2">
            <Users size={18} className="text-oct-accent" />
            <h1 className="text-lg font-extrabold uppercase text-oct-text">FOMO Tracking</h1>
            <span className="text-xs font-mono text-oct-muted tabular-nums">{tracked.length}</span>
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => refresh()}
            disabled={loading}
            className="p-2 rounded-cockpit border-2 border-oct-border-bright text-oct-muted hover:text-oct-text hover:border-oct-text transition-colors disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {serviceStatus && !serviceStatus.configured && (
          <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-cockpit border-2 border-oct-accent bg-oct-accent-dim text-sm text-oct-accent">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <span>
              FOMO service account is not configured. Set <code className="font-mono text-xs">FOMO_REFRESH_TOKEN</code> in{' '}
              <code className="font-mono text-xs">backend/.env</code> or seed{' '}
              <code className="font-mono text-xs">fomo_poll_state.refresh_token</code> in Supabase.
            </span>
          </div>
        )}

        <div className="flex gap-2 mb-3">
          {(['tracking', 'leaderboard'] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setSubview(id)}
              className={`px-3 py-1 rounded-cockpit text-xs font-bold uppercase border-2 transition-all ${
                subview === id
                  ? 'bg-oct-accent text-white border-black shadow-oct-hard-sm'
                  : 'text-oct-muted border-oct-border-bright hover:text-oct-text'
              }`}
            >
              {id === 'tracking' ? 'My Tracked' : 'Leaderboard'}
            </button>
          ))}
        </div>

        {subview === 'tracking' && (
        <form onSubmit={handleTrack} className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <UserPlus size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-oct-muted pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Track a FOMO trader by username…"
              className="w-full pl-9 pr-3 py-2 rounded-cockpit bg-oct-bg border-2 border-oct-border text-sm text-oct-text placeholder:text-oct-muted/60 focus:outline-none focus:border-oct-accent"
            />
          </div>
          <button type="submit" disabled={submitting || !query.trim()} className="brutal-btn px-4 py-2 text-sm">
            {submitting ? (
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <Plus size={16} />
            )}
            Track
          </button>
        </form>
        )}

        {feedback && (
          <div className={`mt-2 flex items-start gap-2 px-3 py-2 rounded-cockpit border-2 text-sm ${feedbackClass}`}>
            {feedback.tone === 'success' ? (
              <CheckCircle2 size={16} className="shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            )}
            <span>{feedback.text}</span>
          </div>
        )}
      </div>

      {/* Body: tracked list + live feed */}
      <div className="flex-1 min-h-0 overflow-hidden px-4 sm:px-6 py-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 h-full min-h-0">
          {subview === 'leaderboard' ? (
            <>
              <FomoLeaderboard
                trackedIds={trackedIds}
                trackedHandles={trackedHandles}
                onTrack={trackFromLeaderboard}
                trackingId={trackingLeaderId}
              />
              <FomoTradeFeed />
            </>
          ) : (
            <>
          {/* Tracked list */}
          <div className="brutal-card flex flex-col min-h-0 overflow-hidden">
            <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b-2 border-black bg-oct-surface">
              <Users size={16} className="text-oct-accent" />
              <h2 className="text-sm font-extrabold uppercase tracking-wide text-oct-text">Tracked Traders</h2>
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
              {error && (
                <div className="m-4 px-4 py-3 rounded-cockpit border-2 border-oct-accent bg-oct-accent-dim text-sm text-oct-accent">
                  {error}
                </div>
              )}
              {loading && tracked.length === 0 ? (
                <div className="flex items-center justify-center py-16">
                  <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
                </div>
              ) : tracked.length === 0 && !error ? (
                <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
                  <div className="w-12 h-12 rounded-cockpit border-2 border-black bg-oct-accent shadow-oct-hard flex items-center justify-center mb-4">
                    <Users size={24} className="text-white" />
                  </div>
                  <p className="text-oct-text font-bold uppercase mb-1">No traders tracked yet</p>
                  <p className="text-sm text-oct-muted max-w-xs">
                    Add a FOMO username above to start following their buys and sells.
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-oct-border">
                  {tracked.map((user) => (
                    <li
                      key={user.id}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-oct-surface-raised/60 transition-colors group"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-bold text-oct-text truncate">{trackedLabel(user)}</div>
                        <div className="text-xs text-oct-muted truncate">
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

          {/* Live trade feed */}
          <FomoTradeFeed />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
