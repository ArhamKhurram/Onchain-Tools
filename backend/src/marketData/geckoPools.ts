/**
 * GeckoTerminal "busiest pools on a chain" sweep — market-wide discovery, shared.
 *
 * WHY IT IS SHARED. Two signals need the same question answered ("what is
 * actually trading on this chain right now?") from the same rate-limited,
 * keyless upstream: revival's broad tier (`revival/broadUniverse.ts`) and the
 * market-cap crossing signal (`mcapCross/universe.ts`). They want DIFFERENT
 * answers from it — revival wants a small, liquidity-floored list because it
 * spends candle requests per token, while mcapCross wants the widest list it
 * can get because its per-token cost is a DexScreener batch slot and nothing
 * else — but they must share ONE request budget, because GeckoTerminal counts
 * per client IP and does not care which of our subsystems asked.
 *
 * That is the whole reason this module exists rather than a second fetch loop.
 * The pacing lesson is already written down in `revival/candles.ts`: the keyless
 * tier sustains ~6-8 requests/minute (MEASURED from two IPs on 2026-08-11), not
 * the ~30 the third-party write-ups claim, and two subsystems that each pace
 * themselves "safely" produce the SUM of two safe rates, which is not safe. So
 * every request here goes through candles.ts's one global serial queue —
 * including revival's broad tier, which used to bypass it (it was off by
 * default, so it never showed up in production; it would have, the day someone
 * switched it on).
 *
 * THE COST, STATED PLAINLY. A discovery sweep is requests the revival poller
 * does not get to spend on candles. One page is 20 pools, so a `pages`-page
 * sweep of three chains costs `3 × pages` requests out of a ~360/hour budget.
 * Callers are expected to cache aggressively (pool rankings move slowly) and to
 * self-gate so a feature nobody has switched on costs nothing at all.
 *
 * NOT A CACHE ITSELF. Caching is per-caller, because the two callers want
 * different TTLs and different result shapes, and a shared cache keyed only by
 * network would silently serve revival's liquidity-floored list to mcapCross.
 */

import type { RevivalNetwork } from '@oct/shared';
import { geckoTerminalGet } from '../revival/candles.js';

/** Pools per GeckoTerminal page. Fixed by the API, not by us. */
export const POOLS_PER_PAGE = 20;

/** One base token found by a pool sweep. */
export interface PoolToken {
  address: string;
  network: RevivalNetwork;
  liquidityUsd: number;
  volume24hUsd: number;
  /** Pool name ("SYM / SOL"), used only for logging. Null when absent. */
  poolName: string | null;
}

export interface PoolSweepOptions {
  /** Drop pools whose USD reserve is below this. 0 keeps everything positive. */
  minLiquidityUsd: number;
  /** Stop once this many distinct base tokens have been collected. */
  maxTokens: number;
}

/**
 * Parse one GeckoTerminal pools page into candidate tokens.
 *
 * Exported for tests: this is where a schema change would silently empty a
 * caller's universe, so it is worth pinning against a real response shape
 * rather than only through the network path.
 */
export function parsePoolsPage(
  json: unknown,
  network: RevivalNetwork,
  minLiquidityUsd: number,
): PoolToken[] {
  const data: any[] = Array.isArray((json as any)?.data) ? (json as any).data : [];
  const out: PoolToken[] = [];
  for (const pool of data) {
    const attrs = pool?.attributes ?? {};
    const liquidityUsd = Number(attrs?.reserve_in_usd);
    const volume24hUsd = Number(attrs?.volume_usd?.h24);
    // A negative or zero reserve shows up in real data (mid-migration pools) — treat it as
    // untradeable rather than letting it through as a very small positive number.
    if (!Number.isFinite(liquidityUsd) || liquidityUsd < minLiquidityUsd) continue;
    if (!Number.isFinite(volume24hUsd) || volume24hUsd <= 0) continue;
    // The base token is the thing being traded; the quote is WETH/SOL/a stablecoin.
    const id: string | undefined = pool?.relationships?.base_token?.data?.id;
    if (typeof id !== 'string') continue;
    // Ids arrive as `<network>_<address>`; the address itself can contain no underscore.
    const address = id.slice(id.indexOf('_') + 1);
    if (!address) continue;
    out.push({
      address,
      network,
      liquidityUsd,
      volume24hUsd,
      poolName: typeof attrs?.name === 'string' ? attrs.name : null,
    });
  }
  return out;
}

/**
 * The busiest tokens on one chain, above a liquidity floor.
 *
 * Returns whatever it managed to collect: a failed page shortens the list
 * rather than emptying it, because a partial universe is strictly better than
 * none and the alternative is that one 429 silently reverts a poller to no
 * coverage at all — which reads exactly like a quiet market.
 *
 * One token can own many pools; the first (busiest) occurrence wins and the
 * rest are skipped, so `maxTokens` counts tokens, not rows.
 */
export async function sweepBusiestPools(
  network: RevivalNetwork,
  opts: PoolSweepOptions,
): Promise<PoolToken[]> {
  const max = Math.max(0, Math.floor(opts.maxTokens));
  if (max === 0) return [];
  const pages = Math.max(1, Math.ceil(max / POOLS_PER_PAGE));
  const seen = new Set<string>();
  const tokens: PoolToken[] = [];

  for (let page = 1; page <= pages && tokens.length < max; page += 1) {
    const json = await geckoTerminalGet(
      network,
      `/networks/${network}/pools?page=${page}&sort=h24_volume_usd_desc`,
    );
    if (!json) break;
    for (const token of parsePoolsPage(json, network, opts.minLiquidityUsd)) {
      if (seen.has(token.address)) continue; // one token, many pools
      seen.add(token.address);
      tokens.push(token);
      if (tokens.length >= max) break;
    }
  }

  return tokens;
}
