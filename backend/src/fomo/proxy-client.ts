// HTTP proxy to the always-on FOMO worker (VPS). Used when FOMO_PROXY_URL is set
// so Railway never launches Playwright locally.

import type { FomoCallResult, FomoCredentials } from './types.js';

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

async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${proxyBaseUrl()}${path}`;
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${workerSecret()}`);
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(url, { ...init, headers });
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

    const res = await workerFetch('/v1/call', {
      method: 'POST',
      body: JSON.stringify({
        path: apiPath,
        method: opts.method ?? 'GET',
        body: opts.body ?? null,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`FOMO worker call failed (${res.status}): ${text.slice(0, 500)}`);
    }

    return (await res.json()) as FomoCallResult<T>;
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
