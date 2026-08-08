// Thin fetch layer for the pump.fun routes. These live under /api (public,
// read-only data — nothing spends), so this uses `apiFetch` + `API_BASE` from the
// store, NOT sniperApi.ts: that client is the /sniper/v1 control plane and must
// not sit behind the /api prefix. apiFetch attaches the Supabase bearer in hosted
// mode; in local mode it is a plain fetch.
//
// The one job beyond fetching is turning the backend's error taxonomy into a
// shape the hooks can branch on WITHOUT re-reading status codes everywhere:
//   - 503 -> `disabled` (PUMPFUN_API_KEY not set; the KEYED callouts surface is
//     off). This is a configuration state, not a failure — the keyless
//     trades/PnL surface keeps working, so hooks must treat it as "empty +
//     explain", never as an error that blanks the page.
//   - 502 -> a vendor/contract fault behind our gateway; `retryable` so the UI
//     offers a retry rather than a dead end.
//   - anything else non-2xx -> a plain error with the server's message.

import { apiFetch, API_BASE } from '../stores/appStore.helpers';

export type PumpResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; disabled: boolean; retryable: boolean };

function pumpUrl(path: string): string {
  return `${API_BASE}/pumpfun${path}`;
}

/** Read the `{ error }` body a route sends, degrading to a fixed message. */
async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as unknown;
    if (body && typeof body === 'object' && typeof (body as Record<string, unknown>).error === 'string') {
      return (body as Record<string, unknown>).error as string;
    }
  } catch {
    // Non-JSON error body — fall through to the generic message.
  }
  return `Request failed (${res.status}).`;
}

function fail(status: number, error: string): PumpResult<never> {
  return {
    ok: false,
    status,
    error,
    disabled: status === 503,
    // 502 is our gateway reporting a vendor/contract fault — worth a retry. A
    // 400/404 is our own bad request and retrying it would just fail again.
    retryable: status === 502 || status === 0,
  };
}

export async function pumpGet<T>(path: string): Promise<PumpResult<T>> {
  let res: Response;
  try {
    res = await apiFetch(pumpUrl(path));
  } catch {
    // Network error before any status — treat as retryable (status 0).
    return fail(0, 'Could not reach the server.');
  }
  if (!res.ok) return fail(res.status, await readError(res));
  return { ok: true, data: (await res.json()) as T };
}

export async function pumpPost<T>(path: string, body: unknown): Promise<PumpResult<T>> {
  let res: Response;
  try {
    res = await apiFetch(pumpUrl(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return fail(0, 'Could not reach the server.');
  }
  if (!res.ok) return fail(res.status, await readError(res));
  return { ok: true, data: (await res.json()) as T };
}
