// The "Following" tab: follow pump.fun callers by @username and get a real-time
// ping (toast + Pushover) whenever one of them drops a callout. The list is the
// tracked set the backend's global callout poller fans out to.

import { useState } from 'react';
import { ExternalLink, Megaphone, Plus, Trash2, UserPlus } from 'lucide-react';
import { usePumpCallers } from '../../hooks/usePumpCallers';

const SOLSCAN_ACCOUNT = 'https://solscan.io/account/';

function shortAddress(a: string): string {
  return a.length <= 12 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}

export default function PumpCallersTab() {
  const { callers, loading, needsAuth, error, busy, follow, unfollow } = usePumpCallers();
  const [input, setInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const err = await follow(input);
    if (err) {
      setFormError(err);
      return;
    }
    setInput('');
  };

  if (needsAuth) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 h-full px-6 text-center">
        <Megaphone size={22} className="text-oct-muted" />
        <p className="text-sm text-oct-text font-semibold">Sign in to follow callers</p>
        <p className="text-xs text-oct-muted max-w-sm">
          Callout alerts are tied to your account. Connect a hosted session to follow pump.fun callers and get
          pinged the moment they post.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 px-4 py-3 border-b-2 border-black bg-oct-surface">
        <form onSubmit={onSubmit} className="flex items-center gap-2">
          <div className="relative flex-1">
            <UserPlus size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-oct-muted" />
            <input
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (formError) setFormError(null);
              }}
              placeholder="Follow a caller by @username (e.g. ansem)"
              className="w-full pl-8 pr-3 py-2 rounded-cockpit border-2 border-oct-border-bright bg-oct-bg text-sm text-oct-text placeholder:text-oct-muted focus:outline-none focus:border-oct-accent"
            />
          </div>
          <button
            type="submit"
            disabled={busy || input.trim() === ''}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-cockpit border-2 border-black bg-oct-accent text-white text-sm font-bold shadow-oct-hard disabled:opacity-50 transition-opacity"
          >
            <Plus size={14} /> Follow
          </button>
        </form>
        {formError && <p className="mt-2 text-xs text-oct-accent">{formError}</p>}
        <p className="mt-2 text-[11px] text-oct-muted">
          When a caller you follow posts a callout, you get a toast + Pushover ping in real time.
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="m-4 px-4 py-3 rounded-cockpit border-2 border-oct-accent bg-oct-accent-dim text-sm text-oct-accent">
            {error}
          </div>
        ) : callers.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center">
            <Megaphone size={20} className="text-oct-muted" />
            <p className="text-sm text-oct-muted">You aren&apos;t following any callers yet.</p>
            <p className="text-[11px] text-oct-muted">Add a pump.fun @username above to start getting callout pings.</p>
          </div>
        ) : (
          <ul className="divide-y divide-oct-border">
            {callers.map((c) => (
              <li key={c.callerAddress} className="flex items-center gap-3 px-4 py-2.5 hover:bg-oct-surface-raised/60 transition-colors">
                {c.avatar ? (
                  <img
                    src={c.avatar}
                    alt=""
                    loading="lazy"
                    className="h-8 w-8 rounded-full object-cover shrink-0 bg-oct-surface-raised"
                    onError={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = 'hidden')}
                  />
                ) : (
                  <span className="h-8 w-8 rounded-full bg-oct-surface-raised shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-oct-text truncate">
                    {c.username ? `@${c.username}` : shortAddress(c.callerAddress)}
                  </div>
                  <a
                    href={`${SOLSCAN_ACCOUNT}${c.callerAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-[11px] text-oct-muted hover:text-oct-text transition-colors"
                    title={c.callerAddress}
                  >
                    {shortAddress(c.callerAddress)}
                    <ExternalLink size={10} />
                  </a>
                </div>
                <button
                  onClick={() => unfollow(c.callerAddress)}
                  className="shrink-0 p-1.5 rounded-cockpit border-2 border-oct-border-bright text-oct-muted hover:text-oct-accent transition-colors"
                  title="Unfollow"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
