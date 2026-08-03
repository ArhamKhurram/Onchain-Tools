// Simple TTL cache for expensive FOMO upstream calls.

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

export interface FomoCacheStats {
  size: number;
  hits: number;
  misses: number;
}

/** Hit/miss counters since process start, for /api/fomo/status. */
export function getFomoCacheStats(): FomoCacheStats {
  return { size: store.size, hits, misses };
}

/** Test hook — counters and entries otherwise leak between specs. */
export function resetFomoCache(): void {
  store.clear();
  hits = 0;
  misses = 0;
}

export function setCached<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function leaderboardCacheKey(window: string | undefined, limit: number): string {
  return `leaderboard:${window ?? 'all'}:${limit}`;
}

export function hodlersCacheKey(tokens: Array<{ address: string; networkId: number }>): string {
  const normalized = [...tokens]
    .map((t) => `${t.networkId}:${t.address.toLowerCase()}`)
    .sort()
    .join('|');
  return `hodlers:${normalized}`;
}

export const LEADERBOARD_TTL_MS = Number.parseInt(process.env.FOMO_LEADERBOARD_CACHE_MS ?? '', 10) || 5 * 60 * 1000;
export const HODLERS_TTL_MS = Number.parseInt(process.env.FOMO_HODLERS_CACHE_MS ?? '', 10) || 15 * 60 * 1000;
