// The "Following" tab — the hub for building your pump.fun callout-alert set from
// all three sources: manually by @username, a curated set of popular callers, and
// the PnL leaderboard. Following any of them means a real-time ping (toast +
// Pushover) the moment they post a callout.
//
// Type scale is deliberately larger/denser than the older pump panels (a first
// step on the pump-tab design pass): sm/base body, clear section headings.

import { useState } from 'react';
import { ExternalLink, Megaphone, Plus, Trash2, Check, UserPlus, Trophy } from 'lucide-react';
import { usePumpCallers } from '../../hooks/usePumpCallers';
import { usePumpConnection } from '../../hooks/usePumpConnection';
import { usePumpLeaderboard } from '../../hooks/usePumpLeaderboard';

const SOLSCAN_ACCOUNT = 'https://solscan.io/account/';

// A small, curated set of well-known callers, verified to resolve on pump's
// keyless user endpoint. One-click follow (resolved server-side by handle) — the
// user sees exactly who they followed and can drop any of them.
const POPULAR_CALLERS = [
  'ansem',
  'slingoor',
  'cupsey',
  'gake',
  'cented',
  'waddles',
  'euris',
  'levis',
  'jackduvalcalls',
] as const;

// How many leaderboard rows the on-ramp shows / "follow top" grabs.
const LEADERBOARD_TOP_N = 15;

function shortAddress(a: string): string {
  return a.length <= 12 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}

export default function PumpCallersTab() {
  const { callers, followedAddresses, loading, needsAuth, error, busy, follow, followByAddress, followMany, unfollow } =
    usePumpCallers();
  const { summary } = usePumpConnection();
  const connected = summary.state === 'connected';
  const board = usePumpLeaderboard(connected);

  const [input, setInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // A popular handle is "followed" when a tracked caller carries that username.
  const followedHandles = new Set(callers.map((c) => (c.username ?? '').toLowerCase()));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const err = await follow(input);
    if (err) return setFormError(err);
    setInput('');
  };

  if (needsAuth) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 h-full px-6 text-center">
        <Megaphone size={28} className="text-oct-muted" />
        <p className="text-base text-oct-text font-bold">Sign in to follow callers</p>
        <p className="text-sm text-oct-muted max-w-sm">
          Callout alerts are tied to your account. Connect a hosted session to follow pump.fun callers and get pinged
          the moment they post.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-auto">
      {/* Manual follow by @username */}
      <div className="px-5 py-4 border-b-2 border-black bg-oct-surface">
        <form onSubmit={onSubmit} className="flex items-center gap-2">
          <div className="relative flex-1">
            <UserPlus size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-oct-muted" />
            <input
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (formError) setFormError(null);
              }}
              placeholder="Follow a caller by @username (e.g. ansem)"
              className="w-full pl-9 pr-3 py-2.5 rounded-cockpit border-2 border-oct-border-bright bg-oct-bg text-sm text-oct-text placeholder:text-oct-muted focus:outline-none focus:border-oct-accent"
            />
          </div>
          <button
            type="submit"
            disabled={busy || input.trim() === ''}
            className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2.5 rounded-cockpit border-2 border-black bg-oct-accent text-white text-sm font-bold shadow-oct-hard disabled:opacity-50 transition-opacity"
          >
            <Plus size={16} /> Follow
          </button>
        </form>
        {formError && <p className="mt-2 text-sm text-oct-accent">{formError}</p>}
        <p className="mt-2 text-xs text-oct-muted">
          When a caller you follow posts a callout, you get a toast + Pushover ping in real time.
        </p>
      </div>

      {/* Popular callers — keyless quick-add */}
      <div className="px-5 py-4 border-b-2 border-black">
        <h3 className="text-sm font-extrabold uppercase tracking-wide text-oct-text mb-3">Popular callers</h3>
        <div className="flex flex-wrap gap-2">
          {POPULAR_CALLERS.map((handle) => {
            const isFollowed = followedHandles.has(handle.toLowerCase());
            return (
              <button
                key={handle}
                disabled={busy || isFollowed}
                onClick={() => follow(handle)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border-2 text-sm font-semibold transition-colors ${
                  isFollowed
                    ? 'border-oct-green/50 text-oct-green bg-oct-green/10 cursor-default'
                    : 'border-oct-border-bright text-oct-text hover:border-oct-accent hover:text-oct-accent'
                }`}
              >
                {isFollowed ? <Check size={13} /> : <Plus size={13} />}@{handle}
              </button>
            );
          })}
        </div>
      </div>

      {/* Leaderboard on-ramp — follow the top PnL callers */}
      <div className="px-5 py-4 border-b-2 border-black">
        <div className="flex items-center gap-2 mb-3">
          <Trophy size={15} className="text-oct-yellow" />
          <h3 className="text-sm font-extrabold uppercase tracking-wide text-oct-text">From the leaderboard</h3>
          <div className="flex-1" />
          {connected && board.entries.length > 0 && (
            <button
              onClick={() =>
                followMany(
                  board.entries
                    .slice(0, LEADERBOARD_TOP_N)
                    .filter((e) => e.walletAddress)
                    .map((e) => ({ address: e.walletAddress as string, username: e.username, avatar: null })),
                  'leaderboard',
                )
              }
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-cockpit border-2 border-black bg-oct-surface-raised text-xs font-bold text-oct-text hover:text-oct-accent shadow-oct-hard disabled:opacity-50"
            >
              <Plus size={13} /> Follow top {LEADERBOARD_TOP_N}
            </button>
          )}
        </div>
        {!connected ? (
          <p className="text-sm text-oct-muted">
            Connect your pump.fun account on the <span className="text-oct-text font-semibold">Leaderboard</span> tab to
            follow the top PnL callers.
          </p>
        ) : board.entries.length === 0 ? (
          <p className="text-sm text-oct-muted">{board.loading ? 'Loading leaderboard…' : 'No leaderboard rows yet.'}</p>
        ) : (
          <ul className="space-y-1.5">
            {board.entries.slice(0, LEADERBOARD_TOP_N).map((e, i) => {
              const followed = !!e.walletAddress && followedAddresses.has(e.walletAddress);
              return (
                <li key={e.walletAddress ?? i} className="flex items-center gap-3">
                  <span className="w-5 text-xs font-mono font-bold text-oct-muted tabular-nums shrink-0">{i + 1}</span>
                  <span className="font-semibold text-oct-text truncate flex-1">
                    {e.username ? `@${e.username}` : e.walletAddress ? shortAddress(e.walletAddress) : '—'}
                  </span>
                  <button
                    disabled={busy || followed || !e.walletAddress}
                    onClick={() =>
                      e.walletAddress &&
                      followByAddress({ address: e.walletAddress, username: e.username, avatar: null, source: 'leaderboard' })
                    }
                    className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-cockpit border-2 text-xs font-bold transition-colors ${
                      followed
                        ? 'border-oct-green/50 text-oct-green bg-oct-green/10 cursor-default'
                        : 'border-oct-border-bright text-oct-text hover:border-oct-accent hover:text-oct-accent'
                    }`}
                  >
                    {followed ? <Check size={12} /> : <Plus size={12} />}
                    {followed ? 'Following' : 'Follow'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* The followed set */}
      <div className="px-5 py-3">
        <h3 className="text-sm font-extrabold uppercase tracking-wide text-oct-text mb-2">
          Following {callers.length > 0 && <span className="text-oct-muted">({callers.length})</span>}
        </h3>
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="px-4 py-3 rounded-cockpit border-2 border-oct-accent bg-oct-accent-dim text-sm text-oct-accent">
            {error}
          </div>
        ) : callers.length === 0 ? (
          <p className="text-sm text-oct-muted py-6 text-center">
            You aren&apos;t following anyone yet — add a caller above to start getting callout pings.
          </p>
        ) : (
          <ul className="divide-y divide-oct-border">
            {callers.map((c) => (
              <li key={c.callerAddress} className="flex items-center gap-3 py-2.5">
                {c.avatar ? (
                  <img
                    src={c.avatar}
                    alt=""
                    loading="lazy"
                    className="h-9 w-9 rounded-full object-cover shrink-0 bg-oct-surface-raised"
                    onError={(ev) => ((ev.currentTarget as HTMLImageElement).style.visibility = 'hidden')}
                  />
                ) : (
                  <span className="h-9 w-9 rounded-full bg-oct-surface-raised shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-oct-text truncate">
                    {c.username ? `@${c.username}` : shortAddress(c.callerAddress)}
                  </div>
                  <a
                    href={`${SOLSCAN_ACCOUNT}${c.callerAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-xs text-oct-muted hover:text-oct-text transition-colors"
                    title={c.callerAddress}
                  >
                    {shortAddress(c.callerAddress)}
                    <ExternalLink size={11} />
                  </a>
                </div>
                <button
                  onClick={() => unfollow(c.callerAddress)}
                  className="shrink-0 p-2 rounded-cockpit border-2 border-oct-border-bright text-oct-muted hover:text-oct-accent transition-colors"
                  title="Unfollow"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
