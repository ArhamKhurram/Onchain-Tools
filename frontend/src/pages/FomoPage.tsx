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
import FullPageSpinner from '../components/common/FullPageSpinner';
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
          <FomoTradeFeed />
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
