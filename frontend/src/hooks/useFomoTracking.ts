import { useCallback, useEffect, useState } from 'react';
import { getAccessToken, getSupabase } from '../lib/supabase';
import type { FomoTrackedUser } from '../types/fomo';

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

interface ResolvedFomoUser {
  fomoUserId: string;
  fomoHandle: string | null;
  displayName: string | null;
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
      const res = await fomoFetch(`${API_BASE}/fomo/resolve`, {
        method: 'POST',
        body: JSON.stringify({ query: trimmed }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, status: res.status, error: body.error ?? 'Failed to resolve FOMO user.' };
      }

      const resolved = body as ResolvedFomoUser;
      const { data, error: insertError } = await getSupabase()
        .from('fomo_tracked_users')
        .insert({
          user_id: userId,
          fomo_user_id: resolved.fomoUserId,
          fomo_handle: resolved.fomoHandle,
          display_name: resolved.displayName,
        })
        .select(TRACKED_SELECT)
        .single();

      if (insertError) {
        if (insertError.code === '23505') {
          return { ok: false, status: 409, error: 'You are already tracking this FOMO user.' };
        }
        return { ok: false, status: 500, error: insertError.message || 'Failed to track user.' };
      }

      const user = data as FomoTrackedUser;
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
