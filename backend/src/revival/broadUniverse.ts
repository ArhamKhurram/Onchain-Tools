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
 *
 * THE SWEEP ITSELF NOW LIVES IN `marketData/geckoPools.ts`. It was extracted when the market-cap
 * crossing signal needed the same market-wide question answered from the same rate-limited
 * upstream. Nothing observable about this tier changed in the move — same endpoint, same sort,
 * same liquidity floor, same per-network cap, same 15-minute cache, same "a failed page shortens
 * the list rather than emptying it", same "never cache an empty result". The one REAL change is a
 * fix: these requests now go through the single global GeckoTerminal queue in `candles.ts` instead
 * of bypassing it. This tier is off by default, so the bypass never reached production — it would
 * have, the first time someone set OCT_REVIVAL_BROAD_TIER=1, and the symptom would have been
 * revival's candle coverage quietly halving rather than an error.
 */

import type { RevivalNetwork } from '@oct/shared';
import { parsePoolsPage, sweepBusiestPools, type PoolToken } from '../marketData/geckoPools.js';

/** Pool rankings move slowly; refetching them every 5-minute cycle would waste the budget. */
const CACHE_TTL_MS = 15 * 60_000;

/** Below this reserve a "revival" is unexitable — the move cannot be traded even if detected. */
const DEFAULT_MIN_LIQUIDITY_USD = 15_000;
const DEFAULT_MAX_PER_NETWORK = 40;

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

/**
 * Re-exported so the historic import path (and its test) keeps working; the parser itself moved to
 * marketData/geckoPools.ts along with the sweep it belongs to.
 */
export { parsePoolsPage };

const cache = new Map<RevivalNetwork, { tokens: BroadToken[]; at: number }>();

/** Drop the pool-name field the shared sweep carries; this tier has never used it. */
function toBroadToken(token: PoolToken): BroadToken {
  return {
    address: token.address,
    network: token.network,
    liquidityUsd: token.liquidityUsd,
    volume24hUsd: token.volume24hUsd,
  };
}

/**
 * The busiest tokens on one chain, above the liquidity floor. Cached for 15 minutes.
 *
 * Only a NON-EMPTY result is cached: caching an empty list after a transient failure would
 * suppress the whole tier for 15 minutes and read as "the market is quiet".
 */
export async function fetchBroadTier(network: RevivalNetwork): Promise<BroadToken[]> {
  const hit = cache.get(network);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.tokens;

  const tokens = (
    await sweepBusiestPools(network, {
      minLiquidityUsd: broadMinLiquidityUsd(),
      maxTokens: broadMaxPerNetwork(),
    })
  ).map(toBroadToken);

  if (tokens.length > 0) cache.set(network, { tokens, at: Date.now() });
  return tokens;
}
