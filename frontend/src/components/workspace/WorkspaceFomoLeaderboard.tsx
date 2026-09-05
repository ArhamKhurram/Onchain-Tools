import { useMemo } from 'react';
import { useAuthSession } from '../../hooks/useAuthSession';
import { useFomoTracking } from '../../hooks/useFomoTracking';
import FomoLeaderboard from '../fomo/FomoLeaderboard';

export default function WorkspaceFomoLeaderboard() {
  const { userId } = useAuthSession();
  const { tracked, track } = useFomoTracking(userId ?? '');

  const trackedIds = useMemo(() => new Set(tracked.map((u) => u.fomo_user_id)), [tracked]);
  const trackedHandles = useMemo(
    () => new Set(tracked.map((u) => u.fomo_handle?.toLowerCase()).filter(Boolean) as string[]),
    [tracked],
  );

  if (!userId) {
    return (
      <div className="flex items-center justify-center h-full p-section text-center">
        <p className="type-body font-mono text-oct-muted">Sign in to view leaderboard</p>
      </div>
    );
  }

  return (
    <FomoLeaderboard
      embedded
      trackedIds={trackedIds}
      trackedHandles={trackedHandles}
      onTrack={async (query, _fomoUserId) => {
        const result = await track(query);
        if (result.ok) return { ok: true as const };
        return { ok: false as const, status: result.status, error: result.error };
      }}
      trackingId={null}
    />
  );
}
