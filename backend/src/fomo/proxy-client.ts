// HTTP proxy to the always-on FOMO worker (VPS). Used when FOMO_PROXY_URL is set
// so Railway never launches Playwright locally.

import type { FomoCallResult, FomoCredentials } from './types.js';
import { recordFomoUpstreamError, recordFomoUpstreamSuccess } from './health.js';

const DEBUG = process.env.DEBUG === 'true';

function debug(...args: unknown[]): void {
  if (DEBUG) console.log('[FomoProxy]', ...args);
}

function proxyBaseUrl(): string {
  const raw = process.env.FOMO_PROXY_URL?.trim();
  if (!raw) throw new Error('FOMO_PROXY_URL is not configured.');
  return raw.replace(/\/+$/, '');
}

function workerSecret(): string {
  const secret = process.env.FOMO_WORKER_SECRET?.trim();
  if (!secret) throw new Error('FOMO_WORKER_SECRET is required when FOMO_PROXY_URL is set.');
  return secret;
}

/**
 * Cap on a single worker round-trip. Without one, undici waits out its 300s
 * header timeout, so a struggling worker parks Railway request handlers for
 * five minutes instead of failing fast. A 35-token /hodlers/top returns ~2 MB
 * in ~2s on a healthy worker, so 45s is generous.
 */
function workerTimeoutMs(): number {
  const raw = Number(process.env.FOMO_WORKER_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 45_000;
}

/**
 * Node's fetch collapses every transport failure into `TypeError: fetch failed`
 * and hides the reason on `.cause`, which made a swap-thrashing worker look
 * exactly like a DNS outage in the logs. Unwrap it.
 */
function describeFetchError(err: unknown, timeoutMs: number): string {
  if ((err as Error)?.name === 'TimeoutError') return `timed out after ${timeoutMs}ms`;
  const message = (err as Error)?.message ?? String(err);
  const cause = (err as { cause?: { message?: string; code?: string } })?.cause;
  if (!cause) return message;
  return `${message} (${cause.code ?? 'no code'}: ${cause.message ?? String(cause)})`;
}

async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${proxyBaseUrl()}${path}`;
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${workerSecret()}`);
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const timeoutMs = workerTimeoutMs();
  try {
    return await fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`FOMO worker ${path} failed: ${describeFetchError(err, timeoutMs)}`);
  }
}

export class FomoProxyClient {
  private refreshToken: string;
  private initialized = false;
  onRefreshTokenRotated?: (newRefreshToken: string) => Promise<void> | void;

  constructor(creds: FomoCredentials) {
    if (!creds.refreshToken) throw new Error('FomoProxyClient requires refreshToken.');
    this.refreshToken = creds.refreshToken;
  }

  setRefreshToken(token: string): void {
    if (!token || token === this.refreshToken) return;
    this.refreshToken = token;
    this.initialized = false;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const res = await workerFetch('/v1/session/sync', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: this.refreshToken }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`FOMO worker session sync failed (${res.status}): ${body.slice(0, 500)}`);
    }

    this.initialized = true;
    debug('Worker session synced.');
  }

  async close(): Promise<void> {
    this.initialized = false;
  }

  async call<T = any>(
    apiPath: string,
    opts: { method?: string; body?: string | null } = {},
  ): Promise<FomoCallResult<T>> {
    if (!this.initialized) await this.init();

    let res: Response;
    try {
      res = await workerFetch('/v1/call', {
        method: 'POST',
        body: JSON.stringify({
          path: apiPath,
          method: opts.method ?? 'GET',
          body: opts.body ?? null,
        }),
      });
    } catch (err) {
      // Worker unreachable/timed out — never got an upstream status at all.
      recordFomoUpstreamError('worker-transport', null, (err as Error)?.message ?? String(err));
      throw err;
    }

    if (!res.ok) {
      const text = await res.text();
      recordFomoUpstreamError(apiPath, res.status, `worker call failed: ${text.slice(0, 200)}`, text);
      throw new Error(`FOMO worker call failed (${res.status}): ${text.slice(0, 500)}`);
    }

    const result = (await res.json()) as FomoCallResult<T>;
    if (result.status >= 200 && result.status < 300) {
      recordFomoUpstreamSuccess();
    } else {
      recordFomoUpstreamError(
        apiPath,
        result.status || null,
        result.errorMessage ?? result.text?.slice?.(0, 200) ?? `HTTP ${result.status}`,
        result.text,
      );
    }
    return result;
  }

  getTopHolders(tokenAddress: string, networkId: number) {
    const holdersQuery = encodeURIComponent(JSON.stringify([{ address: tokenAddress, networkId }]));
    return this.call(`/hodlers/top?tokens=${holdersQuery}`);
  }

  searchUsers(searchTerm: string) {
    return this.call(`/v2/users/fuzzy-search?searchTerm=${encodeURIComponent(searchTerm)}`);
  }

  getUserByHandle(userHandle: string) {
    return this.call(`/v2/users/userHandle/${encodeURIComponent(userHandle)}`);
  }

  getUserBalances(userId: string) {
    return this.call(`/v2/users/${userId}/balances`);
  }

  getLeaderboard(limit = 50, window?: '24h') {
    return this.call(window ? `/v2/leaderboard/${window}?limit=${limit}` : `/v2/leaderboard?limit=${limit}`);
  }

  getTradingActivity(limit = 50) {
    return this.call(`/feed/tradingActivity?limit=${limit}`);
  }

  getUserActivity(userId: string, limit = 20) {
    return this.call(`/v2/users/${encodeURIComponent(userId)}/activity?limit=${limit}`);
  }

  getTokenAllowList() {
    return this.call('/tokenAllowList/detailed');
  }
}

export async function fetchWorkerHealth(): Promise<Record<string, unknown> | null> {
  if (!process.env.FOMO_PROXY_URL?.trim()) return null;
  try {
    const res = await fetch(`${proxyBaseUrl()}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function isFomoProxyMode(): boolean {
  return !!process.env.FOMO_PROXY_URL?.trim();
}
