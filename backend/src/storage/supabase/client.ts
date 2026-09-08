import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { HotCache, type HotCacheStats } from '../hotCache.js';

export function createServiceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required in hosted mode.');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export function throwIfError(result: { error: any }, context: string): void {
  if (result.error) {
    console.error(`[Supabase] ${context}:`, result.error);
    throw new Error(`${context}: ${result.error.message ?? 'Unknown error'}`);
  }
}

/**
 * Shared Supabase client + the hot-path cache. A single instance is created by
 * the SupabaseStorageProvider façade and injected into every repo so the client
 * and cache stay shared.
 *
 * The cache is a `HotCache` (see ../hotCache.ts). It replaced a plain TTL Map
 * after the 2026-09-06 connection-pool exhaustion: the Map had no single-flight
 * and no bound, so an ingest burst on a cold key launched one full multi-query
 * load per message. Repos should prefer `cached(key, loader)` over the raw
 * get/set pair — only the get/set pair leaves the stampede window open.
 */
export class SupabaseContext {
  readonly supabase: SupabaseClient;
  private cache = new HotCache();

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  getCached<T>(key: string): T | undefined {
    return this.cache.get<T>(key);
  }

  setCache<T>(key: string, data: T): void {
    this.cache.set(key, data);
  }

  /** Cached read with stampede protection. Key must be user-scoped. */
  cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    return this.cache.getOrLoad(key, load);
  }

  invalidateUser(userId: string): void {
    // Keys are `${userId}:<what>`; the colon keeps one user id from matching
    // another that merely shares a prefix.
    this.cache.invalidatePrefix(`${userId}:`);
  }

  /** Exposed for the deep-health endpoint and tests. */
  cacheStats(): HotCacheStats {
    return this.cache.stats();
  }
}

/**
 * Base class for repos — holds the shared client and forwards the cache helpers
 * to the shared SupabaseContext.
 */
export class BaseRepo {
  protected supabase: SupabaseClient;

  constructor(protected ctx: SupabaseContext) {
    this.supabase = ctx.supabase;
  }

  protected getCached<T>(key: string): T | undefined {
    return this.ctx.getCached<T>(key);
  }

  protected setCache<T>(key: string, data: T): void {
    this.ctx.setCache(key, data);
  }

  /**
   * Cached read whose concurrent misses collapse into one load. Every
   * per-message read must go through this rather than getCached/setCache.
   */
  protected cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    return this.ctx.cached(key, load);
  }

  protected invalidateUser(userId: string): void {
    this.ctx.invalidateUser(userId);
  }
}
