import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, apiFetch } from '../stores/appStore.helpers';
import type { PoolCandidate } from '../components/lp/types';

/**
 * `GET /api/lp/pools/candidates?minTvlUsd=&min24hVolumeUsd=`
 *
 * Returns the pools worth *looking at*. Discovery has no authority: nothing in
 * this response can put a pool on the allowlist — see `selection.ts`.
 */

export interface UseLpPoolCandidatesResult {
  candidates: PoolCandidate[];
  loading: boolean;
  error: string | null;
  /** The backend has no candidates route yet. */
  unavailable: boolean;
  /**
   * Pools discovery returned but could not parse. Reported rather than
   * swallowed: a shortlist that quietly shrinks because an upstream schema
   * changed looks identical to a chain with fewer good pools.
   */
  skippedCount: number;
  /** Criteria the last successful fetch was made with. */
  fetchedWith: { minTvlUsd: number; min24hVolumeUsd: number } | null;
  refresh: () => Promise<void>;
}

export function useLpPoolCandidates(
  minTvlUsd: number,
  min24hVolumeUsd: number,
  enabled = true,
): UseLpPoolCandidatesResult {
  const [candidates, setCandidates] = useState<PoolCandidate[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [skippedCount, setSkippedCount] = useState(0);
  const [fetchedWith, setFetchedWith] = useState<{ minTvlUsd: number; min24hVolumeUsd: number } | null>(
    null,
  );
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (Number.isFinite(minTvlUsd)) params.set('minTvlUsd', String(minTvlUsd));
    if (Number.isFinite(min24hVolumeUsd)) params.set('min24hVolumeUsd', String(min24hVolumeUsd));

    try {
      const res = await apiFetch(`${API_BASE}/lp/pools/candidates?${params.toString()}`);
      if (id !== requestId.current) return;

      if (res.status === 404 || res.status === 501) {
        setUnavailable(true);
        setCandidates([]);
        setLoading(false);
        return;
      }

      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        body = null;
      }
      if (id !== requestId.current) return;

      if (!res.ok) {
        const record = (body ?? {}) as Record<string, unknown>;
        throw new Error(
          typeof record.error === 'string' ? record.error : `Pool discovery failed (${res.status})`,
        );
      }

      // Accept a bare array or `{ pools: [...] }` / `{ candidates: [...] }`.
      const list = Array.isArray(body)
        ? body
        : Array.isArray((body as Record<string, unknown> | null)?.pools)
          ? ((body as Record<string, unknown>).pools as unknown[])
          : Array.isArray((body as Record<string, unknown> | null)?.candidates)
            ? ((body as Record<string, unknown>).candidates as unknown[])
            : [];

      const skipped = (body as Record<string, unknown> | null)?.skipped;
      setUnavailable(false);
      setCandidates(list.filter((entry): entry is PoolCandidate => !!entry && typeof entry === 'object'));
      setSkippedCount(Array.isArray(skipped) ? skipped.length : 0);
      setFetchedWith({ minTvlUsd, min24hVolumeUsd });
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load pool candidates');
      setCandidates([]);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [enabled, minTvlUsd, min24hVolumeUsd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { candidates, loading, error, unavailable, skippedCount, fetchedWith, refresh };
}
