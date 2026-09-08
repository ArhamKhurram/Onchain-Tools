import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Radio } from 'lucide-react';
import { useAuthSession } from '../hooks/useAuthSession';
import { useFomoServiceStatus, useFomoTracking } from '../hooks/useFomoTracking';
import ConsoleEmptyState from '../components/console/ConsoleEmptyState';
import ConsoleSubnav from '../components/console/ConsoleSubnav';
import FomoTradeFeed from '../components/fomo/FomoTradeFeed';
import FomoLeaderboard from '../components/fomo/FomoLeaderboard';
import FomoTrackedList from '../components/fomo/FomoTrackedList';
import FomoHoldersLookup from '../components/fomo/FomoHoldersLookup';
import FomoThesesLookup from '../components/fomo/FomoThesesLookup';
import FomoTraderLookup from '../components/fomo/FomoTraderLookup';
import RobinhoodTape from '../components/robinhood/RobinhoodTape';
import FomoStreamTape from '../components/fomo/FomoStreamTape';
import FullPageSpinner from '../components/common/FullPageSpinner';
import { cn } from '../lib/utils';
import { routes } from '../lib/routes';
import type { FomoLeaderboardEntry } from '../types/fomo';

// One home for everything fomo.family. Each tab is a distinct surface; the
// Tracking and Leaderboard tabs share a single useFomoTracking instance (owned
// here) so tracking someone on the leaderboard reflects in the tracked list
// immediately.
type FomoView = 'live' | 'leaderboard' | 'tracking' | 'holders' | 'theses' | 'traders' | 'rhchain';

const FOMO_TABS = [
  { id: 'live' as const, label: 'Live' },
  { id: 'leaderboard' as const, label: 'Leaderboard' },
  { id: 'tracking' as const, label: 'Tracking' },
  { id: 'holders' as const, label: 'Holders' },
  { id: 'theses' as const, label: 'Theses' },
  { id: 'traders' as const, label: 'Traders' },
  // Independent third-party source (robinhoodtrenches), Robinhood Chain only.
  // Named for the chain rather than "FOMO" so the scope is obvious from the tab.
  { id: 'rhchain' as const, label: 'RH Chain' },
];

// ── The Live tab ─────────────────────────────────────────────────────────────
//
// Two sources, never merged. "All chains" is 985monitor.xyz's public
// re-broadcast of fomo.family activity; "Tracked" is OCT's own fomo.family
// feed, which stays starved while the service account is blocked upstream.
// They are picked between rather than interleaved, because a row from one
// rendered next to a row from the other reads as a single OCT feed and that
// would be a lie about where the data came from ("signals stay independent").
//
// The all-chain source is the default: it is the one that has data.
const LIVE_SOURCE_STORAGE_KEY = 'oct.fomo.liveSource';
type LiveSource = 'stream' | 'tracked';

const LIVE_SOURCES: { value: LiveSource; label: string; title: string }[] = [
  { value: 'stream', label: 'ALL CHAINS', title: 'All-chain tape re-broadcast by 985monitor.xyz' },
  { value: 'tracked', label: 'TRACKED', title: "Your tracked traders, from OCT's own fomo.family feed" },
];

function loadLiveSource(): LiveSource {
  try {
    return localStorage.getItem(LIVE_SOURCE_STORAGE_KEY) === 'tracked' ? 'tracked' : 'stream';
  } catch {
    return 'stream';
  }
}

function LiveView() {
  const [source, setSource] = useState<LiveSource>(loadLiveSource);

  const pick = (next: LiveSource) => {
    setSource(next);
    try {
      localStorage.setItem(LIVE_SOURCE_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 flex items-center gap-cozy px-comfy py-tight border-b border-oct-border bg-oct-surface">
        <span className="type-caption uppercase tracking-wide text-oct-muted">Source</span>
        {LIVE_SOURCES.map((s) => (
          <button
            key={s.value}
            type="button"
            title={s.title}
            onClick={() => pick(s.value)}
            className={cn(
              'px-cozy py-tight rounded-oct-sm type-caption font-mono font-bold border transition-all duration-fast',
              source === s.value
                ? 'bg-oct-accent text-white border-oct-accent/50 shadow-oct-glow-accent'
                : 'text-oct-muted border-transparent hover:border-oct-border-bright hover:text-oct-text',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {source === 'stream' ? <FomoStreamTape embedded /> : <FomoTradeFeed />}
      </div>
    </div>
  );
}

function parseView(raw: string | null): FomoView {
  if (
    raw === 'leaderboard' ||
    raw === 'tracking' ||
    raw === 'holders' ||
    raw === 'theses' ||
    raw === 'traders' ||
    raw === 'rhchain'
  )
    return raw;
  return 'live';
}

export default function FomoPage() {
  const { isAuthenticated, ready, userId } = useAuthSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = useMemo(() => parseView(searchParams.get('view')), [searchParams]);

  const tracking = useFomoTracking(userId ?? '');
  const { status: serviceStatus } = useFomoServiceStatus();
  const [trackingLeaderId, setTrackingLeaderId] = useState<string | null>(null);

  const trackedIds = useMemo(
    () => new Set(tracking.tracked.map((u) => u.fomo_user_id)),
    [tracking.tracked],
  );
  const trackedHandles = useMemo(
    () => new Set(tracking.tracked.map((u) => u.fomo_handle?.toLowerCase()).filter(Boolean) as string[]),
    [tracking.tracked],
  );

  const setView = (next: FomoView) => {
    setSearchParams(next === 'live' ? {} : { view: next }, { replace: true });
  };

  // The board row is already a resolved identity, so this never goes through
  // the (blocked) fomo.family lookup — it hands the identity to the backend.
  const onTrackFromLeaderboard = async (entry: FomoLeaderboardEntry) => {
    setTrackingLeaderId(entry.fomoUserId);
    const label = entry.fomoHandle ?? entry.displayName ?? entry.fomoUserId;
    const result = await tracking.track(label, {
      fomoUserId: entry.fomoUserId,
      fomoHandle: entry.fomoHandle,
      displayName: entry.displayName,
    });
    setTrackingLeaderId(null);
    if (result.ok) return { ok: true as const };
    return { ok: false as const, status: result.status, error: result.error };
  };

  if (!ready) {
    return <FullPageSpinner />;
  }

  if (!isAuthenticated || !userId) {
    return (
      <ConsoleEmptyState
        icon={Radio}
        eyebrow="[ FOMO ]"
        title="Sign in for FOMO"
        description="Live trades, the leaderboard, your tracked traders, token holders, theses, and trader lookup — all from fomo.family."
        actionLabel="SIGN IN"
        actionTo={routes.login}
        secondaryLabel="← Back to console home"
        secondaryTo={routes.home}
      />
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-oct-bg">
      <ConsoleSubnav tabs={FOMO_TABS} active={view} onChange={setView} />
      <div className="flex-1 min-h-0">
        {view === 'live' ? (
          <LiveView />
        ) : view === 'leaderboard' ? (
          <FomoLeaderboard
            trackedIds={trackedIds}
            trackedHandles={trackedHandles}
            onTrack={onTrackFromLeaderboard}
            trackingId={trackingLeaderId}
          />
        ) : view === 'tracking' ? (
          <FomoTrackedList
            tracking={tracking}
            configured={serviceStatus?.configured ?? true}
            feedLive={serviceStatus ? serviceStatus.pollerActive : true}
          />
        ) : view === 'holders' ? (
          <FomoHoldersLookup />
        ) : view === 'theses' ? (
          <FomoThesesLookup />
        ) : view === 'rhchain' ? (
          <RobinhoodTape />
        ) : (
          <FomoTraderLookup />
        )}
      </div>
    </div>
  );
}
