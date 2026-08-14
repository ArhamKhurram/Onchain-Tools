import { useCallback, useEffect, useState } from 'react';
import { pumpGet } from '../lib/pumpfunApi';
import type { PumpCommunity, PumpFeedItem } from '../types/pumpfun';

// The Top / Trending panel: the top-communities board and the public feed slice.
// BOTH are KEYED, so an unset key is a single "not configured" state for the tab.
// Kept as one hook because the two render side by side on one tab and share a
// single load; each still carries its own error so one failing does not blank the
// other.

interface TrendingState<T> {
  data: T;
  error: string | null;
  disabled: boolean;
  retryable: boolean;
}

const idle = <T>(initial: T): TrendingState<T> => ({ data: initial, error: null, disabled: false, retryable: false });

export function usePumpTrending() {
  const [communities, setCommunities] = useState<TrendingState<PumpCommunity[]>>(() => idle<PumpCommunity[]>([]));
  const [feed, setFeed] = useState<TrendingState<PumpFeedItem[]>>(() => idle<PumpFeedItem[]>([]));
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [communitiesRes, feedRes] = await Promise.all([
      pumpGet<PumpCommunity[]>('/communities/top'),
      pumpGet<PumpFeedItem[]>('/feed'),
    ]);
    setCommunities(
      communitiesRes.ok
        ? idle(communitiesRes.data)
        : { data: [], error: communitiesRes.disabled ? null : communitiesRes.error, disabled: communitiesRes.disabled, retryable: communitiesRes.retryable },
    );
    setFeed(
      feedRes.ok
        ? idle(feedRes.data)
        : { data: [], error: feedRes.disabled ? null : feedRes.error, disabled: feedRes.disabled, retryable: feedRes.retryable },
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { communities, feed, loading, refresh: load };
}
