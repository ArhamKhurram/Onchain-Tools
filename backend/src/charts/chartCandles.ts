/**
 * Read-only OHLCV for the console's candlestick chart.
 *
 * This is NOT a new provider. It reuses the revival subsystem's two candle sources —
 * Pinax for Solana/BNB (paid, calibrated per pool), GeckoTerminal for the rest — and
 * inherits their routing (`candleSource.ts`), their pool caches and, crucially, the
 * GeckoTerminal global serial queue. That queue is the whole ballgame: the keyless tier
 * sustains ~6-8 requests/minute across the ENTIRE backend (measured, see
 * `revival/candles.ts`), and the revival poller is already spending most of it. A chart
 * that fetched on every open, timeframe flip and refresh tick would starve the detector.
 *
 * So the service in front of the sources does two things and nothing else:
 *
 *  1. A short TTL cache keyed by (network, address, timeframe, limit). Minute candles
 *     are served for 60s — a 1m bucket cannot change more often than that — and hour
 *     candles for 5m (the sources cache those for 45m underneath anyway). Every viewer
 *     of the same token shares one entry, so N open consoles cost one request per TTL.
 *  2. In-flight coalescing: a second request for a key that is already being fetched
 *     awaits the same promise instead of queueing a second upstream call.
 *
 * Nothing here polls. The chart asks; the cache answers or the queue does. The frontend
 * refresh interval is pinned to the TTL so polling faster than this buys nothing.
 */

import type { RevivalNetwork } from '@oct/shared';
import { revivalNetworkForChain } from '@oct/shared';
import type { Candle } from '../revival/detector.js';
import { fetchOhlcv, resolveTopPool } from '../revival/candles.js';
import { fetchPinaxOhlc, resolvePinaxPool } from '../revival/pinaxCandles.js';
import { plannedSourceFor, type CandleSourceId } from '../revival/candleSource.js';

export const CHART_TIMEFRAMES = ['1m', '1h'] as const;
export type ChartTimeframe = (typeof CHART_TIMEFRAMES)[number];

/** Upper bound GeckoTerminal accepts per OHLCV call; Pinax is capped to match. */
const MAX_LIMIT = 1000;
/** 1m → 5h of history; 1h → 7d. Enough to read a chart, cheap enough to cache. */
const DEFAULT_LIMIT: Record<ChartTimeframe, number> = { '1m': 300, '1h': 168 };
const TTL_MS: Record<ChartTimeframe, number> = { '1m': 60_000, '1h': 5 * 60_000 };

/** Base58 (Solana) or 0x-hex (EVM). Guards the path param before it reaches a provider URL. */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

export function isChartAddress(raw: unknown): raw is string {
  return typeof raw === 'string' && (BASE58_RE.test(raw) || EVM_RE.test(raw));
}

/** Accepts GeckoTerminal ids and OCT chain slugs alike (`solana`/`sol`, `bsc`/`bnb`, `robinhood`/`hood`). */
export function parseChartNetwork(raw: unknown): RevivalNetwork | null {
  if (typeof raw !== 'string' || raw === '') return null;
  return revivalNetworkForChain(raw.toLowerCase());
}

export function parseChartTimeframe(raw: unknown): ChartTimeframe | null {
  return (CHART_TIMEFRAMES as readonly unknown[]).includes(raw) ? (raw as ChartTimeframe) : null;
}

/** Clamps to [1, MAX_LIMIT]; anything unparseable falls back to the timeframe default. */
export function parseChartLimit(raw: unknown, timeframe: ChartTimeframe): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n)) return DEFAULT_LIMIT[timeframe];
  return Math.min(Math.max(Math.trunc(n), 1), MAX_LIMIT);
}

export interface ChartCandleSet {
  source: CandleSourceId;
  pool: { address: string; symbol: string | null };
  candles: Candle[];
}

export type ChartCandleResult =
  | { status: 'ok'; data: ChartCandleSet }
  /** No source indexes a pool for this token on this chain. Cached upstream; not retryable soon. */
  | { status: 'no_pool' }
  /** A pool exists but no candles came back — rate-limit backoff or a provider fault. Retryable. */
  | { status: 'unavailable' };

/** The provider-facing half, injectable so the cache can be tested without a network. */
export interface ChartCandleFetcher {
  (network: RevivalNetwork, address: string, timeframe: ChartTimeframe, limit: number): Promise<ChartCandleResult>;
}

/** Mirrors `candleSource.fetchCandlesForToken` but for ONE timeframe at a caller-chosen depth. */
export const fetchFromSources: ChartCandleFetcher = async (network, address, timeframe, limit) => {
  if (plannedSourceFor(network) === 'pinax') {
    const pool = await resolvePinaxPool(network, address);
    if (pool) {
      const candles = await fetchPinaxOhlc(network, pool.poolAddress, timeframe, limit, pool.scale);
      if (candles.length > 0) {
        return {
          status: 'ok',
          data: { source: 'pinax', pool: { address: pool.poolAddress, symbol: pool.symbol }, candles },
        };
      }
      // Pinax declined or returned nothing: fall through to GeckoTerminal, same as the detector.
    }
  }
  const pool = await resolveTopPool(network, address);
  if (!pool) return { status: 'no_pool' };
  const candles = await fetchOhlcv(network, pool.poolAddress, timeframe === '1m' ? 'minute' : 'hour', limit);
  if (candles.length === 0) return { status: 'unavailable' };
  return {
    status: 'ok',
    data: { source: 'geckoterminal', pool: { address: pool.poolAddress, symbol: pool.symbol }, candles },
  };
};

export interface ChartCandleService {
  get(network: RevivalNetwork, address: string, timeframe: ChartTimeframe, limit: number): Promise<ChartCandleResult>;
  /** Test seam. */
  clear(): void;
}

export function createChartCandleService(
  fetcher: ChartCandleFetcher = fetchFromSources,
  now: () => number = Date.now,
): ChartCandleService {
  const cache = new Map<string, { at: number; result: ChartCandleResult }>();
  const inFlight = new Map<string, Promise<ChartCandleResult>>();

  return {
    async get(network, address, timeframe, limit) {
      const key = `${network}:${address}:${timeframe}:${limit}`;
      const hit = cache.get(key);
      if (hit && now() - hit.at < TTL_MS[timeframe]) return hit.result;

      const pending = inFlight.get(key);
      if (pending) return pending;

      const task = fetcher(network, address, timeframe, limit)
        .then((result) => {
          // Only a real answer is remembered. An `unavailable` (backed off, provider
          // blip) must be retried on the next ask, not served stale for a minute.
          if (result.status !== 'unavailable') cache.set(key, { at: now(), result });
          return result;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, task);
      return task;
    },
    clear() {
      cache.clear();
      inFlight.clear();
    },
  };
}

/** Process-wide instance the route uses. */
export const chartCandleService = createChartCandleService();
