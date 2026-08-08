// TTL cache for pump.fun upstream reads. Mirrors fomo/cache.ts exactly in shape
// (getCached/setCached + stats + reset) so the two read layers behave the same.
//
// Poll-and-diff (detecting new callouts and pushing them) is a later concern for
// the future Pump.fun tab; this module only shortens the read path so the console
// does not hammer coin-communities.xyz on every panel open.

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const store = new Map<string, CacheEntry<unknown>>();

let hits = 0;
let misses = 0;

export function getCached<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) {
    misses += 1;
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    misses += 1;
    return null;
  }
  hits += 1;
  return entry.value as T;
}

export function setCached<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export interface PumpfunCacheStats {
  size: number;
  hits: number;
  misses: number;
}

/** Hit/miss counters since process start, for a future /pumpfun/status. */
export function getPumpfunCacheStats(): PumpfunCacheStats {
  return { size: store.size, hits, misses };
}

/** Test hook — counters and entries otherwise leak between specs. */
export function resetPumpfunCache(): void {
  store.clear();
  hits = 0;
  misses = 0;
}

// --- Key builders. A caller and its cache line must agree on the exact string,
// so the key shape lives here next to the store rather than inline at the route. ---

export function tokenCalloutsCacheKey(mint: string): string {
  return `token-callouts:${mint}`;
}

export function walletCalloutsCacheKey(address: string): string {
  return `wallet-callouts:${address}`;
}

export function walletProfileCacheKey(address: string): string {
  return `wallet-profile:${address}`;
}

export function communityCacheKey(mint: string): string {
  return `community:${mint}`;
}

export const TOP_COMMUNITIES_CACHE_KEY = 'communities:top';
export const TRENDING_FEED_CACHE_KEY = 'feed:trending';

// TTLs. Callouts move fast (new calls, live multipliers) so they are short-lived;
// the top board and trending slice turn over slowly and can sit longer. All
// overridable by env for tuning without a redeploy.
export const TOKEN_CALLOUTS_TTL_MS = Number.parseInt(process.env.PUMPFUN_TOKEN_CALLOUTS_CACHE_MS ?? '', 10) || 60 * 1000;
export const WALLET_CALLOUTS_TTL_MS = Number.parseInt(process.env.PUMPFUN_WALLET_CALLOUTS_CACHE_MS ?? '', 10) || 120 * 1000;
export const WALLET_PROFILE_TTL_MS = Number.parseInt(process.env.PUMPFUN_WALLET_PROFILE_CACHE_MS ?? '', 10) || 5 * 60 * 1000;
export const COMMUNITY_TTL_MS = Number.parseInt(process.env.PUMPFUN_COMMUNITY_CACHE_MS ?? '', 10) || 5 * 60 * 1000;
export const TOP_COMMUNITIES_TTL_MS = Number.parseInt(process.env.PUMPFUN_TOP_CACHE_MS ?? '', 10) || 5 * 60 * 1000;
export const TRENDING_FEED_TTL_MS = Number.parseInt(process.env.PUMPFUN_TRENDING_CACHE_MS ?? '', 10) || 5 * 60 * 1000;
