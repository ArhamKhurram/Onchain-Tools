import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, API_BASE } from '../stores/appStore.helpers';
import {
  describePumpConnection,
  type PumpConnectionStatus,
  type PumpConnectionSummary,
} from '../types/pumpfun';

// The pump.fun session-connection hook.
//
// CREDENTIAL DISCIPLINE (the load-bearing property of this file): the bearer NEVER
// lives here. `connect()` receives the pasted token as a bare argument, POSTs it
// straight to the backend, and lets it fall out of scope the moment the request
// returns — it is never stored in React state, never returned, never logged, never
// put into a URL. From then on the hook only ever reads the STATUS shape, which
// carries connected/expiry and, by construction, never the token. There is
// deliberately no accessor that hands the token back.

// The session resource lives at /api/pumpfun/session — GET reads status, POST sets
// it, DELETE clears it. This route is under /api (not the sniper control plane)
// because, while it reads a per-user secret, it spends nothing; the recon calls
// exactly that trade-off out.
const SESSION_URL = `${API_BASE}/pumpfun/session`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrow the status response defensively; unknown/garbage collapses to disconnected. */
function narrowStatus(body: unknown): PumpConnectionStatus {
  if (!isRecord(body)) return { connected: false, expiresAt: null, needsReconnect: false };
  const connected = body.connected === true;
  const expiresAt = typeof body.expiresAt === 'string' ? body.expiresAt : null;
  const needsReconnect = body.needsReconnect === true;
  return { connected, expiresAt, needsReconnect };
}

/** Read the `{ error }` a route sends, degrading to a status-coded generic. */
async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as unknown;
    if (isRecord(body) && typeof body.error === 'string') return body.error;
  } catch {
    // Non-JSON body — fall through.
  }
  return `Request failed (${res.status}).`;
}

export interface ConnectResult {
  ok: boolean;
  error?: string;
}

export function usePumpConnection() {
  // `status === null` means "not known yet" (initial load, or a status fetch that
  // failed) — describePumpConnection turns that into `unknown`, which the UI shows
  // as a spinner, never as a false "connect your account".
  const [status, setStatus] = useState<PumpConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  // Set only when the status fetch itself failed (vs. a clean "not connected"),
  // so the tab can offer a retry instead of a misleading connect prompt.
  const [statusError, setStatusError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setStatusError(null);
    try {
      const res = await apiFetch(SESSION_URL);
      if (!res.ok) {
        // A 404 here means "no session route yet / no session" — treat as a clean
        // disconnected state, not an error. Anything else is a real fetch fault.
        if (res.status === 404) {
          setStatus({ connected: false, expiresAt: null, needsReconnect: false });
        } else {
          setStatus(null);
          setStatusError(await readError(res));
        }
        return;
      }
      setStatus(narrowStatus(await res.json().catch(() => ({}))));
    } catch {
      setStatus(null);
      setStatusError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = useCallback(
    async (token: string): Promise<ConnectResult> => {
      const trimmed = token.trim();
      if (!trimmed) return { ok: false, error: 'Paste your pump.fun session token first.' };
      try {
        const res = await apiFetch(SESSION_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // The token leaves the caller's field and goes straight into the body.
          // This object is the only place it exists in the frontend, and it is
          // gone when this frame returns.
          body: JSON.stringify({ token: trimmed }),
        });
        if (!res.ok) return { ok: false, error: await readError(res) };
        // Re-read status rather than trusting the POST's echo — the status route
        // is the single source of truth for connected/expiry.
        await refresh();
        return { ok: true };
      } catch {
        return { ok: false, error: 'Could not reach the server.' };
      }
    },
    [refresh],
  );

  const disconnect = useCallback(async (): Promise<ConnectResult> => {
    try {
      const res = await apiFetch(SESSION_URL, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) return { ok: false, error: await readError(res) };
      setStatus({ connected: false, expiresAt: null, needsReconnect: false });
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not reach the server.' };
    }
  }, []);

  const summary: PumpConnectionSummary = useMemo(() => describePumpConnection(status), [status]);

  return { status, summary, loading, statusError, refresh, connect, disconnect };
}
