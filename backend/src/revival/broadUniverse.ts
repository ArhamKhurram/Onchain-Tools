/**
 * Broad-tier universe — the tokens nobody in the feed mentioned.
 *
 * WHY. The revival universe is built from contracts detected in users' feeds within the last 48
 * hours, capped at 30 per user. In production that is a **~60-token watchlist across three
 * chains**. It can only ever catch a revival in something a caller posted in the last two days.
 *
 * CHILL is the case that proved the gap: a Robinhood Chain token that sat for 19 days and then ran
 * to $3.96M market cap on $1.45M of 24h volume. The chain was watched. GeckoTerminal indexed it.
 * The detector's gates would very likely have fired. It was never evaluated, because it had never
 * appeared in anyone's feed — and even if it had, a 48-hour window would have dropped it 17 days
 * before the move. A feed-derived universe is structurally blind to exactly the setup the
 * detector exists to find: an old, quiet token waking up.
 *
 * WHAT THIS ADDS. A second, market-wide tier: the busiest pools on each watched chain, above a
 * liquidity floor, regardless of whether anyone mentioned them. Discovery is cheap because it is
 * ranked in bulk — one request returns 20 pools, so a few requests per sweep cover a chain, rather
 * than one request per token.
 *
 * BUDGET. Discovery is cheap; EVALUATION is not — every token in the universe eventually costs
 * candle requests, and GeckoTerminal's keyless tier sustains only ~6-8 requests/minute (measured,
 * see `candles.ts`). So this tier is:
 *
 *   * **OFF by default.** `OCT_REVIVAL_BROAD_TIER=1` enables it. It is meant to be switched on
 *     once Solana and BNB have moved to Pinax (see `candleSource.ts`) and the GeckoTerminal budget
 *     belongs to Robinhood alone.
 *   * **separately capped** (`OCT_REVIVAL_BROAD_MAX_PER_NETWORK`, default 40), so enabling it
 *     cannot silently multiply the sweep time. The existing per-cycle cap still governs how many
 *     tokens are actually evaluated; this only decides how many are *eligible*.
 *
 * The failure this guards against is the one the pacing comments in `candles.ts` were written for:
 * a universe that outgrows the request budget does not error, it just quietly stops covering
 * anything, and an under-covered poller looks exactly like a quiet market.
 */

import type { RevivalNetwork } from '@oct/shared';

const GT_BASE = 'https://api.geckoterminal.com/api/v2';
const FETCH_TIMEOUT_MS = 15_000;

/** Pool rankings move slowly; refetching them every 5-minute cycle would waste the budget. */
const CACHE_TTL_MS = 15 * 60_000;

/** Below this reserve a "revival" is unexitable — the move cannot be traded even if detected. */
const DEFAULT_MIN_LIQUIDITY_USD = 15_000;
const DEFAULT_MAX_PER_NETWORK = 40;
const POOLS_PER_PAGE = 20;

export interface BroadToken {
  address: string;
  network: RevivalNetwork;
  liquidityUsd: number;
  volume24hUsd: number;
}

function envFlag(name: string): string | undefined {
  return process.env[`OCT_${name}`] ?? process.env[`TRENCHCORD_${name}`];
}

function envInt(name: string, fallback: number): number {
  const raw = Number(envFlag(name));
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export function isBroadTierEnabled(): boolean {
  const raw = envFlag('REVIVAL_BROAD_TIER');
  return raw === '1' || raw?.toLowerCase() === 'true';
}

export function broadMaxPerNetwork(): number {
  return envInt('REVIVAL_BROAD_MAX_PER_NETWORK', DEFAULT_MAX_PER_NETWORK);
}

export function broadMinLiquidityUsd(): number {
  return envInt('REVIVAL_BROAD_MIN_LIQUIDITY_USD', DEFAULT_MIN_LIQUIDITY_USD);
}

const cache = new Map<RevivalNetwork, { tokens: BroadToken[]; at: number }>();

/**
 * Parse one GeckoTerminal pools page into candidate tokens.
 *
 * Exported for tests: this is where a schema change would silently empty the tier, so it is worth
 * pinning against a real response shape rather than only through the network path.
 */
export function parsePoolsPage(
  json: unknown,
  network: RevivalNetwork,
  minLiquidityUsd: number,
): BroadToken[] {
  const data: any[] = Array.isArray((json as any)?.data) ? (json as any).data : [];
  const out: BroadToken[] = [];
  for (const pool of data) {
    const attrs = pool?.attributes ?? {};
    const liquidityUsd = Number(attrs?.reserve_in_usd);
    const volume24hUsd = Number(attrs?.volume_usd?.h24);
    // A negative or zero reserve shows up in real data (mid-migration pools) — treat it as
    // untradeable rather than letting it through as a very small positive number.
    if (!Number.isFinite(liquidityUsd) || liquidityUsd < minLiquidityUsd) continue;
    if (!Number.isFinite(volume24hUsd) || volume24hUsd <= 0) continue;
    // The base token is the thing being revived; the quote is WETH/SOL/a stablecoin.
    const id: string | undefined = pool?.relationships?.base_token?.data?.id;
    if (typeof id !== 'string') continue;
    // Ids arrive as `<network>_<address>`; the address itself can contain no underscore.
    const address = id.slice(id.indexOf('_') + 1);
    if (!address) continue;
    out.push({ address, network, liquidityUsd, volume24hUsd });
  }
  return out;
}

async function fetchPage(network: RevivalNetwork, page: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${GT_BASE}/networks/${network}/pools?page=${page}&sort=h24_volume_usd_desc`,
      { signal: controller.signal, headers: { accept: 'application/json' } },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The busiest tokens on one chain, above the liquidity floor. Cached for 15 minutes.
 *
 * Returns whatever it managed to collect: a failed page shortens the list rather than emptying it,
 * because a partial broad tier is strictly better than none and the alternative is that one 429
 * silently reverts the poller to feed-only coverage.
 */
export async function fetchBroadTier(network: RevivalNetwork): Promise<BroadToken[]> {
  const hit = cache.get(network);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.tokens;

  const max = broadMaxPerNetwork();
  const minLiquidity = broadMinLiquidityUsd();
  const pages = Math.max(1, Math.ceil(max / POOLS_PER_PAGE));
  const seen = new Set<string>();
  const tokens: BroadToken[] = [];

  for (let page = 1; page <= pages && tokens.length < max; page += 1) {
    const json = await fetchPage(network, page);
    if (!json) break;
    for (const token of parsePoolsPage(json, network, minLiquidity)) {
      if (seen.has(token.address)) continue; // one token, many pools
      seen.add(token.address);
      tokens.push(token);
      if (tokens.length >= max) break;
    }
  }

  // Only cache a non-empty result: caching an empty list after a transient failure would suppress
  // the whole tier for 15 minutes and read as "the market is quiet".
  if (tokens.length > 0) cache.set(network, { tokens, at: Date.now() });
  return tokens;
}
