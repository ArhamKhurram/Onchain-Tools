// The live, subscribable pump.fun callout feed — the FOMO Live equivalent for
// callers.
//
// WHY THIS EXISTS AS ITS OWN SURFACE: the follow plumbing, the WS frame and the
// alert ping were all already shipped, but a followed caller's call only ever
// appeared as a transient toast plus a line in notification history. There was
// nowhere to *watch*. Worse, following nobody produced total silence with no
// explanation, which reads as a broken feature rather than an empty
// subscription — so the empty states below are the load-bearing part of this
// component, not decoration.
//
// SESSION-ONLY, AND IT SAYS SO. There is no per-user callout history to replay:
// the backend persists callouts only into pump_callout_observations for the
// global Top Callers board, and that table carries no coin, no market cap and
// no thesis. Rather than imply a gap, the header states the feed is live-only.

import { useMemo } from 'react';
import { ExternalLink, Megaphone, Radio, UserPlus } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { usePumpCallers } from '../../hooks/usePumpCallers';
import { formatMcap, truncateAddress, type PumpCalloutFeedEntry } from '../../types/pumpfun';
import PeakMultiple from './PeakMultiple';

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function callerLabel(c: PumpCalloutFeedEntry): string {
  return c.username ? `@${c.username}` : truncateAddress(c.callerAddress);
}

function coinLabel(c: PumpCalloutFeedEntry): string {
  return c.symbol ? `$${c.symbol.replace(/^\$/, '')}` : truncateAddress(c.coinMint);
}

/**
 * @param embedded  Rendered inside a workspace panel, which supplies its own
 *                  chrome — drop the card frame and the big header, exactly as
 *                  FomoTradeFeed does.
 * @param onGoToFollowing  Navigate to the Following tab. When omitted (workspace
 *                  panel) the empty state names the tab in prose instead, since
 *                  a panel has no tab bar to drive.
 */
export default function PumpCalloutFeed({
  embedded = false,
  onGoToFollowing,
}: {
  embedded?: boolean;
  onGoToFollowing?: () => void;
}) {
  const callouts = useAppStore((s) => s.pumpCallouts);
  const clearPumpCallouts = useAppStore((s) => s.clearPumpCallouts);
  // The follow count is what turns a silent feed into a legible one: "waiting on
  // 12 callers" and "you follow nobody" are completely different states.
  const { callers, loading, needsAuth } = usePumpCallers();

  const followCount = callers.length;
  const sorted = useMemo(
    () => [...callouts].sort((a, b) => b.occurredAt - a.occurredAt),
    [callouts],
  );

  return (
    <div className={`flex flex-col min-h-0 overflow-hidden h-full ${embedded ? '' : 'oct-card oct-card-flush'}`}>
      {!embedded && (
        <div className="oct-headerbar shrink-0 flex flex-wrap items-center gap-2 px-4 py-3">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-pulse-live absolute inline-flex h-full w-full rounded-full bg-oct-accent" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-oct-accent" />
          </span>
          <Radio size={16} className="text-oct-accent" />
          <h2 className="oct-section-title uppercase tracking-wide">Live Callout Feed</h2>
          <span className="oct-chip tabular-nums">{callouts.length}</span>
          {followCount > 0 && (
            <span className="text-xs text-oct-muted">
              following <span className="font-mono font-bold text-oct-text">{followCount}</span>{' '}
              {followCount === 1 ? 'caller' : 'callers'}
            </span>
          )}
          <div className="flex-1" />
          {onGoToFollowing && (
            <button
              type="button"
              onClick={onGoToFollowing}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-oct-sm border border-oct-border-bright text-xs font-bold text-oct-text hover:text-oct-accent hover:border-oct-accent transition-colors"
            >
              <UserPlus size={13} /> Manage callers
            </button>
          )}
          {callouts.length > 0 && (
            <button
              type="button"
              onClick={clearPumpCallouts}
              className="text-xs font-bold uppercase tracking-wide text-oct-muted hover:text-oct-text transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      )}
      {embedded && callouts.length > 0 && (
        <div className="shrink-0 flex items-center justify-between gap-2 px-2 py-1 border-b border-oct-border">
          <span className="text-[10px] font-bold uppercase text-oct-muted tabular-nums">
            {callouts.length} · {followCount} followed
          </span>
          <button
            type="button"
            onClick={clearPumpCallouts}
            className="text-[10px] font-bold uppercase text-oct-muted hover:text-oct-text shrink-0"
          >
            Clear
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto overscroll-contain" style={{ overflowAnchor: 'none' }}>
        {sorted.length > 0 ? (
          <ul className="divide-y divide-oct-border">
            {sorted.map((c) => (
              <PumpCalloutRow key={c.key} callout={c} />
            ))}
          </ul>
        ) : (
          <FeedEmptyState
            needsAuth={needsAuth}
            loading={loading}
            followCount={followCount}
            onGoToFollowing={onGoToFollowing}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The whole point of the rebuild. Three distinct silences, three distinct
 * explanations — because "nothing here" previously covered all of them and left
 * the user unable to tell a missing subscription from a broken feature.
 */
function FeedEmptyState({
  needsAuth,
  loading,
  followCount,
  onGoToFollowing,
}: {
  needsAuth: boolean;
  loading: boolean;
  followCount: number;
  onGoToFollowing?: () => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (needsAuth) {
    return (
      <Shell title="Sign in to follow callers">
        <p>
          The callout feed is tied to your account — following a caller is what tells OCT whose
          calls to stream to you. Connect a hosted session to start.
        </p>
      </Shell>
    );
  }

  if (followCount === 0) {
    return (
      <Shell title="You aren't following any callers">
        <p>
          This feed streams callouts from pump.fun callers <strong className="text-oct-text">you follow</strong> — it is
          a subscription, not a firehose. Follow someone and their next call lands here the moment
          they post it, with the thesis and the market cap at the call.
        </p>
        {onGoToFollowing ? (
          <button
            type="button"
            onClick={onGoToFollowing}
            className="oct-btn-primary mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-sm"
          >
            <UserPlus size={15} /> Follow your first caller
          </button>
        ) : (
          <p className="mt-3">
            Head to <span className="text-oct-text font-semibold">Pump.fun → Following</span> to add callers by
            @username, from the leaderboard, or from the curated list.
          </p>
        )}
      </Shell>
    );
  }

  return (
    <Shell title={`Watching ${followCount} ${followCount === 1 ? 'caller' : 'callers'}`}>
      <p>
        Nothing called yet. New callouts appear here the moment one of them posts.
      </p>
      <p className="mt-2">
        This feed is live-only — it starts empty each time you open the console rather than
        replaying a history OCT doesn&apos;t keep. Every callout also lands in your notifications,
        and can be DM&apos;d to you on Discord (Settings → Discord Bot).
      </p>
      {onGoToFollowing && (
        <button
          type="button"
          onClick={onGoToFollowing}
          className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-oct-sm border border-oct-border-bright text-xs font-bold text-oct-text hover:text-oct-accent hover:border-oct-accent transition-colors"
        >
          <UserPlus size={13} /> Follow more callers
        </button>
      )}
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <div className="w-14 h-14 rounded-oct-lg border border-oct-border bg-gradient-to-b from-oct-elevated to-oct-surface shadow-oct-soft flex items-center justify-center mb-4">
        <Megaphone size={24} className="text-oct-muted" />
      </div>
      <p className="text-oct-text font-bold uppercase tracking-wide mb-1.5">{title}</p>
      <div className="text-sm text-oct-muted max-w-sm leading-relaxed">{children}</div>
    </div>
  );
}

function PumpCalloutRow({ callout }: { callout: PumpCalloutFeedEntry }) {
  const caller = callerLabel(callout);
  const coin = coinLabel(callout);
  const mc = formatMcap(callout.marketCapUsd);
  const since = callout.multiple != null && callout.multiple >= 1.05 ? `${callout.multiple.toFixed(2)}×` : null;

  return (
    <li className="flex items-start gap-3 px-4 py-3 oct-row-hover">
      {callout.avatar ? (
        <img
          src={callout.avatar}
          alt=""
          loading="lazy"
          className="h-9 w-9 rounded-full object-cover shrink-0 bg-oct-surface-raised mt-0.5"
          onError={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = 'hidden')}
        />
      ) : (
        <span className="h-9 w-9 rounded-full bg-oct-surface-raised shrink-0 mt-0.5" />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[15px] font-bold text-oct-text truncate" title={callout.callerAddress}>
            {caller}
          </span>
          <span className="text-xs text-oct-muted">called</span>
          <a
            href={`https://pump.fun/coin/${encodeURIComponent(callout.coinMint)}`}
            target="_blank"
            rel="noreferrer noopener"
            title={callout.name ?? callout.coinMint}
            className="inline-flex items-center gap-1 font-mono text-[15px] font-bold text-oct-text hover:text-oct-accent hover:underline"
          >
            {coin}
            <ExternalLink size={11} className="shrink-0" />
          </a>
        </div>

        {callout.thesis && (
          <p className="mt-1 text-[13px] text-oct-text leading-snug whitespace-pre-wrap break-words line-clamp-3">
            {callout.thesis}
          </p>
        )}

        <div className="mt-1 flex items-center gap-3 text-xs text-oct-muted font-mono">
          <span title="Market cap at the moment of the call">MC @ call {mc}</span>
          {since && <span className="text-oct-green font-bold">{since} since</span>}
          {/* Peak since the call — always shown (an em dash when the poller path
              has none) so a row's stats keep the same shape frame to frame. */}
          <PeakMultiple value={callout.maxMultiplier} labelled className="text-xs" />
          <span className="truncate" title={callout.coinMint}>
            {truncateAddress(callout.coinMint)}
          </span>
        </div>
      </div>

      <div className="text-right shrink-0">
        <div className="text-xs text-oct-muted font-mono tabular-nums">{formatTime(callout.occurredAt)}</div>
      </div>
    </li>
  );
}
