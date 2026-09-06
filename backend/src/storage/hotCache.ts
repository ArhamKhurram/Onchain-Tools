/**
 * Bounded, single-flight TTL cache for the hot ingest path.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-09-06 (02:24-02:25 UTC) Railway logs showed a continuous flood of:
 *
 *   [App:telegram-message] handler failed, dropping this event:
 *     Error: Failed to fetch highlighted users: Timed out acquiring connection
 *     from connection pool.
 *   [App] Failed to persist Telegram contract: Failed to log contract: Timed
 *     out acquiring connection from connection pool.
 *
 * `guardAsyncHandler` kept the process alive, so the visible symptom was mild.
 * The actual damage was not: every one of those lines is an inbound Telegram
 * event **dropped**. Calls crossed the feed and were never logged. Prod is on
 * the Supabase Free plan, so the pool is small and permanently small — this is
 * not a problem a bigger pool fixes.
 *
 * The cause was a stampede, not a missing cache. `SupabaseContext` already had
 * a 10s TTL cache in front of `getConfig` / `getRoomsBundle`. But a plain TTL
 * cache is only populated *after* its loader returns, so it gives zero
 * protection against a burst: when 50 messages arrive in the same tick on a
 * cold key, all 50 miss, all 50 launch the loader, and each loader is ~8
 * PostgREST round-trips (user_configs + discord_tokens + rooms + room_channels
 * + highlighted_users + keywords + two telegram reads). One busy minute
 * becomes hundreds of concurrent connections. Worse, the TTL expiring
 * re-synchronised the herd every 10 seconds.
 *
 * THE APPROACH, AND WHAT IT COSTS
 * -------------------------------
 * Three properties, in the order they matter here:
 *
 *  1. **Single-flight.** Concurrent misses on one key share one in-flight
 *     promise. This is the fix for the incident: it converts a burst of N
 *     messages from N loads into exactly 1, regardless of how short the TTL
 *     is. The cost is that a slow load now stalls every waiter behind it
 *     rather than each waiter racing its own copy — which is the trade we
 *     want, since the racing copies were what exhausted the pool.
 *
 *  2. **TTL**, tunable via `OCT_STORAGE_CACHE_MS` (`TRENCHCORD_STORAGE_CACHE_MS`
 *     honoured for the pre-rename branding). Default 30s, up from the previous
 *     hardcoded 10s. Rationale: every console-side edit already invalidates
 *     explicitly (see `invalidatePrefix` callers), so the TTL only bounds
 *     staleness for edits that bypass the API — a second device, a direct
 *     Supabase write, a migration. 30s keeps that acceptable while tripling
 *     the reduction; longer starts to feel broken to an operator poking rows
 *     by hand.
 *
 *  3. **Bounded.** The previous Map had no eviction, so in hosted mode it grew
 *     with the user count for the life of the process. Entries are capped and
 *     evicted oldest-first (insertion order, which for a TTL cache of this
 *     shape is close enough to LRU and far cheaper).
 *
 * INVALIDATION AND IN-FLIGHT LOADS
 * --------------------------------
 * A write that lands *while* a load is in flight would otherwise be undone:
 * the loader resolves with pre-write data and caches it, and the console shows
 * "I added a keyword and nothing happened" for a full TTL. A monotonic
 * generation counter guards this — a load records the generation it started
 * at, and any invalidation bumps the counter, which makes the in-flight result
 * ineligible for caching. It is still returned to its waiters (they asked
 * before the write; a slightly stale read is correct for them), it just is not
 * stored. This is deliberately conservative: *any* invalidation, for any user,
 * poisons *every* concurrent load. Invalidations are rare (operator edits);
 * loads are hot. Trading a few redundant loads for never serving a stale write
 * is the right side of that.
 *
 * Keys are caller-supplied and MUST be user-scoped (`${userId}:rooms`). This
 * cache sits behind RLS-scoped reads in a multi-tenant deployment; an unscoped
 * key here is a tenant data leak, not a performance bug.
 */

const DEFAULT_MAX_ENTRIES = 500;

/** 30s. See the header for why this moved up from the previous hardcoded 10s. */
export const DEFAULT_STORAGE_CACHE_MS = 30_000;

/** Dual branding per the repo convention: OCT_* with a TRENCHCORD_* fallback. */
export function resolveStorageCacheMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OCT_STORAGE_CACHE_MS ?? env.TRENCHCORD_STORAGE_CACHE_MS;
  const parsed = Number.parseInt(raw ?? '', 10);
  // A 0 or negative value disables caching outright, which is a legitimate
  // debugging setting — only a non-numeric value falls back to the default.
  return Number.isFinite(parsed) ? parsed : DEFAULT_STORAGE_CACHE_MS;
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export interface HotCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
}

export interface HotCacheStats {
  size: number;
  inFlight: number;
  hits: number;
  misses: number;
  /** Misses that joined an existing in-flight load instead of starting one. */
  coalesced: number;
  evictions: number;
}

export class HotCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private generation = 0;

  private hits = 0;
  private misses = 0;
  private coalesced = 0;
  private evictions = 0;

  readonly ttlMs: number;
  readonly maxEntries: number;

  constructor(options: HotCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? resolveStorageCacheMs();
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return entry.data as T;
  }

  set<T>(key: string, data: T): void {
    if (this.ttlMs <= 0) return;
    // Refresh insertion order so a re-set key is not the next eviction victim.
    this.entries.delete(key);
    this.entries.set(key, { data, expiresAt: Date.now() + this.ttlMs });
    this.evictOverflow();
  }

  /**
   * Cached read with stampede protection. Concurrent callers for one key share
   * a single `load()` — this is the property that keeps an ingest burst from
   * opening one Supabase connection per message.
   */
  async getOrLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;

    const pending = this.inFlight.get(key);
    if (pending) {
      this.coalesced += 1;
      return pending as Promise<T>;
    }

    const startedAt = this.generation;
    const promise = load()
      .then((value) => {
        // Only cache if nothing invalidated while we were loading; see header.
        if (this.generation === startedAt) this.set(key, value);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  delete(key: string): void {
    this.generation += 1;
    this.entries.delete(key);
  }

  /**
   * Drop every entry whose key starts with `prefix`. Callers pass a user id, so
   * one user's write never disturbs another tenant's cached reads.
   */
  invalidatePrefix(prefix: string): void {
    this.generation += 1;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  clear(): void {
    this.generation += 1;
    this.entries.clear();
  }

  stats(): HotCacheStats {
    return {
      size: this.entries.size,
      inFlight: this.inFlight.size,
      hits: this.hits,
      misses: this.misses,
      coalesced: this.coalesced,
      evictions: this.evictions,
    };
  }

  private evictOverflow(): void {
    if (this.entries.size <= this.maxEntries) return;
    // Sweep dead entries first — under a steady multi-tenant load most overflow
    // is expired rather than live, and dropping those costs nobody a round-trip.
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now > entry.expiresAt) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
  }
}
