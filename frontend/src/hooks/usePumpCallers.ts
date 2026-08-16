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
  /** Per-caller Discord-DM mute. True unless the user turned this caller off. */
  notifyDiscord: boolean;
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

  /**
   * Follow several callers given by @username (the "Follow all popular" on-ramp).
   * Each handle is resolved to a wallet server-side; already-followed handles and
   * ones that fail to resolve are skipped, then the rest go through in one bulk
   * write. Returns an error string only when nothing could be followed.
   */
  const followByUsernames = useCallback(
    async (handles: readonly string[], source = 'popular'): Promise<string | null> => {
      const followed = new Set(callers.map((c) => (c.username ?? '').toLowerCase()));
      const pending = handles
        .map((h) => h.trim().replace(/^@/, ''))
        .filter((h) => h && !followed.has(h.toLowerCase()));
      if (pending.length === 0) return null;

      setBusy(true);
      try {
        const resolved: Array<{ address: string; username: string | null; avatar: string | null }> = [];
        for (const handle of pending) {
          try {
            const res = await pumpFetch('/pumpfun/callers/resolve', {
              method: 'POST',
              body: JSON.stringify({ username: handle }),
            });
            if (!res.ok) continue; // unknown handle → skip, don't fail the batch
            const caller = (await res.json()) as { address?: string; username?: string | null; avatar?: string | null };
            if (typeof caller.address === 'string' && caller.address) {
              resolved.push({ address: caller.address, username: caller.username ?? handle, avatar: caller.avatar ?? null });
            }
          } catch {
            // Network hiccup on one handle shouldn't sink the whole batch.
          }
        }
        if (resolved.length === 0) return 'Could not resolve any of those callers.';

        const res = await pumpFetch('/pumpfun/callers/bulk', {
          method: 'POST',
          body: JSON.stringify({
            source,
            callers: resolved.map((c) => ({ address: c.address, username: c.username, displayName: null, avatar: c.avatar })),
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
    [callers],
  );

  /**
   * Mute/unmute one caller's Discord DMs. Optimistic — the row flips instantly
   * and reverts if the write fails, matching the unfollow flow. This is the ONLY
   * per-caller switch the UI exposes; the two settings-level gates
   * (discordBotDm.enabled + triggers.pumpCallout) live in Settings.
   */
  const setNotifyDiscord = useCallback(
    async (callerAddress: string, notifyDiscord: boolean): Promise<void> => {
      const prev = callers;
      setCallers((list) =>
        list.map((c) => (c.callerAddress === callerAddress ? { ...c, notifyDiscord } : c)),
      );
      try {
        const res = await pumpFetch(`/pumpfun/callers/${encodeURIComponent(callerAddress)}`, {
          method: 'PATCH',
          body: JSON.stringify({ notifyDiscord }),
        });
        if (!res.ok) setCallers(prev);
        else {
          const updated = (await res.json()) as TrackedCaller;
          setCallers((list) => list.map((c) => (c.callerAddress === callerAddress ? updated : c)));
        }
      } catch {
        setCallers(prev);
      }
    },
    [callers],
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
    followByUsernames,
    setNotifyDiscord,
    unfollow,
    refresh,
  };
}
