// The "Following" tab — the hub for building your pump.fun callout-alert set from
// all three sources: manually by @username, a curated set of popular callers, and
// the PnL leaderboard. Following any of them means a real-time ping (toast +
// Pushover) the moment they post a callout.
//
// Following also doubles as an on-ramp into the on-chain tracked-wallet Directory:
// a followed caller's wallet can be added (per-row "Track on-chain" or "Add all to
// Directory") to user_tracked_wallets so its on-chain activity can be watched.
// That is a SEPARATE concern from callouts — it reuses the existing add-wallet
// flow (useTrackedWallets), not a parallel store.
//
// Type scale is deliberately larger/denser than the older pump panels (a first
// step on the pump-tab design pass): sm/base body, clear section headings.

import { useMemo, useState } from 'react';
import { ExternalLink, Megaphone, Plus, Trash2, Check, UserPlus, Trophy, Radar, Copy, Users } from 'lucide-react';
import { usePumpCallers } from '../../hooks/usePumpCallers';
import { usePumpConnection } from '../../hooks/usePumpConnection';
import { usePumpLeaderboard } from '../../hooks/usePumpLeaderboard';
import { useAuthSession } from '../../hooks/useAuthSession';
import { useTrackedWallets } from '../../hooks/useTrackedWallets';
import type { TrackedWalletInsert } from '../../types/wallets';

const SOLSCAN_ACCOUNT = 'https://solscan.io/account/';

// A followed caller's wallet, added to the on-chain tracked-wallet Directory
// (user_tracked_wallets, chain solana) via the existing add-wallet flow — a
// separate concern from callout alerts. This is a passive watchlist entry; the
// Directory does not (yet) run a per-wallet buy/sell movement poller.
function callerWalletInsert(address: string, username: string | null): TrackedWalletInsert {
  return {
    address,
    chain: 'solana',
    name: username ? `@${username}` : '',
    emoji: '📣',
    profile: 'pump.fun caller',
    alerts_on_toast: true,
    alerts_on_feed: true,
    alerts_on_bubble: true,
    sound: 'default',
  };
}

// A Supabase unique-violation (already in the Directory) is a no-op for our
// purposes, not a failure worth surfacing.
function isDuplicateWallet(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === '23505' || /duplicate|already exists|unique/i.test(e?.message ?? '');
}

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
  const {
    callers,
    followedAddresses,
    loading,
    needsAuth,
    error,
    busy,
    follow,
    followByAddress,
    followMany,
    followByUsernames,
    unfollow,
  } = usePumpCallers();
  const { summary } = usePumpConnection();
  const connected = summary.state === 'connected';
  const board = usePumpLeaderboard(connected);

  // On-chain tracked-wallet Directory (user_tracked_wallets). Hosted-only, like
  // the caller set itself — in local mode userId is undefined and the hook no-ops.
  const { userId } = useAuthSession();
  const { wallets: trackedWallets, createWallet } = useTrackedWallets(userId);

  const [input, setInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [trackBusy, setTrackBusy] = useState(false);
  const [trackError, setTrackError] = useState<string | null>(null);
  // Transient "Copied N wallets" confirmation for the export button.
  const [copied, setCopied] = useState<number | null>(null);

  // A popular handle is "followed" when a tracked caller carries that username.
  const followedHandles = new Set(callers.map((c) => (c.username ?? '').toLowerCase()));

  // Solana addresses already in the on-chain Directory — drives the per-row
  // "Tracked" state and lets the bulk action skip what's already there.
  const trackedSolAddresses = useMemo(
    () => new Set(trackedWallets.filter((w) => w.chain === 'solana').map((w) => w.address)),
    [trackedWallets],
  );

  const untrackedCallers = callers.filter((c) => !trackedSolAddresses.has(c.callerAddress));

  // Add a single caller's wallet to the Directory. Idempotent: a unique-violation
  // (already present) is swallowed so the row simply flips to "Tracked".
  const trackOnChain = async (address: string, username: string | null): Promise<string | null> => {
    if (trackedSolAddresses.has(address)) return null;
    setTrackError(null);
    setTrackBusy(true);
    try {
      await createWallet(callerWalletInsert(address, username));
      return null;
    } catch (err) {
      if (isDuplicateWallet(err)) return null;
      const msg = (err as Error)?.message ?? 'Failed to add wallet to Directory.';
      setTrackError(msg);
      return msg;
    } finally {
      setTrackBusy(false);
    }
  };

  // Bulk "Add all to Directory": loop the existing single-add (there is no bulk
  // insert on useTrackedWallets), skipping any already tracked.
  const trackAllOnChain = async (): Promise<void> => {
    if (untrackedCallers.length === 0) return;
    setTrackError(null);
    setTrackBusy(true);
    try {
      for (const c of untrackedCallers) {
        try {
          await createWallet(callerWalletInsert(c.callerAddress, c.username));
        } catch (err) {
          if (!isDuplicateWallet(err)) throw err;
        }
      }
    } catch (err) {
      setTrackError((err as Error)?.message ?? 'Failed to add wallets to Directory.');
    } finally {
      setTrackBusy(false);
    }
  };

  // Every leaderboard row that carries a resolvable wallet — the "Follow all" set.
  const boardWithWallets = board.entries.filter((e) => e.walletAddress);
  const allPopularFollowed = POPULAR_CALLERS.every((h) => followedHandles.has(h.toLowerCase()));

  const copyAllWallets = async () => {
    const addresses = callers.map((c) => c.callerAddress);
    if (addresses.length === 0) return;
    try {
      await navigator.clipboard.writeText(addresses.join('\n'));
      setCopied(addresses.length);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard blocked (permissions / insecure context) — leave the button idle.
    }
  };

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
      <div className="oct-headerbar px-5 py-4">
        <form onSubmit={onSubmit} className="flex items-center gap-2">
          <div className="relative flex-1">
            <UserPlus size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-oct-muted" />
            <input
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (formError) setFormError(null);
              }}
              placeholder="Follow by pump.fun @username (e.g. ansem)"
              className="oct-input w-full pl-9 pr-3 py-2.5 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={busy || input.trim() === ''}
            className="oct-btn-primary shrink-0 px-4 py-2.5 text-sm disabled:opacity-50"
          >
            <Plus size={16} /> Follow
          </button>
        </form>
        {formError && <p className="mt-2 text-sm text-oct-flame">{formError}</p>}
        <p className="mt-2 text-xs text-oct-muted">
          When a caller you follow posts a callout, you get a toast + Pushover ping in real time.
        </p>
        <p className="mt-1 text-xs text-oct-muted">
          This is the caller&apos;s <span className="text-oct-text font-semibold">pump.fun</span> username, which can
          differ from their X/Twitter handle — pump can&apos;t look someone up by their X handle. To follow by their X
          identity, use the <span className="text-oct-text font-semibold">leaderboard</span> below (each row shows the
          linked @X and follows by wallet).
        </p>
      </div>

      {/* Popular callers — keyless quick-add */}
      <div className="px-5 py-4 border-b border-oct-border">
        <div className="flex items-center gap-2 mb-3">
          <h3 className="oct-section-title uppercase tracking-wide">Popular callers</h3>
          <div className="flex-1" />
          <button
            onClick={() => followByUsernames(POPULAR_CALLERS, 'popular')}
            disabled={busy || allPopularFollowed}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-oct-sm border border-oct-border-bright bg-oct-surface-raised text-xs font-bold text-oct-text hover:text-oct-accent hover:border-oct-accent shadow-oct-soft disabled:opacity-50 transition-colors"
          >
            {allPopularFollowed ? <Check size={13} /> : <Plus size={13} />}
            {allPopularFollowed ? 'All followed' : 'Follow all'}
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {POPULAR_CALLERS.map((handle) => {
            const isFollowed = followedHandles.has(handle.toLowerCase());
            return (
              <button
                key={handle}
                disabled={busy || isFollowed}
                onClick={() => follow(handle)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm font-semibold transition-colors ${
                  isFollowed
                    ? 'border-oct-green/50 text-oct-green bg-oct-green/10 cursor-default'
                    : 'border-oct-border-bright text-oct-text hover:border-oct-accent hover:text-oct-accent hover:bg-oct-accent-dim'
                }`}
              >
                {isFollowed ? <Check size={13} /> : <Plus size={13} />}@{handle}
              </button>
            );
          })}
        </div>
      </div>

      {/* Leaderboard on-ramp — follow the top PnL callers */}
      <div className="px-5 py-4 border-b border-oct-border">
        <div className="flex items-center gap-2 mb-3">
          <Trophy size={15} className="text-oct-accent-2" />
          <h3 className="oct-section-title uppercase tracking-wide">From the leaderboard</h3>
          <div className="flex-1" />
          {connected && board.entries.length > 0 && (
            <div className="flex items-center gap-2">
              <button
                onClick={() =>
                  followMany(
                    boardWithWallets
                      .slice(0, LEADERBOARD_TOP_N)
                      .map((e) => ({ address: e.walletAddress as string, username: e.username, avatar: null })),
                    'leaderboard',
                  )
                }
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-oct-sm border border-oct-border-bright bg-oct-surface-raised text-xs font-bold text-oct-text hover:text-oct-accent hover:border-oct-accent shadow-oct-soft disabled:opacity-50 transition-colors"
              >
                <Plus size={13} /> Follow top {LEADERBOARD_TOP_N}
              </button>
              {boardWithWallets.length > LEADERBOARD_TOP_N && (
                <button
                  onClick={() =>
                    followMany(
                      boardWithWallets.map((e) => ({ address: e.walletAddress as string, username: e.username, avatar: null })),
                      'leaderboard',
                    )
                  }
                  disabled={busy}
                  className="oct-btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  <Users size={13} /> Follow all {boardWithWallets.length}
                </button>
              )}
            </div>
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
                  <span className="min-w-0 flex-1">
                    <span className="font-semibold text-oct-text truncate block">
                      {e.username ? `@${e.username}` : e.walletAddress ? shortAddress(e.walletAddress) : '—'}
                    </span>
                    {e.xUsername && (
                      <a
                        href={`https://x.com/${e.xUsername}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        onClick={(ev) => ev.stopPropagation()}
                        className="text-xs text-oct-muted hover:text-oct-accent truncate block"
                        title={`@${e.xUsername} on X`}
                      >
                        @{e.xUsername} on X
                      </a>
                    )}
                  </span>
                  <button
                    disabled={busy || followed || !e.walletAddress}
                    onClick={() =>
                      e.walletAddress &&
                      followByAddress({ address: e.walletAddress, username: e.username, avatar: null, source: 'leaderboard' })
                    }
                    className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-oct-sm border text-xs font-bold transition-colors ${
                      followed
                        ? 'border-oct-green/50 text-oct-green bg-oct-green/10 cursor-default'
                        : 'border-oct-border-bright text-oct-text hover:border-oct-accent hover:text-oct-accent hover:bg-oct-accent-dim'
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
        <div className="flex items-center gap-2 mb-2">
          <h3 className="oct-section-title uppercase tracking-wide">
            Following {callers.length > 0 && <span className="text-oct-muted font-mono">({callers.length})</span>}
          </h3>
          <div className="flex-1" />
          {callers.length > 0 && (
            <button
              onClick={copyAllWallets}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-oct-sm border border-oct-border-bright text-xs font-bold text-oct-text hover:text-oct-accent hover:border-oct-accent transition-colors"
              title="Copy every followed caller's wallet address"
            >
              {copied !== null ? <Check size={13} className="text-oct-green" /> : <Copy size={13} />}
              {copied !== null ? `Copied ${copied} wallet${copied === 1 ? '' : 's'}` : 'Copy all wallets'}
            </button>
          )}
          {untrackedCallers.length > 0 && (
            <button
              onClick={trackAllOnChain}
              disabled={trackBusy}
              title="Add every followed caller's wallet to your on-chain tracked-wallet Directory"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-oct-sm border border-oct-border-bright bg-oct-surface-raised text-xs font-bold text-oct-text hover:text-oct-accent hover:border-oct-accent shadow-oct-soft disabled:opacity-50 transition-colors"
            >
              <Radar size={13} /> Add all to Directory
            </button>
          )}
        </div>
        <p className="text-xs text-oct-muted mb-3">
          Following pings you on callouts. <span className="text-oct-text font-semibold">Track on-chain</span> also adds
          the caller&apos;s wallet to your Directory so you can watch it on-chain — a separate list from callout alerts.
        </p>
        {trackError && <p className="mb-2 text-sm text-oct-flame">{trackError}</p>}
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="px-4 py-3 rounded-oct border border-oct-flame/40 bg-oct-flame/10 text-sm text-oct-text">
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
                {trackedSolAddresses.has(c.callerAddress) ? (
                  <span
                    className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-oct-sm border border-oct-green/50 text-oct-green bg-oct-green/10 text-xs font-bold cursor-default"
                    title="This caller's wallet is in your on-chain tracked-wallet Directory"
                  >
                    <Check size={13} /> Tracked
                  </span>
                ) : (
                  <button
                    onClick={() => trackOnChain(c.callerAddress, c.username)}
                    disabled={trackBusy}
                    className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-oct-sm border border-oct-border-bright text-oct-text text-xs font-bold hover:text-oct-accent hover:border-oct-accent hover:bg-oct-accent-dim transition-colors disabled:opacity-50"
                    title="Add this caller's wallet to your on-chain tracked-wallet Directory"
                  >
                    <Radar size={13} /> Track on-chain
                  </button>
                )}
                <button
                  onClick={() => unfollow(c.callerAddress)}
                  className="oct-icon-btn shrink-0 p-2 hover:text-oct-flame"
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
