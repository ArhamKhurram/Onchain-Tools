import { useCallback, useEffect, useState } from 'react';
import { getAccessToken, getSupabase } from '../lib/supabase';
import type { FomoTrackedUser, FomoServiceStatus, FomoLeaderboardEntry } from '../types/fomo';

const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api';

const TRACKED_SELECT =
  'id, user_id, fomo_user_id, fomo_handle, display_name, notify_pushover, created_at';

async function fomoFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  const token = await getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

async function fetchFomoStatus(): Promise<FomoServiceStatus | null> {
  try {
    const res = await fomoFetch(`${API_BASE}/fomo/status`);
    if (!res.ok) return null;
    return (await res.json()) as FomoServiceStatus;
  } catch {
    return null;
  }
}

export function useFomoServiceStatus() {
  const [status, setStatus] = useState<FomoServiceStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setStatus(await fetchFomoStatus());
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { status, loading, refresh };
}

async function fetchLeaderboard(window: 'all' | '24h', limit = 50): Promise<FomoLeaderboardEntry[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (window === '24h') params.set('window', '24h');
  const res = await fomoFetch(`${API_BASE}/fomo/leaderboard?${params}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Failed to load leaderboard (${res.status}).`);
  return (body.entries ?? []) as FomoLeaderboardEntry[];
}

export function useFomoLeaderboard() {
  const [window, setWindow] = useState<'all' | '24h'>('24h');
  const [entries, setEntries] = useState<FomoLeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await fetchLeaderboard(window));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load leaderboard.');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [window]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { window, setWindow, entries, loading, error, refresh };
}

// Distinct outcomes the UI needs to surface for track. The `status` mirrors the
// backend's HTTP codes: 404 (not found), 409 (already tracked), 503 (FOMO not configured).
export type TrackResult =
  | { ok: true; user: FomoTrackedUser }
  | { ok: false; status: number; error: string };

export function useFomoTracking(userId: string | undefined) {
  const [tracked, setTracked] = useState<FomoTrackedUser[]>([]);
  const [loading, setLoading] = useState(!!userId);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) {
      setTracked([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const { data, error: fetchError } = await getSupabase()
        .from('fomo_tracked_users')
        .select(TRACKED_SELECT)
        .order('created_at', { ascending: false });

      if (fetchError) {
        setError(fetchError.message);
        setTracked([]);
        return;
      }

      setTracked((data as FomoTrackedUser[]) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tracked users.');
      setTracked([]);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const track = useCallback(async (query: string): Promise<TrackResult> => {
    const trimmed = query.trim();
    if (!trimmed) return { ok: false, status: 400, error: 'Enter a username to track.' };
    if (!userId) return { ok: false, status: 401, error: 'Not signed in.' };

    try {
      const res = await fomoFetch(`${API_BASE}/fomo/tracked`, {
        method: 'POST',
        body: JSON.stringify({ query: trimmed }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, status: res.status, error: body.error ?? 'Failed to track FOMO user.' };
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
  }, [userId]);

  const untrack = useCallback(async (id: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const { error: deleteError } = await getSupabase()
        .from('fomo_tracked_users')
        .delete()
        .eq('id', id);

      if (deleteError) {
        return { ok: false, error: deleteError.message || 'Failed to untrack user.' };
      }

      setTracked((prev) => prev.filter((u) => u.id !== id));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to untrack user.' };
    }
  }, []);

  const updateNotifyPushover = useCallback(
    async (id: string, notifyPushover: boolean): Promise<{ ok: boolean; error?: string }> => {
      try {
        const { data, error: updateError } = await getSupabase()
          .from('fomo_tracked_users')
          .update({ notify_pushover: notifyPushover })
          .eq('id', id)
          .select(TRACKED_SELECT)
          .maybeSingle();

        if (updateError) {
          return { ok: false, error: updateError.message || 'Failed to update Pushover setting.' };
        }
        if (!data) {
          return { ok: false, error: 'Tracked FOMO user not found.' };
        }

        const row = data as FomoTrackedUser;
        setTracked((prev) => prev.map((u) => (u.id === id ? row : u)));
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Failed to update Pushover setting.',
        };
      }
    },
    [],
  );

  return { tracked, loading, error, refresh, track, untrack, updateNotifyPushover };
}
