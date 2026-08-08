import { useCallback, useEffect, useState } from 'react';
import { apiFetch, API_BASE } from '../stores/appStore.helpers';
import {
  normalizePumpLeaderboard,
  type PumpLeaderboardEntry,
  type PumpLeaderboardWindow,
} from '../types/pumpfun';

// The user-login leaderboard fetch. Mirrors useFomoLeaderboard (window switch +
// refresh), but reads status codes explicitly rather than through pumpfunApi's
// error taxonomy, because a 401/403 here has a distinct meaning the UI must act on
// — the operator's pump session expired and needs a reconnect, not a retry.
//
// WIRE-PARAM NOTE: reconciled against the shipped backend. The route reads
// `req.query.window` (GET /pumpfun/leaderboard?window=7d) — the upstream
// coin-communities path uses `timeframe` as a path segment, but that never
// surfaces as our query-param name. Kept as a named constant so the wire contract
// is stated in one place rather than buried in the URL template below.
const LEADERBOARD_WINDOW_PARAM = 'window';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as unknown;
    if (isRecord(body) && typeof body.error === 'string') return body.error;
  } catch {
    // Non-JSON body.
  }
  return `Failed to load leaderboard (${res.status}).`;
}

export interface PumpLeaderboardHook {
  window: PumpLeaderboardWindow;
  setWindow: (w: PumpLeaderboardWindow) => void;
  entries: PumpLeaderboardEntry[];
  loading: boolean;
  error: string | null;
  /** The session was rejected upstream (401/403) — the tab flips to a reconnect prompt. */
  authExpired: boolean;
  /** A 502/network fault — the tab offers a retry rather than a dead end. */
  retryable: boolean;
  refresh: () => Promise<void>;
}

/**
 * @param enabled Only fetch when a session is connected. Gating here (rather than
 *   not mounting the hook) keeps the window switch's state stable across a
 *   reconnect, so the operator does not lose their 7d/30d/all choice.
 */
export function usePumpLeaderboard(enabled: boolean): PumpLeaderboardHook {
  const [window, setWindow] = useState<PumpLeaderboardWindow>('7d');
  const [entries, setEntries] = useState<PumpLeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authExpired, setAuthExpired] = useState(false);
  const [retryable, setRetryable] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setEntries([]);
      setError(null);
      setAuthExpired(false);
      setRetryable(false);
      return;
    }
    setLoading(true);
    setError(null);
    setAuthExpired(false);
    setRetryable(false);
    try {
      const params = new URLSearchParams({ [LEADERBOARD_WINDOW_PARAM]: window });
      const res = await apiFetch(`${API_BASE}/pumpfun/leaderboard?${params.toString()}`);
      if (res.status === 401 || res.status === 403) {
        setAuthExpired(true);
        setEntries([]);
        return;
      }
      if (!res.ok) {
        setRetryable(res.status === 502);
        setError(await readError(res));
        setEntries([]);
        return;
      }
      setEntries(normalizePumpLeaderboard(await res.json().catch(() => ({}))));
    } catch {
      // Network fault before any status — worth a retry.
      setRetryable(true);
      setError('Could not reach the server.');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [enabled, window]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { window, setWindow, entries, loading, error, authExpired, retryable, refresh };
}
