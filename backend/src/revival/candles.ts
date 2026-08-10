/**
 * GeckoTerminal candle source for the revival detector.
 *
 * Keyless public API — so be a polite client:
 * - token → top-pool resolution is cached (1h TTL);
 * - a global exponential backoff engages on 429 (all revival fetches pause);
 * - the poller staggers per-token requests and hard-caps the universe.
 *
 * Endpoints:
 *   GET /networks/solana/tokens/{mint}/pools?page=1
 *   GET /networks/solana/pools/{pool}/ohlcv/{minute|hour}?aggregate=1&limit=N&currency=usd
 */

import type { Candle } from './detector.js';

const BASE_URL = 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'solana';
const POOL_CACHE_TTL_MS = 3_600_000; // 1h
const FETCH_TIMEOUT_MS = 15_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;

export interface ResolvedPool {
  poolAddress: string;
  /** Parsed from the pool name ("SYM / SOL"), best-effort. */
  symbol: string | null;
  /**
   * Implied circulating/total supply = (fdv or mcap USD) / price at resolution
   * time. Lets the poller estimate a current mcap from the latest close without
   * re-fetching pool metadata every cycle.
   */
  impliedSupply: number | null;
  resolvedAt: number;
}

const poolCache = new Map<string, ResolvedPool>();

// Global 429 backoff shared by every revival fetch.
let backoffUntil = 0;
let backoffMs = BACKOFF_BASE_MS;

export function isBackedOff(now: number = Date.now()): boolean {
  return now < backoffUntil;
}

function noteRateLimited(): void {
  backoffUntil = Date.now() + backoffMs;
  console.warn(`[Revival] GeckoTerminal 429 — backing off ${Math.round(backoffMs / 1000)}s.`);
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
}

function noteSuccess(): void {
  backoffMs = BACKOFF_BASE_MS;
}

async function gtFetch(path: string): Promise<any | null> {
  if (isBackedOff()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (res.status === 429) {
      noteRateLimited();
      return null;
    }
    if (!res.ok) return null;
    noteSuccess();
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseNum(v: unknown): number | null {
  const n = typeof v === 'string' ? Number.parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Top pool by 24h volume for a mint. Cached 1h; null when unresolvable. */
export async function resolveTopPool(mint: string): Promise<ResolvedPool | null> {
  const cached = poolCache.get(mint);
  if (cached && Date.now() - cached.resolvedAt < POOL_CACHE_TTL_MS) return cached;

  const json = await gtFetch(`/networks/${NETWORK}/tokens/${mint}/pools?page=1`);
  const pools: any[] = Array.isArray(json?.data) ? json.data : [];
  if (pools.length === 0) return cached ?? null;

  let best: any = null;
  let bestVol = -1;
  for (const p of pools) {
    const vol = parseNum(p?.attributes?.volume_usd?.h24) ?? 0;
    if (vol > bestVol) {
      bestVol = vol;
      best = p;
    }
  }
  const address: string | undefined = best?.attributes?.address;
  if (!address) return cached ?? null;

  const name: string | undefined = best?.attributes?.name;
  const symbol = typeof name === 'string' && name.includes('/')
    ? name.split('/')[0].trim() || null
    : null;

  const price = parseNum(best?.attributes?.base_token_price_usd);
  const fdv = parseNum(best?.attributes?.fdv_usd) ?? parseNum(best?.attributes?.market_cap_usd);
  const impliedSupply = price && price > 0 && fdv ? fdv / price : null;

  const resolved: ResolvedPool = {
    poolAddress: address,
    symbol,
    impliedSupply,
    resolvedAt: Date.now(),
  };
  poolCache.set(mint, resolved);
  return resolved;
}

function parseOhlcv(json: any): Candle[] {
  const list: any[] = json?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  const out: Candle[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [ts, open, high, low, close, volume] = row.map((v: unknown) => parseNum(v));
    if (ts == null || open == null || high == null || low == null || close == null || volume == null) continue;
    out.push({ ts: ts * 1000, open, high, low, close, volume });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

export async function fetchOhlcv(
  poolAddress: string,
  timeframe: 'minute' | 'hour',
  limit: number,
): Promise<Candle[]> {
  const json = await gtFetch(
    `/networks/${NETWORK}/pools/${poolAddress}/ohlcv/${timeframe}?aggregate=1&limit=${limit}&currency=usd`,
  );
  if (!json) return [];
  return parseOhlcv(json);
}

export interface RevivalCandleSet {
  pool: ResolvedPool;
  /** ~16h of 1m candles (ATR / RVOL / warmup). */
  minute: Candle[];
  /** ~4 days of 1h candles (relative-dormancy lookback). */
  hour: Candle[];
}

/**
 * Everything the detector needs for one token: minute candles (1000 ≈ 16.6h)
 * for ATR/RVOL, hour candles (100 ≈ 4d) for the 72h dormancy lookback.
 * Null when the pool can't be resolved or we're rate-limit backed off.
 */
export async function fetchRevivalCandles(mint: string): Promise<RevivalCandleSet | null> {
  const pool = await resolveTopPool(mint);
  if (!pool) return null;
  const minute = await fetchOhlcv(pool.poolAddress, 'minute', 1000);
  if (minute.length === 0) return null;
  const hour = await fetchOhlcv(pool.poolAddress, 'hour', 100);
  return { pool, minute, hour };
}

/** Test seam. */
export function _clearPoolCacheForTest(): void {
  poolCache.clear();
  backoffUntil = 0;
  backoffMs = BACKOFF_BASE_MS;
}
