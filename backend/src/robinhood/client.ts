// HTTP access to robinhoodtrenches.com's public API.
//
// Free, keyless, no auth, no VPS. Everything here is read-only and every call
// is bounded: a timeout, a TTL cache, and a failure path that records health
// and returns rather than throwing into a poller tick or an Express handler.
//
// Scope limit lives in normalize.ts — Robinhood Chain (4663) only.

import { ROBINHOOD_SOURCE_URL } from './normalize.js';

const BASE_URL = process.env.OCT_ROBINHOOD_API_URL?.trim() || ROBINHOOD_SOURCE_URL;

const TIMEOUT_MS = Number.parseInt(process.env.OCT_ROBINHOOD_TIMEOUT_MS ?? '', 10) || 8_000;

/** Cache TTLs, in ms. The tape moves fastest; aggregates barely move at all. */
export const ROBINHOOD_TTL = {
  status: 15_000,
  tape: 10_000,
  radar: 60_000,
  traders: 120_000,
  trader: 60_000,
  overview: 120_000,
  flow: 120_000,
} as const;

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

const cache = new Map<string, CacheEntry>();

/** Test hook — module-level cache otherwise leaks between specs. */
export function resetRobinhoodCache(): void {
  cache.clear();
  health.lastSuccessAt = null;
  health.lastError = null;
  health.lastErrorAt = null;
  health.successCount = 0;
  health.errorCount = 0;
}

export interface RobinhoodHealth {
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  successCount: number;
  errorCount: number;
  /** True once anything has ever succeeded; the console uses it to distinguish "down" from "cold". */
  reachable: boolean;
}

const health = {
  lastSuccessAt: null as string | null,
  lastError: null as string | null,
  lastErrorAt: null as string | null,
  successCount: 0,
  errorCount: 0,
};

export function getRobinhoodHealth(): RobinhoodHealth {
  return { ...health, reachable: health.lastSuccessAt != null };
}

/**
 * One GET against the upstream, returning parsed JSON.
 *
 * Throws on timeout, transport failure, non-2xx or unparseable body — callers
 * catch and degrade. Never retries: a poller tick that misses simply tries
 * again on the next interval, and a REST handler surfaces "source unavailable".
 */
export async function robinhoodGet(path: string): Promise<unknown> {
  const url = `${BASE_URL}${path}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`robinhoodtrenches ${path} → HTTP ${res.status}`);
    const json: unknown = await res.json();
    health.lastSuccessAt = new Date().toISOString();
    health.successCount += 1;
    return json;
  } catch (err) {
    health.lastError = ((err as Error)?.message ?? String(err)).slice(0, 300);
    health.lastErrorAt = new Date().toISOString();
    health.errorCount += 1;
    throw err;
  }
}

/**
 * Cached GET. `ttlMs` of 0 bypasses the cache. On upstream failure a *stale*
 * cached value is preferred over an error — a third-party source blipping
 * should show slightly old data, not an empty panel.
 */
export async function robinhoodGetCached<T>(
  path: string,
  ttlMs: number,
  parse: (raw: unknown) => T,
): Promise<{ value: T; fetchedAt: number; stale: boolean }> {
  const entry = cache.get(path);
  const now = Date.now();
  if (entry && ttlMs > 0 && now < entry.expiresAt) {
    return { value: parse(entry.value), fetchedAt: entry.expiresAt - ttlMs, stale: false };
  }

  try {
    const json = await robinhoodGet(path);
    if (ttlMs > 0) cache.set(path, { value: json, expiresAt: now + ttlMs });
    return { value: parse(json), fetchedAt: now, stale: false };
  } catch (err) {
    if (entry) {
      return { value: parse(entry.value), fetchedAt: entry.expiresAt - ttlMs, stale: true };
    }
    throw err;
  }
}
