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
//   - 429 -> `rateLimited` (the shared key is being paced). Retryable, but the UI
//     must NOT show the server message as an error — it shows a calm, self-healing
//     "retrying" state and backs off automatically. `retryAfter` (seconds) carries
//     the server's hint when it sent one.
//   - 502 -> a vendor/contract fault behind our gateway; `retryable` so the UI
//     offers a retry rather than a dead end.
//   - anything else non-2xx -> a plain error with the server's message.

import { apiFetch, API_BASE } from '../stores/appStore.helpers';

export type PumpResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: number;
      error: string;
      disabled: boolean;
      retryable: boolean;
      /** 429: the shared key is rate-limited. Render a calm "retrying" state, not the error text. */
      rateLimited: boolean;
      /** Seconds the server asked us to wait (from Retry-After), or null when it gave no hint. */
      retryAfter: number | null;
    };

function pumpUrl(path: string): string {
  return `${API_BASE}/pumpfun${path}`;
}

interface PumpErrorBody {
  error: string;
  rateLimited: boolean;
  retryAfter: number | null;
}

/** Read the structured error body a route sends, degrading to a fixed message. */
async function readErrorBody(res: Response): Promise<PumpErrorBody> {
  let error = `Request failed (${res.status}).`;
  let rateLimited = res.status === 429;
  let retryAfter: number | null = null;
  try {
    const body = (await res.json()) as unknown;
    if (body && typeof body === 'object') {
      const rec = body as Record<string, unknown>;
      if (typeof rec.error === 'string') error = rec.error;
      if (rec.rateLimited === true) rateLimited = true;
      if (typeof rec.retryAfter === 'number' && Number.isFinite(rec.retryAfter)) retryAfter = rec.retryAfter;
    }
  } catch {
    // Non-JSON error body — fall through to the generic message.
  }
  return { error, rateLimited, retryAfter };
}

function fail(status: number, body: PumpErrorBody): PumpResult<never> {
  return {
    ok: false,
    status,
    error: body.error,
    disabled: status === 503,
    // 429 (rate limit) and 502 (vendor/contract fault) are worth an automatic
    // retry; a status-0 network drop too. A 400/404 is our own bad request and
    // retrying it would just fail again.
    retryable: status === 429 || status === 502 || status === 0,
    rateLimited: body.rateLimited,
    retryAfter: body.retryAfter,
  };
}

/** Build the fail shape for a pre-status network drop (no body to read). */
function networkFail(): PumpResult<never> {
  return fail(0, { error: 'Could not reach the server.', rateLimited: false, retryAfter: null });
}

export async function pumpGet<T>(path: string): Promise<PumpResult<T>> {
  let res: Response;
  try {
    res = await apiFetch(pumpUrl(path));
  } catch {
    // Network error before any status — treat as retryable (status 0).
    return networkFail();
  }
  if (!res.ok) return fail(res.status, await readErrorBody(res));
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
    return networkFail();
  }
  if (!res.ok) return fail(res.status, await readErrorBody(res));
  return { ok: true, data: (await res.json()) as T };
}
