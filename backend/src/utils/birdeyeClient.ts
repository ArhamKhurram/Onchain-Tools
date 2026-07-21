import { markBirdeyeRateLimited, withBirdeyeLimit } from './birdeyeLimiter.js';

const BIRDEYE_HOST = 'https://public-api.birdeye.so';

export type BirdeyeChain =
  | 'solana'
  | 'ethereum'
  | 'base'
  | 'bsc'
  | 'arbitrum'
  | 'polygon'
  | 'optimism'
  | 'avalanche'
  | 'robinhood';

type BirdeyeEnvelope<T> = {
  success: boolean;
  data?: T;
  message?: string;
};

export type BirdeyeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: number; birdeyeConfigured?: boolean };

const CACHE_TTL_MS = 120_000;
const cache = new Map<string, { expires: number; value: BirdeyeResult<unknown> }>();

function cacheKey(method: string, chain: string, path: string, body: string): string {
  return `${method}:${chain}:${path}:${body}`;
}

function readCache<T>(key: string): BirdeyeResult<T> | null {
  const hit = cache.get(key);
  if (!hit || hit.expires <= Date.now()) {
    if (hit) cache.delete(key);
    return null;
  }
  return hit.value as BirdeyeResult<T>;
}

function writeCache(key: string, value: BirdeyeResult<unknown>): void {
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
}

function missingKeyResult<T>(): BirdeyeResult<T> {
  return {
    ok: false,
    error: 'Portfolio requires BIRDEYE_API_KEY on server.',
    birdeyeConfigured: false,
  };
}

export function isBirdeyeConfigured(): boolean {
  return !!process.env.BIRDEYE_API_KEY?.trim();
}

export async function birdeyeGet<T>(
  chain: BirdeyeChain,
  path: string,
  query: Record<string, string | number | undefined> = {},
): Promise<BirdeyeResult<T>> {
  const apiKey = process.env.BIRDEYE_API_KEY?.trim();
  if (!apiKey) return missingKeyResult<T>();

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  const url = `${BIRDEYE_HOST}${path}${qs ? `?${qs}` : ''}`;
  const key = cacheKey('GET', chain, url, '');

  const hit = readCache<T>(key);
  if (hit) return hit;

  try {
    return await withBirdeyeLimit(async () => {
      const res = await fetch(url, {
        headers: {
          'X-API-KEY': apiKey,
          Accept: 'application/json',
          'x-chain': chain,
        },
        signal: AbortSignal.timeout(20_000),
      });

      let json: BirdeyeEnvelope<T> | null = null;
      try {
        json = (await res.json()) as BirdeyeEnvelope<T>;
      } catch {
        const result: BirdeyeResult<T> = {
          ok: false,
          error: `Birdeye HTTP ${res.status}`,
          code: res.status,
          birdeyeConfigured: true,
        };
        writeCache(key, result);
        return result;
      }

      if (!res.ok || !json.success) {
        const msg = json.message ?? `Birdeye HTTP ${res.status}`;
        markBirdeyeRateLimited(msg);
        const result: BirdeyeResult<T> = {
          ok: false,
          error: msg,
          code: res.status,
          birdeyeConfigured: true,
        };
        writeCache(key, result);
        return result;
      }

      const ok: BirdeyeResult<T> = { ok: true, data: json.data as T };
      writeCache(key, ok);
      return ok;
    });
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      birdeyeConfigured: true,
    };
  }
}

export async function birdeyePost<T>(
  chain: BirdeyeChain,
  path: string,
  body: Record<string, unknown>,
): Promise<BirdeyeResult<T>> {
  const apiKey = process.env.BIRDEYE_API_KEY?.trim();
  if (!apiKey) return missingKeyResult<T>();

  const url = `${BIRDEYE_HOST}${path}`;
  const bodyStr = JSON.stringify(body);
  const key = cacheKey('POST', chain, url, bodyStr);

  const hit = readCache<T>(key);
  if (hit) return hit;

  try {
    return await withBirdeyeLimit(async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-chain': chain,
        },
        body: bodyStr,
        signal: AbortSignal.timeout(25_000),
      });

      let json: BirdeyeEnvelope<T> | null = null;
      try {
        json = (await res.json()) as BirdeyeEnvelope<T>;
      } catch {
        const result: BirdeyeResult<T> = {
          ok: false,
          error: `Birdeye HTTP ${res.status}`,
          code: res.status,
          birdeyeConfigured: true,
        };
        writeCache(key, result);
        return result;
      }

      if (!res.ok || !json.success) {
        const msg = json.message ?? `Birdeye HTTP ${res.status}`;
        markBirdeyeRateLimited(msg);
        const result: BirdeyeResult<T> = {
          ok: false,
          error: msg,
          code: res.status,
          birdeyeConfigured: true,
        };
        writeCache(key, result);
        return result;
      }

      const ok: BirdeyeResult<T> = { ok: true, data: json.data as T };
      writeCache(key, ok);
      return ok;
    });
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      birdeyeConfigured: true,
    };
  }
}
