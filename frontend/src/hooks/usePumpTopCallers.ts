// The auto-discovered Top Callers board — OCT's own keyless caller-quality
// leaderboard, built from the global pump.fun callout feed the backend records.
// Hosted-only (it reads Supabase-backed aggregates); in local mode the route 503s
// and this surfaces a clear "sign in" state rather than erroring.
//
// The board is GLOBAL public data, so this only READS. Following a caller from a
// row is done through usePumpCallers().followByAddress in the component.

import { useCallback, useEffect, useState } from 'react';
import { getAccessToken } from '../lib/supabase';

const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

export type TopCallersWindow = 'all' | '24h' | '7d' | '30d';
export type TopCallersMetric = 'count' | 'avg' | 'max';

export interface TopCaller {
  callerAddress: string;
  username: string | null;
  avatar: string | null;
  calloutCount: number;
  avgMultiple: number | null;
  maxMultiple: number | null;
  lastCalloutAt: string | null;
}

export const TOP_CALLERS_WINDOWS: readonly { id: TopCallersWindow; label: string }[] = [
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: 'all', label: 'All' },
] as const;

// Labelled "Peak", not "Return": `multiple` is maxPriceSol / calloutPrice — a
// running high the token touched after the call, never a realized return (it
// cannot go below 1.0×). A caller-quality census found board rank on this
// metric correlates -0.217 with actual outcome (current price / call price) —
// ranking higher predicts slightly worse, not better. See oct-pump-kol-callout-alerts
// memory. Kept as a metric (raw feed data, not fabricated) but never call it
// "Avg ×" / "Best ×" unqualified, which read as performance.
export const TOP_CALLERS_METRICS: readonly { id: TopCallersMetric; label: string }[] = [
  { id: 'count', label: 'Calls' },
  { id: 'avg', label: 'Avg Peak ×' },
  { id: 'max', label: 'Best Peak ×' },
] as const;

async function pumpFetch(path: string): Promise<Response> {
  const headers = new Headers();
  const token = await getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${API_BASE}${path}`, { headers });
}

export function usePumpTopCallers() {
  const [callers, setCallers] = useState<TopCaller[]>([]);
  const [loading, setLoading] = useState(true);
  /** True when the backend says this feature needs a signed-in (hosted) account. */
  const [needsAuth, setNeedsAuth] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [window, setWindow] = useState<TopCallersWindow>('7d');
  const [metric, setMetric] = useState<TopCallersMetric>('count');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ window, metric, limit: '50', minCalls: '3' });
      const res = await pumpFetch(`/pumpfun/top-callers?${params.toString()}`);
      if (res.status === 503) {
        setNeedsAuth(true);
        setCallers([]);
        return;
      }
      setNeedsAuth(false);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Failed to load the board (${res.status}).`);
        return;
      }
      setCallers((await res.json()) as TopCaller[]);
    } catch (err) {
      setError((err as Error)?.message ?? 'Failed to load the top-callers board.');
    } finally {
      setLoading(false);
    }
  }, [window, metric]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { callers, loading, needsAuth, error, window, setWindow, metric, setMetric, refresh };
}
