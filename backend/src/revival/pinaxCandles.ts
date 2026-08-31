/**
 * Pinax candle source for the revival detector — Solana and BNB Chain.
 *
 * WHY THIS EXISTS. GeckoTerminal's keyless tier sustains ~6-8 requests/minute (measured; see
 * `candles.ts`). All three watched chains share that budget, which caps the whole subsystem at a
 * ~60-token universe and a 25-minute sweep. Pinax is a paid API we already hold credentials for,
 * and it serves the same shapes: pool resolution, and minute + hour OHLC. Moving Solana and BNB
 * onto it leaves the ENTIRE GeckoTerminal budget for Robinhood Chain, which Pinax does not index
 * (verified 2026-08-27: /v1/networks returns arbitrum-one, avalanche, base, bsc, hyperevm,
 * mainnet, optimism, polygon, solana, unichain — no Robinhood, and Robinhood Chain is an Arbitrum
 * Orbit L3, not arbitrum-one).
 *
 * ---------------------------------------------------------------------------------------------
 * THE UNIT PROBLEM, AND WHY THIS FILE CALIBRATES INSTEAD OF CONVERTING
 *
 * Pinax OHLC prices are NOT in USD, and the scaling is not derivable from the token decimals.
 * Two pools, measured the same day:
 *
 *   Solana  USDC(d6) / WSOL(d9)    close 0.00010727   x 10^6 = 107.27   (SOL was $107.34)
 *   BSC     USDT(d18) / WBNB(d18)  close 713.51       x 10^0 = 713.51   (BNB was $712.84)
 *
 * Both land within 0.3% of the real price — but one needs x10^6 and the other x10^0, and no
 * formula over (d0, d1) yields both. A rule fitted to either sample alone is wrong on the other;
 * the first draft of this file shipped exactly such a rule before the second sample killed it.
 *
 * So this module does not derive the factor. It MEASURES it, once per pool: fetch a reference USD
 * price, divide, keep the ratio. Two guards make that safe rather than clever:
 *
 *   1. The factor must round to a power of ten within SCALE_TOLERANCE. A genuine unit mismatch is
 *      always a power of ten; anything else means the reference and the pool disagree about which
 *      asset is being priced, and a "calibration" would then silently rescale every candle.
 *   2. A pool that fails that check is REFUSED, and the caller falls back to GeckoTerminal.
 *
 * The failure mode being defended against is not a crash — it is gates evaluating against numbers
 * six orders of magnitude wrong, firing nothing, and reading exactly like a quiet market.
 * ---------------------------------------------------------------------------------------------
 */

import type { RevivalNetwork } from '@oct/shared';
import type { ResolvedPool } from './candles.js';
import type { Candle } from './detector.js';

const PINAX_BASE = 'https://api.pinax.network';
const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';
const FETCH_TIMEOUT_MS = 15_000;

/** Pinax family + network id per watched chain. `null` means Pinax does not index it. */
const PINAX_NETWORKS: Record<RevivalNetwork, { family: 'svm' | 'evm'; network: string } | null> = {
  solana: { family: 'svm', network: 'solana' },
  bsc: { family: 'evm', network: 'bsc' },
  robinhood: null,
};

/** How far a measured scale may sit from a clean power of ten before the pool is refused. */
const SCALE_TOLERANCE = 0.05;
const POOL_CACHE_TTL_MS = 3_600_000;
const HOUR_CACHE_TTL_MS = 45 * 60_000;

export function pinaxSupports(network: RevivalNetwork): boolean {
  return PINAX_NETWORKS[network] != null;
}

export interface CalibratedPool extends ResolvedPool {
  /** Multiply Pinax price and volume by this to reach USD. Always a power of ten. */
  scale: number;
}

const poolCache = new Map<string, { pool: CalibratedPool; at: number }>();
const poolRefusals = new Map<string, number>();
const hourCache = new Map<string, { candles: Candle[]; at: number }>();

function cacheKey(network: RevivalNetwork, address: string): string {
  return `${network}:${address}`;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', ...headers },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function apiKey(): string | null {
  return process.env.PINAX_API_KEY?.trim() || null;
}

async function pinax(path: string, params: Record<string, string | number>): Promise<any> {
  const key = apiKey();
  if (!key) return null;
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  // X-Api-Key, NOT `Authorization: Bearer` — the bearer form returns 401 on this API.
  return getJson(`${PINAX_BASE}${path}?${qs.toString()}`, { 'X-Api-Key': key });
}

/** Reference USD price for a token. Used ONLY to measure the scale factor, never for candles. */
async function referenceUsd(address: string): Promise<number | null> {
  const json = (await getJson(`${DEXSCREENER_BASE}/tokens/${address}`)) as any;
  const pairs: any[] = Array.isArray(json?.pairs) ? json.pairs : [];
  let best: any = null;
  for (const pair of pairs) {
    const liq = Number(pair?.liquidity?.usd ?? 0);
    if (!best || liq > Number(best?.liquidity?.usd ?? 0)) best = pair;
  }
  const price = Number(best?.priceUsd);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** Snap a measured ratio to a power of ten, or null when it is not one. */
export function snapToPowerOfTen(ratio: number, tolerance: number = SCALE_TOLERANCE): number | null {
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const snapped = 10 ** Math.round(Math.log10(ratio));
  return Math.abs(ratio - snapped) / snapped <= tolerance ? snapped : null;
}

function parsePinaxOhlc(json: any, scale: number): Candle[] {
  const rows: any[] = Array.isArray(json?.data) ? json.data : [];
  const out: Candle[] = [];
  for (const row of rows) {
    const ts = Date.parse(`${String(row?.datetime).replace(' ', 'T')}Z`);
    const open = Number(row?.open);
    const high = Number(row?.high);
    const low = Number(row?.low);
    const close = Number(row?.close);
    const volume = Number(row?.volume);
    if (!Number.isFinite(ts)) continue;
    if (![open, high, low, close, volume].every((n) => Number.isFinite(n))) continue;
    out.push({
      ts,
      open: open * scale,
      high: high * scale,
      low: low * scale,
      close: close * scale,
      // Volume shares the price's denomination, so it takes the same factor.
      volume: volume * scale,
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

export async function fetchPinaxOhlc(
  network: RevivalNetwork,
  poolAddress: string,
  interval: '1m' | '1h',
  limit: number,
  scale: number,
): Promise<Candle[]> {
  const cfg = PINAX_NETWORKS[network];
  if (!cfg) return [];
  const key = `${network}:${poolAddress}:${interval}:${limit}`;
  if (interval === '1h') {
    const hit = hourCache.get(key);
    if (hit && Date.now() - hit.at < HOUR_CACHE_TTL_MS) return hit.candles;
  }
  const params: Record<string, string | number> = {
    network: cfg.network,
    interval,
    limit,
  };
  params[cfg.family === 'svm' ? 'amm_pool' : 'pool'] = poolAddress;
  const json = await pinax(`/v1/${cfg.family}/pools/ohlc`, params);
  if (!json) {
    // A stale hour set still beats no dormancy history; minute candles must be fresh or absent.
    return interval === '1h' ? (hourCache.get(key)?.candles ?? []) : [];
  }
  const candles = parsePinaxOhlc(json, scale);
  if (interval === '1h' && candles.length > 0) hourCache.set(key, { candles, at: Date.now() });
  return candles;
}

export async function resolvePinaxPool(
  network: RevivalNetwork,
  address: string,
): Promise<CalibratedPool | null> {
  const cfg = PINAX_NETWORKS[network];
  if (!cfg) return null;

  const key = cacheKey(network, address);
  const cached = poolCache.get(key);
  if (cached && Date.now() - cached.at < POOL_CACHE_TTL_MS) return cached.pool;
  const refusedAt = poolRefusals.get(key);
  if (refusedAt != null && Date.now() - refusedAt < POOL_CACHE_TTL_MS) return null;

  const listParams: Record<string, string | number> = { network: cfg.network, limit: 20 };
  listParams[cfg.family === 'svm' ? 'mint' : 'input_token'] = address;
  const list = await pinax(`/v1/${cfg.family}/pools`, listParams);
  const pools: any[] = Array.isArray(list?.data) ? list.data : [];
  if (pools.length === 0) {
    poolRefusals.set(key, Date.now());
    return null;
  }

  // Busiest pool wins — `transactions` is the only activity proxy the listing carries.
  pools.sort((a, b) => Number(b?.transactions ?? 0) - Number(a?.transactions ?? 0));
  const chosen = pools[0];
  const poolAddress: string | undefined = chosen?.amm_pool ?? chosen?.pool;
  if (!poolAddress) {
    poolRefusals.set(key, Date.now());
    return null;
  }

  // Calibrate against one live candle. scale=1 here on purpose: this call MEASURES the factor.
  const latest = await fetchPinaxOhlc(network, poolAddress, '1m', 1, 1);
  const close = latest.at(-1)?.close;
  const reference = await referenceUsd(address);
  if (close == null || close <= 0 || reference == null) {
    poolRefusals.set(key, Date.now());
    return null;
  }

  const scale = snapToPowerOfTen(reference / close);
  if (scale == null) {
    console.warn(
      `[PinaxCandles] refusing ${network}:${address} — measured scale ` +
        `${(reference / close).toExponential(2)} is not a power of ten; using GeckoTerminal.`,
    );
    poolRefusals.set(key, Date.now());
    return null;
  }

  const pool: CalibratedPool = {
    poolAddress,
    symbol: chosen?.output_token?.symbol ?? chosen?.input_token?.symbol ?? null,
    impliedSupply: null,
    resolvedAt: Date.now(),
    scale,
  };
  poolCache.set(key, { pool, at: Date.now() });
  return pool;
}
