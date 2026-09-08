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

/**
 * The GeckoTerminal pool-list endpoints this module can sweep.
 *
 * They all return the SAME `data[].attributes` + `relationships.base_token`
 * shape (verified live 2026-09-07), so `parsePoolsPage` reads all three; only
 * the path and the ranking differ.
 *
 *   - `busiest`  — `/pools?sort=h24_volume_usd_desc`. The chain's highest-volume
 *     pools. This is what `sweepBusiestPools` (revival's tier) uses, and it was
 *     the market-cap crossing signal's ONLY source until #386. It is broad but
 *     blind to a token that is climbing fast on modest absolute volume — a
 *     token about to cross 750K is often exactly that.
 *   - `trending` — `/trending_pools`. GeckoTerminal's own "moving right now"
 *     ranking. Its whole purpose is to surface pools before they are the
 *     biggest by 24h volume, which is the set a threshold-crossing detector is
 *     structurally most likely to be missing. One page (~20 pools) per sweep.
 *   - `new`      — `/new_pools`. Recently created pools. Lowest value for a
 *     750K crossing (most are far below it and `market_cap_usd` is usually null
 *     this early), so it is available but OFF by default; a fast launch that
 *     runs straight through 750K is the case it exists for.
 */
export type PoolDiscoverySource = 'busiest' | 'trending' | 'new';

export const POOL_DISCOVERY_SOURCES: readonly PoolDiscoverySource[] = [
  'busiest',
  'trending',
  'new',
] as const;

export function isPoolDiscoverySource(value: string): value is PoolDiscoverySource {
  return (POOL_DISCOVERY_SOURCES as readonly string[]).includes(value);
}

/** Path builder per source. Page is 1-based; GeckoTerminal caps pool lists at page 10. */
const SOURCE_PATH: Record<PoolDiscoverySource, (network: RevivalNetwork, page: number) => string> = {
  busiest: (n, p) => `/networks/${n}/pools?page=${p}&sort=h24_volume_usd_desc`,
  trending: (n, p) => `/networks/${n}/trending_pools?page=${p}`,
  new: (n, p) => `/networks/${n}/new_pools?page=${p}`,
};

/** One base token found by a pool sweep. */
export interface PoolToken {
  address: string;
  network: RevivalNetwork;
  liquidityUsd: number;
  volume24hUsd: number;
  /** Pool name ("SYM / SOL"), used only for logging. Null when absent. */
  poolName: string | null;
  /** Which endpoint surfaced this token. Absent from `sweepBusiestPools` output. */
  source?: PoolDiscoverySource;
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

export interface MultiSourceSweepOptions {
  /**
   * Endpoints to sweep, IN PRIORITY ORDER. A token found by an earlier source
   * keeps that source's row and is not re-added by a later one, so putting
   * `trending` before `busiest` guarantees the movers are in the universe even
   * when `maxTokens` is smaller than `busiest` alone would fill.
   */
  sources: PoolDiscoverySource[];
  /** Drop pools whose USD reserve is below this. */
  minLiquidityUsd: number;
  /** Ceiling on DISTINCT base tokens across all sources combined. */
  maxTokens: number;
  /**
   * Pages per source. Defaults: `busiest` fills the remaining budget
   * (`ceil(maxTokens / 20)`), `trending`/`new` one page each — those two are
   * short rankings where later pages add little and every page is a request
   * against the ~6/min budget revival shares.
   */
  pagesPerSource?: Partial<Record<PoolDiscoverySource, number>>;
}

/**
 * Concatenate per-source token lists into ONE deduped universe, honouring
 * priority order and the token cap. Pure — the ordering/dedup contract that
 * `sweepPools` promises lives here so it can be tested without the network.
 *
 * First occurrence of an address wins, so a token trending AND busiest is
 * counted once, under whichever source came first in `sources`.
 */
export function mergePoolLists(lists: PoolToken[][], maxTokens: number): PoolToken[] {
  const max = Math.max(0, Math.floor(maxTokens));
  const seen = new Set<string>();
  const out: PoolToken[] = [];
  for (const list of lists) {
    for (const token of list) {
      if (out.length >= max) return out;
      if (seen.has(token.address)) continue;
      seen.add(token.address);
      out.push(token);
    }
  }
  return out;
}

/** Page through ONE source, deduped within itself, up to `budget` tokens. */
async function collectSource(
  network: RevivalNetwork,
  source: PoolDiscoverySource,
  minLiquidityUsd: number,
  pages: number,
  budget: number,
): Promise<PoolToken[]> {
  const seen = new Set<string>();
  const tokens: PoolToken[] = [];
  for (let page = 1; page <= pages && tokens.length < budget; page += 1) {
    const json = await geckoTerminalGet(network, SOURCE_PATH[source](network, page));
    // A failed page ends this source rather than emptying the universe — the
    // same "partial is better than none" rule sweepBusiestPools uses.
    if (!json) break;
    let addedThisPage = 0;
    for (const token of parsePoolsPage(json, network, minLiquidityUsd)) {
      if (seen.has(token.address)) continue; // one token, many pools
      seen.add(token.address);
      tokens.push({ ...token, source });
      addedThisPage += 1;
      if (tokens.length >= budget) break;
    }
    // A page that yielded nothing usable means we have run past the ranked
    // rows; more pages would only spend budget for empty results.
    if (addedThisPage === 0) break;
  }
  return tokens;
}

/**
 * The busiest + trending (+ optionally new) tokens on one chain, merged and
 * capped at `maxTokens` DISTINCT base tokens.
 *
 * WHY THIS EXISTS ALONGSIDE `sweepBusiestPools`. Revival's broad tier wants a
 * small, purely volume-ranked list and its behaviour is pinned by tests, so it
 * keeps calling `sweepBusiestPools` unchanged. The market-cap crossing signal
 * wants the WIDEST plausible candidate set — a token about to cross a threshold
 * is disproportionately one that is trending rather than already top-of-book by
 * 24h volume — so it composes several rankings here. Same upstream, same paced
 * queue, same graceful degradation; only the composition differs.
 *
 * Returns whatever it managed to collect. A source that fails contributes
 * nothing rather than throwing, so one 429 shortens the universe for a cycle
 * instead of emptying it.
 */
export async function sweepPools(
  network: RevivalNetwork,
  opts: MultiSourceSweepOptions,
): Promise<PoolToken[]> {
  const max = Math.max(0, Math.floor(opts.maxTokens));
  if (max === 0 || opts.sources.length === 0) return [];
  const busiestPages = Math.max(1, Math.ceil(max / POOLS_PER_PAGE));

  const lists: PoolToken[][] = [];
  for (const source of opts.sources) {
    const pages = opts.pagesPerSource?.[source] ?? (source === 'busiest' ? busiestPages : 1);
    lists.push(await collectSource(network, source, opts.minLiquidityUsd, Math.max(1, pages), max));
  }
  return mergePoolLists(lists, max);
}
