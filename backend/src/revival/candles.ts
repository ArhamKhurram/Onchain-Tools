/**
 * GeckoTerminal candle source for the revival detector.
 *
 * Multi-chain: every call takes a GeckoTerminal network id (see
 * REVIVAL_NETWORKS in @oct/shared). Solana, BNB Chain and Robinhood Chain are
 * all indexed keylessly under the same endpoint shape, so a second chain is a
 * path parameter, not a second integration.
 *
 * Keyless public API — GeckoTerminal's free tier allows roughly 30 calls per
 * minute PER CLIENT (per IP), counted across every endpoint and every network.
 * So be a polite client:
 * - EVERY request goes through one global serial queue with a minimum spacing
 *   (see `schedule` below). This module — not its callers — owns the rate
 *   budget: the poller and the outcome tracker each used to pace themselves,
 *   which meant their requests interleaved and the true rate was the SUM of
 *   two "safe" rates. That overrun is what put prod into a near-permanent 429
 *   backoff (85 req/min against a 30 req/min ceiling);
 * - token → top-pool resolution is cached (1h TTL), keyed by NETWORK + address
 *   so two chains can never collide on a same-looking address;
 * - hour candles are cached (20m TTL) — they change at most once an hour, and
 *   refetching them every 2.5-minute cycle was pure waste;
 * - tokens GeckoTerminal doesn't index are negative-cached (30m) so an
 *   unlisted contract isn't re-requested every cycle;
 * - a GLOBAL exponential backoff engages on 429 (all revival fetches pause,
 *   every chain) — see the note on noteRateLimited below.
 *
 * Endpoints:
 *   GET /networks/{network}/tokens/{address}/pools?page=1
 *   GET /networks/{network}/pools/{pool}/ohlcv/{minute|hour}?aggregate=1&limit=N&currency=usd
 */

import type { RevivalNetwork } from '@oct/shared';
import type { Candle } from './detector.js';

const BASE_URL = 'https://api.geckoterminal.com/api/v2';
const POOL_CACHE_TTL_MS = 3_600_000; // 1h
const POOL_MISS_TTL_MS = 30 * 60_000; // 30m — don't re-ask for unindexed tokens
const HOUR_CACHE_TTL_MS = 20 * 60_000; // 20m — hourly buckets barely move
const FETCH_TIMEOUT_MS = 15_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;

/**
 * Documented ceiling for GeckoTerminal's keyless tier (~30 calls/min). Not
 * enforced by us directly — it is the number REQUEST_SPACING is derived from,
 * and the number the pacing test asserts against.
 */
export const GECKOTERMINAL_RATE_LIMIT_PER_MIN = 30;

/**
 * Minimum gap between two GeckoTerminal requests: 2200ms ≈ 27 req/min, just
 * under the ceiling. (The sibling revival intake spike uses the same number.)
 */
export const DEFAULT_REQUEST_SPACING_MS = 2200;
/** Floor for the env override — 1s ≈ 60 req/min is already over the ceiling. */
const MIN_REQUEST_SPACING_MS = 1000;

function envFlag(name: string): string | undefined {
  return process.env[`OCT_${name}`] ?? process.env[`TRENCHCORD_${name}`];
}

/**
 * Spacing between requests, tunable without a deploy via
 * `OCT_REVIVAL_REQUEST_SPACING_MS` (`TRENCHCORD_` fallback). Values below the
 * floor are ignored rather than obeyed — this knob exists to slow us DOWN.
 */
export function resolveRequestSpacingMs(): number {
  if (spacingOverrideMs != null) return spacingOverrideMs;
  const parsed = Number.parseInt(envFlag('REVIVAL_REQUEST_SPACING_MS') ?? '', 10);
  return Number.isFinite(parsed) && parsed >= MIN_REQUEST_SPACING_MS
    ? parsed
    : DEFAULT_REQUEST_SPACING_MS;
}

/**
 * Test seam only: bypass the queue's spacing so a unit test asserting request
 * SHAPE doesn't sit through real 2.2s gaps. Never set in production code — the
 * env knob is the supported way to change spacing.
 */
let spacingOverrideMs: number | null = null;
export function _setRequestSpacingForTest(ms: number | null): void {
  spacingOverrideMs = ms;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- The one global request queue -----------------------------------------
// Serial by construction: each scheduled call chains onto the previous one and
// waits out the remaining spacing before firing. Every revival consumer shares
// this budget, so adding a caller can never multiply the request rate.
let queueTail: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;
/** Request timestamps in the trailing minute — for the 429 diagnostic only. */
const recentRequests: number[] = [];

function noteRequestSent(now: number): void {
  recentRequests.push(now);
  while (recentRequests.length > 0 && recentRequests[0] < now - 60_000) {
    recentRequests.shift();
  }
}

export function requestsInLastMinute(now: number = Date.now()): number {
  while (recentRequests.length > 0 && recentRequests[0] < now - 60_000) {
    recentRequests.shift();
  }
  return recentRequests.length;
}

function schedule<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueTail.then(async () => {
    const wait = lastRequestAt + resolveRequestSpacingMs() - Date.now();
    if (wait > 0) await sleep(wait);
    const now = Date.now();
    lastRequestAt = now;
    noteRequestSent(now);
    return fn();
  });
  // The tail must never reject, or one failure would poison the whole queue.
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

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

/** Cache key — the network is part of it, so chains can never share an entry. */
function cacheKey(network: RevivalNetwork, address: string): string {
  return `${network}:${address}`;
}

const poolCache = new Map<string, ResolvedPool>();
/** network:address → epoch ms of a resolution that found no pools. */
const poolMisses = new Map<string, number>();

// Global 429 backoff shared by every revival fetch, on every chain.
//
// Judgment call: GeckoTerminal's keyless rate limit is per-CLIENT (per IP,
// ~30 req/min across the whole API), not per network — a 429 earned on Solana
// means the next Robinhood request is equally unwelcome. A per-network backoff
// would therefore keep hammering an API that just told us to stop, which is
// exactly what the "politeness beats coverage" rule forbids. Coverage is
// preserved instead by the poller's per-network rotation: whatever a backed-off
// cycle skipped is picked up on the next one.
let backoffUntil = 0;
let backoffMs = BACKOFF_BASE_MS;

export function isBackedOff(now: number = Date.now()): boolean {
  return now < backoffUntil;
}

function noteRateLimited(network: RevivalNetwork): void {
  backoffUntil = Date.now() + backoffMs;
  // Diagnosable from logs: which chain asked, and what rate we were actually
  // running at. A count well under the ceiling means someone ELSE on this IP
  // is spending the budget, not our pacing.
  console.warn(
    `[Revival] GeckoTerminal rate limit on ${network} — ${requestsInLastMinute()} req in the last 60s ` +
      `(ceiling ~${GECKOTERMINAL_RATE_LIMIT_PER_MIN}/min, spacing ${resolveRequestSpacingMs()}ms). ` +
      `Pausing all revival fetches for ${Math.round(backoffMs / 1000)}s.`,
  );
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
}

function noteSuccess(): void {
  backoffMs = BACKOFF_BASE_MS;
}

/**
 * One paced GeckoTerminal GET. The backoff is re-checked INSIDE the queue slot
 * as well as before enqueuing: a request queued before a 429 landed must not
 * fire afterwards.
 */
async function gtFetch(network: RevivalNetwork, path: string): Promise<any | null> {
  if (isBackedOff()) return null;
  return schedule(async () => {
    if (isBackedOff()) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (res.status === 429) {
        noteRateLimited(network);
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
  });
}

function parseNum(v: unknown): number | null {
  const n = typeof v === 'string' ? Number.parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Top pool by 24h volume for a token ON `network`. Cached 1h; null when
 * unresolvable. A "no pools" answer is remembered for 30m so tokens
 * GeckoTerminal doesn't index (or an address mapped to the wrong chain) cost
 * one request per half hour rather than one per poll cycle.
 */
export async function resolveTopPool(
  network: RevivalNetwork,
  address: string,
): Promise<ResolvedPool | null> {
  const key = cacheKey(network, address);
  const cached = poolCache.get(key);
  if (cached && Date.now() - cached.resolvedAt < POOL_CACHE_TTL_MS) return cached;

  const missedAt = poolMisses.get(key);
  if (missedAt != null && Date.now() - missedAt < POOL_MISS_TTL_MS) return cached ?? null;

  const json = await gtFetch(network, `/networks/${network}/tokens/${address}/pools?page=1`);
  const pools: any[] = Array.isArray(json?.data) ? json.data : [];
  if (pools.length === 0) {
    // Only a real (non-backed-off, non-error) answer counts as a miss.
    if (json != null) poolMisses.set(key, Date.now());
    return cached ?? null;
  }
  poolMisses.delete(key);

  let best: any = null;
  let bestVol = -1;
  for (const p of pools) {
    const vol = parseNum(p?.attributes?.volume_usd?.h24) ?? 0;
    if (vol > bestVol) {
      bestVol = vol;
      best = p;
    }
  }
  const poolAddress: string | undefined = best?.attributes?.address;
  if (!poolAddress) return cached ?? null;

  const name: string | undefined = best?.attributes?.name;
  const symbol = typeof name === 'string' && name.includes('/')
    ? name.split('/')[0].trim() || null
    : null;

  const price = parseNum(best?.attributes?.base_token_price_usd);
  const fdv = parseNum(best?.attributes?.fdv_usd) ?? parseNum(best?.attributes?.market_cap_usd);
  const impliedSupply = price && price > 0 && fdv ? fdv / price : null;

  const resolved: ResolvedPool = {
    poolAddress,
    symbol,
    impliedSupply,
    resolvedAt: Date.now(),
  };
  poolCache.set(key, resolved);
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

/** network:pool:timeframe:limit → cached hour candles. */
const hourCache = new Map<string, { candles: Candle[]; fetchedAt: number }>();

/**
 * OHLCV for one pool. Hour candles are served from a 20-minute cache: the
 * dormancy gate reads 6h/72h volume windows, so a bucket that is at most 20
 * minutes stale changes nothing about the verdict, and skipping that refetch
 * roughly halves steady-state request volume. Minute candles — the ones the
 * ATR/RVOL gates actually key off — are always fetched fresh.
 */
export async function fetchOhlcv(
  network: RevivalNetwork,
  poolAddress: string,
  timeframe: 'minute' | 'hour',
  limit: number,
): Promise<Candle[]> {
  const key = `${network}:${poolAddress}:${timeframe}:${limit}`;
  if (timeframe === 'hour') {
    const cached = hourCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < HOUR_CACHE_TTL_MS) return cached.candles;
  }

  const json = await gtFetch(
    network,
    `/networks/${network}/pools/${poolAddress}/ohlcv/${timeframe}?aggregate=1&limit=${limit}&currency=usd`,
  );
  if (!json) {
    // Backed off / failed: a stale hour set still beats no dormancy history.
    if (timeframe === 'hour') return hourCache.get(key)?.candles ?? [];
    return [];
  }
  const candles = parseOhlcv(json);
  if (timeframe === 'hour' && candles.length > 0) {
    hourCache.set(key, { candles, fetchedAt: Date.now() });
  }
  return candles;
}

export interface RevivalCandleSet {
  pool: ResolvedPool;
  /** ~16h of 1m candles (ATR / RVOL / warmup). */
  minute: Candle[];
  /** ~4 days of 1h candles (relative-dormancy lookback). */
  hour: Candle[];
}

/**
 * Everything the detector needs for one token on one chain: minute candles
 * (1000 ≈ 16.6h) for ATR/RVOL, hour candles (100 ≈ 4d) for the 72h dormancy
 * lookback. Null when the pool can't be resolved or we're rate-limit backed off.
 */
export async function fetchRevivalCandles(
  network: RevivalNetwork,
  address: string,
): Promise<RevivalCandleSet | null> {
  const pool = await resolveTopPool(network, address);
  if (!pool) return null;
  const minute = await fetchOhlcv(network, pool.poolAddress, 'minute', 1000);
  if (minute.length === 0) return null;
  const hour = await fetchOhlcv(network, pool.poolAddress, 'hour', 100);
  return { pool, minute, hour };
}

/** Test seam. */
export function _clearPoolCacheForTest(): void {
  poolCache.clear();
  poolMisses.clear();
  hourCache.clear();
  backoffUntil = 0;
  backoffMs = BACKOFF_BASE_MS;
  lastRequestAt = 0;
  recentRequests.length = 0;
  queueTail = Promise.resolve();
  spacingOverrideMs = null;
}
