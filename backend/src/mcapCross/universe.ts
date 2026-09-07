/**
 * The candidate universe for the market-cap crossing signal.
 *
 * WHAT IT HAS TO BE, AND WHY IT IS NOT THE REVIVAL BROAD TIER. The user's ask
 * is chain-WIDE: any coin crossing 750K, not any coin somebody in their rooms
 * posted. So the feed-derived universe every other OCT signal uses is
 * structurally wrong here for the same reason broadUniverse.ts was written for
 * revival — a token nobody mentioned is invisible by construction.
 *
 * Three options were on the table, and the choice is worth writing down:
 *
 *   (a) Call `fetchBroadTier` directly. Rejected. It is gated OFF behind
 *       OCT_REVIVAL_BROAD_TIER, so this feature would either do nothing or
 *       force an operator to switch on a production revival tier as a side
 *       effect of enabling an unrelated alert. It also caps at 40 tokens per
 *       network and floors at $15K liquidity — both correct for revival and
 *       both wrong here.
 *   (b) Extract the shared parts. CHOSEN. The sweep moved to
 *       `marketData/geckoPools.ts`; revival keeps its own caps, floor, cache
 *       and gate, and this module keeps its own. Nothing observable about the
 *       revival tier changed (see the note in broadUniverse.ts).
 *   (c) A separate discovery pass. Rejected: it would be a second unpaced
 *       client against a shared per-IP rate limit, which is the exact failure
 *       candles.ts's global queue exists to prevent.
 *
 * BROADER, ON PURPOSE. Revival wants a liquidity floor AT DISCOVERY because it
 * spends candle requests per token — every candidate costs GeckoTerminal
 * budget, so a thin token in the universe is a real token missed elsewhere.
 * This signal gates LATE and CHEAPLY: a candidate costs one slot in a
 * DexScreener batch (30 tokens per request, ~300 req/min ceiling) and nothing
 * more until it actually crosses. So the floor here is a sanity floor, not a
 * quality filter — the quality filter is `gates.ts`, and it runs on fire.
 *
 * SEVERAL RANKINGS, NOT ONE (#386). The universe used to be a single ranking —
 * `sweepBusiestPools`, the chain's top pools by 24h volume. The owner's report
 * that it was "thin" is the predictable failure of that one ranking: a token
 * about to cross 750K is disproportionately one that is CLIMBING on modest
 * absolute volume, which is exactly what a top-of-book-by-volume list is blind
 * to. So discovery now composes GeckoTerminal's `trending_pools` and its
 * volume-ranked `pools` (and optionally `new_pools`), merged and deduped by
 * `sweepPools`, with `trending` FIRST so the movers are always in-universe.
 * The set of rankings is env-switchable (OCT_MCAP_CROSS_DISCOVERY_SOURCES), and
 * setting it to `busiest` reverts to the exact pre-#386 behaviour — the change
 * is additive, not a cutover that dies if one endpoint does.
 *
 * NO NEW UPSTREAM, ON PURPOSE. Live probing (#386) found no free API that
 * enumerates every token on Solana + BNB + Robinhood with market cap: DexScreener
 * has no by-chain list (its search caps at 30 rows), robinhoodtrenches carries
 * price but no supply/market cap, and GMGN's rank endpoints are unverifiable
 * without spending its key on an unproven Robinhood-chain coverage claim. The
 * GeckoTerminal pool sweep IS the multi-chain enumeration for these three
 * chains; broadening WHICH pools it reads is the honest improvement.
 *
 * THE BUDGET, STATED PLAINLY. Discovery is the ONLY part of this feature that
 * spends the GeckoTerminal budget revival depends on, and that budget is
 * ~6 requests/minute for the whole process (measured; see candles.ts). One page
 * is 20 tokens, so the default 120 tokens/network from `busiest` is 6 pages,
 * plus one page for `trending` = 7 requests/network × 3 networks ≈ 21 per
 * sweep. At a 60-minute cache that is 21 of roughly 360 requests an hour —
 * about 6%, up from ~4%. The cache TTL is long for exactly this reason: pool
 * rankings move far slower than market caps do, and re-ranking the chain every
 * cycle would buy nothing and cost revival its coverage.
 *
 * AND IT IS FREE WHEN NOBODY IS LISTENING. The poller self-gates on there being
 * at least one subscribed Telegram chat (see poller.ts), so a deploy where no
 * one has opted in spends zero requests here — the same self-gating shape the
 * price-alert poller uses for "zero armed alerts, zero requests".
 */

import type { RevivalNetwork } from '@oct/shared';
import {
  isPoolDiscoverySource,
  sweepPools,
  type PoolDiscoverySource,
  type PoolToken,
} from '../marketData/geckoPools.js';
import { resolveRevivalNetworks } from '../revival/networks.js';

/**
 * Pool rankings move slowly and this sweep competes with revival's candles for
 * one ~6 req/min budget. An hour is long enough that discovery is a rounding
 * error against that budget, and short enough that a token that started
 * trading this morning is in the universe by lunchtime.
 */
const DEFAULT_CACHE_TTL_MS = 60 * 60_000;

/**
 * A sanity floor, NOT a quality gate. A pool with a few hundred dollars in it
 * cannot produce a real 750K market cap, and including it only wastes a
 * DexScreener batch slot. Everything above this is the gates' problem.
 */
const DEFAULT_MIN_LIQUIDITY_USD = 2_000;

/**
 * 120 distinct tokens per network. Above the old 100 on purpose: `trending`
 * goes in FIRST (~20 movers), and the extra 20 slots keep `busiest` coverage
 * from shrinking below what it was when it was the only source. Six busiest
 * pages plus one trending page; see the budget note above.
 */
const DEFAULT_MAX_PER_NETWORK = 120;

/**
 * The rankings swept, in priority order. `trending` first so the climbing
 * tokens a threshold detector cares about are never crowded out of the cap by
 * the volume leaders. `new` is deliberately absent: at the moment a pool is
 * created its `market_cap_usd` is almost always null and its fdv tiny, so it
 * rarely helps a 750K detector and it spends batch slots — an operator who
 * wants the fast-launch case adds it via the env var.
 */
const DEFAULT_DISCOVERY_SOURCES: readonly PoolDiscoverySource[] = ['trending', 'busiest'];

export interface UniverseToken {
  address: string;
  network: RevivalNetwork;
  liquidityUsd: number;
  /** Which GeckoTerminal ranking surfaced it. For logging/diagnostics only. */
  source?: PoolDiscoverySource;
}

function envFlag(name: string): string | undefined {
  return process.env[`OCT_${name}`] ?? process.env[`TRENCHCORD_${name}`];
}

function envInt(name: string, fallback: number): number {
  const raw = Number(envFlag(name));
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export function universeMaxPerNetwork(): number {
  return envInt('MCAP_CROSS_MAX_PER_NETWORK', DEFAULT_MAX_PER_NETWORK);
}

export function universeMinLiquidityUsd(): number {
  return envInt('MCAP_CROSS_DISCOVERY_MIN_LIQUIDITY_USD', DEFAULT_MIN_LIQUIDITY_USD);
}

export function universeCacheTtlMs(): number {
  return envInt('MCAP_CROSS_DISCOVERY_TTL_MS', DEFAULT_CACHE_TTL_MS);
}

/**
 * The GeckoTerminal rankings to sweep, from OCT_MCAP_CROSS_DISCOVERY_SOURCES —
 * a comma-separated, priority-ordered list of `busiest` / `trending` / `new`.
 * Unknown entries are dropped with a warning; an empty or all-garbage value
 * falls back to the default. Setting it to `busiest` restores the exact
 * pre-#386 single-ranking universe.
 *
 * Exported and pure (given the env) so the parser is unit-tested directly.
 */
export function resolveDiscoverySources(): PoolDiscoverySource[] {
  return parseDiscoverySources(envFlag('MCAP_CROSS_DISCOVERY_SOURCES'));
}

export function parseDiscoverySources(raw: string | undefined | null): PoolDiscoverySource[] {
  if (raw == null || raw.trim() === '') return [...DEFAULT_DISCOVERY_SOURCES];
  const out: PoolDiscoverySource[] = [];
  for (const part of raw.split(',')) {
    const id = part.trim().toLowerCase();
    if (id === '') continue;
    if (!isPoolDiscoverySource(id)) {
      console.warn(`[McapCross] Ignoring unknown discovery source in OCT_MCAP_CROSS_DISCOVERY_SOURCES: ${id}`);
      continue;
    }
    if (!out.includes(id)) out.push(id);
  }
  return out.length > 0 ? out : [...DEFAULT_DISCOVERY_SOURCES];
}

const cache = new Map<RevivalNetwork, { tokens: UniverseToken[]; at: number }>();

/** Test seam: drop the discovery cache so a test isn't served a stale sweep. */
export function resetUniverseCache(): void {
  cache.clear();
}

function toUniverseToken(token: PoolToken): UniverseToken {
  return {
    address: token.address,
    network: token.network,
    liquidityUsd: token.liquidityUsd,
    source: token.source,
  };
}

/**
 * The candidate set for one network. Cached; a failed sweep is NOT cached, so
 * one 429 costs a cycle rather than an hour of blindness.
 */
export async function fetchNetworkUniverse(network: RevivalNetwork): Promise<UniverseToken[]> {
  const hit = cache.get(network);
  if (hit && Date.now() - hit.at < universeCacheTtlMs()) return hit.tokens;

  const tokens = (
    await sweepPools(network, {
      sources: resolveDiscoverySources(),
      minLiquidityUsd: universeMinLiquidityUsd(),
      maxTokens: universeMaxPerNetwork(),
    })
  ).map(toUniverseToken);

  if (tokens.length > 0) cache.set(network, { tokens, at: Date.now() });
  return tokens;
}

/**
 * The whole universe, across every watched network.
 *
 * Networks come from OCT_REVIVAL_NETWORKS — the same switch revival reads,
 * reused rather than duplicated so a chain can never be watched by one signal
 * and not the other by accident. Sharing a CONFIG table is not fusing two
 * signals; neither poller can see the other's state.
 */
export async function fetchUniverse(): Promise<UniverseToken[]> {
  const out: UniverseToken[] = [];
  for (const network of resolveRevivalNetworks()) {
    out.push(...(await fetchNetworkUniverse(network)));
  }
  return out;
}
