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

// Activity is paged and filtered, so the cache line is keyed by the exact query
// (wallet + cursor + dustFilter): a different page or filter is a different read.
export function walletTransactionsCacheKey(address: string, cursor: string | undefined, dustFilter: boolean): string {
  return `wallet-transactions:${address}:${cursor ?? ''}:${dustFilter}`;
}

export function walletBalanceCacheKey(address: string): string {
  return `wallet-balance:${address}`;
}

export const TOP_COMMUNITIES_CACHE_KEY = 'communities:top';
export const TRENDING_FEED_CACHE_KEY = 'feed:trending';

// The leaderboard is read with a PER-USER bearer, so its cache line is scoped by
// userId as well as window — one user's board must never be served to another.
// The cached VALUE is the narrowed row array only; the bearer is never part of a
// cache entry (it lives in storage, read late per fetch).
export function leaderboardCacheKey(userId: string, timeframe: string): string {
  return `leaderboard:${userId}:${timeframe}`;
}

export function rankedCallersCacheKey(userId: string): string {
  return `ranked-callers:${userId}`;
}

// TTLs. Callouts move fast (new calls, live multipliers) so they are short-lived;
// the top board and trending slice turn over slowly and can sit longer. All
// overridable by env for tuning without a redeploy.
export const TOKEN_CALLOUTS_TTL_MS = Number.parseInt(process.env.PUMPFUN_TOKEN_CALLOUTS_CACHE_MS ?? '', 10) || 60 * 1000;
export const WALLET_CALLOUTS_TTL_MS = Number.parseInt(process.env.PUMPFUN_WALLET_CALLOUTS_CACHE_MS ?? '', 10) || 120 * 1000;
export const WALLET_PROFILE_TTL_MS = Number.parseInt(process.env.PUMPFUN_WALLET_PROFILE_CACHE_MS ?? '', 10) || 5 * 60 * 1000;
export const COMMUNITY_TTL_MS = Number.parseInt(process.env.PUMPFUN_COMMUNITY_CACHE_MS ?? '', 10) || 5 * 60 * 1000;
// Activity moves as fast as callouts (fresh swaps land constantly); a balance
// summary turns over a little slower. PnL is a POST over a caller-supplied mint
// list and is served uncached (see routes.ts) — a cache line per mint permutation
// buys little and the key would be unwieldy.
export const WALLET_TRANSACTIONS_TTL_MS = Number.parseInt(process.env.PUMPFUN_WALLET_TRANSACTIONS_CACHE_MS ?? '', 10) || 60 * 1000;
export const WALLET_BALANCE_TTL_MS = Number.parseInt(process.env.PUMPFUN_WALLET_BALANCE_CACHE_MS ?? '', 10) || 120 * 1000;
export const TOP_COMMUNITIES_TTL_MS = Number.parseInt(process.env.PUMPFUN_TOP_CACHE_MS ?? '', 10) || 5 * 60 * 1000;
export const TRENDING_FEED_TTL_MS = Number.parseInt(process.env.PUMPFUN_TRENDING_CACHE_MS ?? '', 10) || 5 * 60 * 1000;
// The leaderboard turns over quickly (live PnL, new calls); ~60s matches FOMO's
// leaderboard cadence and keeps the per-user upstream call rate bounded.
export const LEADERBOARD_TTL_MS = Number.parseInt(process.env.PUMPFUN_LEADERBOARD_CACHE_MS ?? '', 10) || 60 * 1000;
