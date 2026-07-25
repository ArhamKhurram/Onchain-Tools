import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CACHE_TTL_MS } from './mappers.js';

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

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

/**
 * Shared Supabase client + 10s TTL cache. A single instance is created by the
 * SupabaseStorageProvider façade and injected into every repo so the client and
 * cache stay shared.
 */
export class SupabaseContext {
  readonly supabase: SupabaseClient;
  private cache = new Map<string, CacheEntry<any>>();

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  getCached<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.data as T;
  }

  setCache<T>(key: string, data: T): void {
    this.cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  invalidateUser(userId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(userId)) this.cache.delete(key);
    }
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

  protected invalidateUser(userId: string): void {
    this.ctx.invalidateUser(userId);
  }
}
