import { useCallback, useEffect, useState } from 'react';
import { getAccessToken } from '../lib/supabase';
import type { FomoTrackedUser } from '../types/fomo';

// Mirror the authed-fetch approach used by the app store (API_BASE + bearer
// token from Supabase) rather than rolling our own auth. The FOMO REST routes
// live under /api/fomo and are all behind authMiddleware.
const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api';

async function fomoFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  const token = await getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

// Distinct outcomes the UI needs to surface for POST /tracked. The `status`
// mirrors the backend's HTTP codes: 404 (not found), 409 (already tracked),
// 503 (FOMO not configured on the server).
export type TrackResult =
  | { ok: true; user: FomoTrackedUser }
  | { ok: false; status: number; error: string };

export function useFomoTracking() {
  const [tracked, setTracked] = useState<FomoTrackedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fomoFetch(`${API_BASE}/fomo/tracked`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Failed to load tracked users (${res.status}).`);
        setTracked([]);
        return;
      }
      const data = (await res.json()) as FomoTrackedUser[];
      setTracked(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tracked users.');
      setTracked([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const track = useCallback(async (query: string): Promise<TrackResult> => {
    const trimmed = query.trim();
    if (!trimmed) return { ok: false, status: 400, error: 'Enter a username to track.' };
    try {
      const res = await fomoFetch(`${API_BASE}/fomo/tracked`, {
        method: 'POST',
        body: JSON.stringify({ query: trimmed }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, status: res.status, error: body.error ?? 'Failed to track user.' };
      }
      const user = body as FomoTrackedUser;
      setTracked((prev) => [user, ...prev.filter((u) => u.id !== user.id)]);
      return { ok: true, user };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : 'Failed to track user.',
      };
    }
  }, []);

  const untrack = useCallback(async (id: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fomoFetch(`${API_BASE}/fomo/tracked/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error ?? 'Failed to untrack user.' };
      }
      setTracked((prev) => prev.filter((u) => u.id !== id));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to untrack user.' };
    }
  }, []);

  return { tracked, loading, error, refresh, track, untrack };
}
