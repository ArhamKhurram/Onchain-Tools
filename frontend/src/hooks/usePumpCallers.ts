// The user's followed pump.fun callers — the tracked set the backend poller
// pings on. Hosted-only (the tracked set lives in Supabase); in local mode the
// routes 503 and this surfaces a clear "sign in" state rather than erroring.
//
// Follow by @username: the backend resolves the handle to a wallet (== the
// callout feed's userId) and persists it. Unfollow by that wallet address.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getAccessToken } from '../lib/supabase';

const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

export interface TrackedCaller {
  callerAddress: string;
  username: string | null;
  displayName: string | null;
  avatar: string | null;
  source: string;
  notifyPushover: boolean;
  createdAt: string;
}

async function pumpFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  const token = await getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return (body as { error?: string }).error ?? fallback;
}

export function usePumpCallers() {
  const [callers, setCallers] = useState<TrackedCaller[]>([]);
  const [loading, setLoading] = useState(true);
  /** True when the backend says this feature needs a signed-in (hosted) account. */
  const [needsAuth, setNeedsAuth] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await pumpFetch('/pumpfun/callers');
      if (res.status === 503) {
        setNeedsAuth(true);
        setCallers([]);
        return;
      }
      setNeedsAuth(false);
      if (!res.ok) {
        setError(await readError(res, `Failed to load followed callers (${res.status}).`));
        return;
      }
      setCallers((await res.json()) as TrackedCaller[]);
    } catch (err) {
      setError((err as Error)?.message ?? 'Failed to load followed callers.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Follow a caller by @username (resolved server-side). Returns an error string or null. */
  const follow = useCallback(async (username: string): Promise<string | null> => {
    const handle = username.trim().replace(/^@/, '');
    if (!handle) return 'Enter a pump.fun username.';
    setBusy(true);
    try {
      const res = await pumpFetch('/pumpfun/callers', {
        method: 'POST',
        body: JSON.stringify({ username: handle }),
      });
      if (!res.ok) return await readError(res, `Couldn't follow @${handle} (${res.status}).`);
      const added = (await res.json()) as TrackedCaller;
      setCallers((prev) =>
        prev.some((c) => c.callerAddress === added.callerAddress) ? prev : [added, ...prev],
      );
      return null;
    } catch (err) {
      return (err as Error)?.message ?? 'Failed to follow caller.';
    } finally {
      setBusy(false);
    }
  }, []);

  /** Follow a caller by resolved wallet (leaderboard rows / popular presets). */
  const followByAddress = useCallback(
    async (caller: {
      address: string;
      username?: string | null;
      displayName?: string | null;
      avatar?: string | null;
      source?: string;
    }): Promise<string | null> => {
      setBusy(true);
      try {
        const res = await pumpFetch('/pumpfun/callers', {
          method: 'POST',
          body: JSON.stringify({
            address: caller.address,
            username: caller.username ?? null,
            displayName: caller.displayName ?? null,
            avatar: caller.avatar ?? null,
            source: caller.source ?? 'leaderboard',
          }),
        });
        if (!res.ok) return await readError(res, `Couldn't follow caller (${res.status}).`);
        const added = (await res.json()) as TrackedCaller;
        setCallers((prev) =>
          prev.some((c) => c.callerAddress === added.callerAddress) ? prev : [added, ...prev],
        );
        return null;
      } catch (err) {
        return (err as Error)?.message ?? 'Failed to follow caller.';
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  /** Follow many at once ("follow top N"); replaces the list with the server's. */
  const followMany = useCallback(
    async (
      list: Array<{ address: string; username?: string | null; displayName?: string | null; avatar?: string | null }>,
      source = 'leaderboard',
    ): Promise<string | null> => {
      if (list.length === 0) return null;
      setBusy(true);
      try {
        const res = await pumpFetch('/pumpfun/callers/bulk', {
          method: 'POST',
          body: JSON.stringify({
            source,
            callers: list.map((c) => ({
              address: c.address,
              username: c.username ?? null,
              displayName: c.displayName ?? null,
              avatar: c.avatar ?? null,
            })),
          }),
        });
        if (!res.ok) return await readError(res, `Bulk follow failed (${res.status}).`);
        setCallers((await res.json()) as TrackedCaller[]);
        return null;
      } catch (err) {
        return (err as Error)?.message ?? 'Failed to follow callers.';
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const unfollow = useCallback(async (callerAddress: string): Promise<void> => {
    // Optimistic remove; restore on failure.
    const prev = callers;
    setCallers((list) => list.filter((c) => c.callerAddress !== callerAddress));
    try {
      const res = await pumpFetch(`/pumpfun/callers/${encodeURIComponent(callerAddress)}`, { method: 'DELETE' });
      if (!res.ok) setCallers(prev);
    } catch {
      setCallers(prev);
    }
  }, [callers]);

  const followedAddresses = useMemo(() => new Set(callers.map((c) => c.callerAddress)), [callers]);

  return {
    callers,
    followedAddresses,
    loading,
    needsAuth,
    error,
    busy,
    follow,
    followByAddress,
    followMany,
    unfollow,
    refresh,
  };
}
