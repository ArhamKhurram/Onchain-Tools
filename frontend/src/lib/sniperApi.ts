// The sniper's own fetch helper.
//
// It exists because `apiFetch`/`API_BASE` (stores/appStore.helpers.ts) resolve to
// `VITE_API_URL + '/api'`, and the sniper control plane deliberately does NOT
// mount under /api — it sits at /sniper/v1, ahead of the app-wide cors() and
// outside authMiddleware, so that a money-spending surface answers to its own
// origin allow list rather than the app-wide one (backend/src/api/sniper/auth.ts).
// A helper that reached it through API_BASE would be reaching the wrong prefix.
//
// Every request here is cross-origin whenever VITE_API_URL is set, and the
// Authorization / X-OCT-Sniper-Token header below forces a preflight, so the
// console's own origin MUST be in the backend's ALLOWED_ORIGINS in hosted mode.
// No request sets `credentials`: this plane authenticates on these headers and
// on nothing ambient, and its CORS layer withholds Allow-Credentials to keep it
// that way.
//
// Two credentials, one per mode:
//   hosted — the Supabase bearer, same token apiFetch attaches.
//   local  — a per-boot control token fetched once from GET /sniper/v1/session.
//
// The local token is held in a module-level `let` and NOTHING else: never
// localStorage, never appStore, never a URL parameter, never a log line. A
// backend restart rotates it, which is why a 401 clears the cache and retries
// exactly once rather than surfacing an auth error the operator cannot act on.

import { getAccessToken, isHostedMode } from './supabase';

export const SNIPER_BASE = `${import.meta.env.VITE_API_URL ?? ''}/sniper/v1`;

let controlToken: string | null = null;
let inFlight: Promise<string | null> | null = null;

/**
 * Fetch (and cache) the local control token. Deduped through a module-level
 * in-flight promise — the same idiom useCallerQuality.ts:45-70 uses — because
 * four hooks mount at once on the Sniper page and would otherwise open four
 * concurrent session calls on first paint.
 */
async function loadControlToken(force = false): Promise<string | null> {
  if (!force && controlToken) return controlToken;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetch(`${SNIPER_BASE}/session`);
      if (!res.ok) return null;
      const data = (await res.json()) as { token?: unknown };
      controlToken = typeof data.token === 'string' ? data.token : null;
      return controlToken;
    } catch {
      // A backend that is down must not throw out of every sniper hook; the
      // callers render their own "control plane unreachable" error instead.
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

async function withCredential(init: RequestInit | undefined, force: boolean): Promise<RequestInit> {
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type') && init?.body) headers.set('Content-Type', 'application/json');

  if (isHostedMode) {
    const token = await getAccessToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  } else {
    const token = await loadControlToken(force);
    if (token) headers.set('X-OCT-Sniper-Token', token);
  }

  return { ...init, headers };
}

export async function sniperFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${SNIPER_BASE}${path}`, await withCredential(init, false));
  // Local mode only: a 401 means the backend rebooted and rotated the per-boot
  // token. Re-fetch it and retry once. Hosted 401s are a real session problem
  // and must surface.
  if (res.status === 401 && !isHostedMode) {
    controlToken = null;
    return fetch(`${SNIPER_BASE}${path}`, await withCredential(init, true));
  }
  return res;
}

export type SniperResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; reason: string; detail?: string };

/**
 * JSON wrapper returning a discriminated union rather than throwing, because the
 * UI has to distinguish 403 `rule_not_armed` from 409 `no_credential` from 422
 * `size_over_trigger_cap` and say something different for each. Same reason
 * useFomoTracking.track returns a union.
 */
export async function sniperJson<T>(path: string, init?: RequestInit): Promise<SniperResult<T>> {
  let res: Response;
  try {
    res = await sniperFetch(path, init);
  } catch {
    return { ok: false, status: 0, reason: 'unreachable' };
  }

  if (res.status === 204) return { ok: true, data: undefined as T };

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const err = (body ?? {}) as { reason?: unknown; error?: unknown; detail?: unknown };
    const reason =
      typeof err.reason === 'string' ? err.reason : typeof err.error === 'string' ? err.error : `http_${res.status}`;
    return {
      ok: false,
      status: res.status,
      reason,
      detail: typeof err.detail === 'string' ? err.detail : undefined,
    };
  }

  return { ok: true, data: body as T };
}

/** POST helper — every sniper mutation is a JSON POST with a confirmation word. */
export function sniperPost<T>(path: string, body?: unknown): Promise<SniperResult<T>> {
  return sniperJson<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
}
