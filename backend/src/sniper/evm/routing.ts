// Best-execution routing: which pool a buy goes through.
//
// Robinhood Chain hosts more than one DEX and, more importantly, more than one
// pool PER TOKEN — the same token routinely has a $12,000 pool and a $0.82 pool
// side by side. Picking arbitrarily (or picking "the first one DexScreener
// returns") is how a 0.01 ETH buy lands in a pool that cannot absorb it. So the
// route is chosen, explicitly, by depth.
//
// The split in this file is deliberate:
//
//   * `classifyPools` / `rankPools` are PURE. They take a list of pools and
//     return the ranking and the routability verdict, with no network at all.
//     That is the part with a real decision in it, and it is the part the tests
//     drive directly.
//   * `resolveRoute` is the impure half: it asks DexScreener what pools exist,
//     then asks the chain for the one or two facts DexScreener does not carry
//     (a V3 pool's fee tier, a V4 pool's PoolKey).
//
// UNROUTABLE IS NOT INVISIBLE. A pool this module cannot execute against is
// still ranked and still reported, with a reason. Silently dropping the deepest
// pool and routing into the second-deepest — while telling the operator it
// picked "the deepest" — would be a lie with money attached.

import {
  DEXSCREENER_CHAIN_SLUG,
  UNISWAP_V4_POOL_MANAGER,
  V4_INITIALIZE_TOPIC,
  V4_NATIVE_CURRENCY,
  WETH_ADDRESS,
} from './chain.js';
import type { EvmRpc } from './rpc.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** A pool as DexScreener describes it, narrowed to the fields the decision uses. */
export interface DiscoveredPool {
  /** DexScreener's DEX slug: 'uniswap', 'flapsh', … */
  dexId: string;
  /** DexScreener's version label, lowercased: 'v2' | 'v3' | 'v4' | '' when absent. */
  label: string;
  /** 20-byte pool contract for V2/V3; the 32-byte POOL ID for V4. */
  pairAddress: string;
  liquidityUsd: number;
  baseToken: string;
  quoteToken: string;
}

export type PoolFamily = 'uniswap_v3' | 'uniswap_v4';

/**
 * Why a pool cannot be routed to. Each value is rendered to the operator, so
 * they are causes, not categories — "we do not support this" and "this pool is
 * not priced in the asset you are spending" are very different problems.
 */
export type UnroutableReason =
  /** A DEX family with no executor here (a V2 fork, a launchpad curve, an unknown dexId). */
  | 'unsupported_dex'
  /** Real pool, real depth, but quoted in USDG/another token — a native-ETH buy cannot reach it in one hop. */
  | 'quote_not_native'
  /** The pool does not contain the token we were asked to buy, or the address shape is wrong for its family. */
  | 'malformed';

export type PoolCandidate =
  | { routable: true; family: PoolFamily; pool: DiscoveredPool }
  | { routable: false; reason: UnroutableReason; pool: DiscoveredPool };

/** A V4 PoolKey, in the order the PoolManager encodes it. */
export interface V4PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

/** Everything the executor needs to build one swap. */
export type Route =
  | {
      family: 'uniswap_v3';
      poolAddress: string;
      /** The pool's fee tier, read from the pool contract — DexScreener does not carry it. */
      fee: number;
      liquidityUsd: number;
    }
  | {
      family: 'uniswap_v4';
      poolId: string;
      poolKey: V4PoolKey;
      /** True when native ETH is currency0, i.e. buying the token is a 0 -> 1 swap. */
      zeroForOne: boolean;
      liquidityUsd: number;
    };

export interface RoutingDecision {
  /** The chosen route, or null when nothing was routable. */
  route: Route | null;
  /** Every pool seen, deepest first, with its verdict. Rendered in the abort reason. */
  candidates: PoolCandidate[];
  /** The deepest pool overall, routable or not. Non-null whenever any pool was found. */
  deepest: DiscoveredPool | null;
}

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// ---------------------------------------------------------------------------
// The pure half
// ---------------------------------------------------------------------------

/**
 * Decide, per pool, whether this module can execute against it.
 *
 * `token` is the address being bought. A pool that does not contain it is
 * `malformed` rather than skipped — DexScreener has been asked about exactly
 * this token, so a pool without it means the response is not what we think it
 * is, and that is worth surfacing rather than filtering away.
 */
export function classifyPool(pool: DiscoveredPool, token: string): PoolCandidate {
  const holdsToken = eq(pool.baseToken, token) || eq(pool.quoteToken, token);
  if (!holdsToken) return { routable: false, reason: 'malformed', pool };

  // The other side of the pair — what we would be spending.
  const counter = eq(pool.baseToken, token) ? pool.quoteToken : pool.baseToken;

  if (pool.dexId === 'uniswap' && pool.label === 'v3') {
    // A V3 `pairAddress` is a real pool contract; a 32-byte value here would
    // mean DexScreener mislabelled a V4 pool, and calling `fee()` on a
    // non-contract returns empty rather than failing usefully.
    if (!/^0x[0-9a-fA-F]{40}$/.test(pool.pairAddress)) return { routable: false, reason: 'malformed', pool };
    // SwapRouter02 wraps native ETH into WETH itself when `tokenIn` is WETH9,
    // so a WETH-quoted V3 pool is reachable with a plain native-value send.
    if (!eq(counter, WETH_ADDRESS)) return { routable: false, reason: 'quote_not_native', pool };
    return { routable: true, family: 'uniswap_v3', pool };
  }

  if (pool.dexId === 'uniswap' && pool.label === 'v4') {
    // V4's `pairAddress` is the 32-byte poolId, not an address.
    if (!/^0x[0-9a-fA-F]{64}$/.test(pool.pairAddress)) return { routable: false, reason: 'malformed', pool };
    // V4 trades native ETH directly (currency == address(0)); there is no wrap
    // step. A WETH-quoted V4 pool would need an extra WRAP_ETH command, and a
    // USDG-quoted one needs a second hop — neither is built here, and both are
    // honestly reported rather than approximated.
    if (!eq(counter, V4_NATIVE_CURRENCY)) return { routable: false, reason: 'quote_not_native', pool };
    return { routable: true, family: 'uniswap_v4', pool };
  }

  return { routable: false, reason: 'unsupported_dex', pool };
}

/**
 * Rank every pool by depth, deepest first, and return the classification.
 *
 * Sorting the WHOLE list (not just the routable ones) is what makes
 * `candidates[0]` answer "what was the best pool available" independently of
 * "what did we route to" — the two being different is exactly the case an
 * operator needs to see.
 *
 * Non-finite liquidity sorts to the bottom rather than throwing: DexScreener
 * omits `liquidity` on brand-new pairs, and a missing number must not be able
 * to win a "deepest" comparison. `NaN` loses every `>` and `<`, so it is
 * normalised to 0 at parse time instead of being trusted here.
 */
export function rankPools(pools: DiscoveredPool[], token: string): PoolCandidate[] {
  return pools
    .slice()
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
    .map((p) => classifyPool(p, token));
}

/** The deepest pool this module can actually execute against, or null. */
export function bestRoutable(candidates: PoolCandidate[]): Extract<PoolCandidate, { routable: true }> | null {
  for (const c of candidates) if (c.routable) return c;
  return null;
}

// ---------------------------------------------------------------------------
// DexScreener
// ---------------------------------------------------------------------------

/** Injected so the tests never touch the network; defaults to the real endpoint. */
export type PoolFetcher = (token: string) => Promise<DiscoveredPool[]>;

const DEXSCREENER_TIMEOUT_MS = 8_000;

/**
 * Parse DexScreener's `/latest/dex/tokens/<addr>` response.
 *
 * Exported and pure so the shape handling — which is where a third-party API
 * breaks — is unit-tested against recorded payloads rather than against the
 * live service. Every field is defensively read: this is untrusted input that
 * decides where money goes, and one `undefined.usd` inside the fire path would
 * surface as an executor throw, i.e. as an `unknown` leg holding a reservation.
 */
export function parseDexScreenerPools(body: unknown): DiscoveredPool[] {
  const pairs = (body as { pairs?: unknown })?.pairs;
  if (!Array.isArray(pairs)) return [];

  const out: DiscoveredPool[] = [];
  for (const raw of pairs) {
    // `null` and primitives have to be rejected BEFORE the cast. TypeScript is
    // happy to assert a shape onto `null`, and the very first property access
    // then throws — inside the fire path, which turns a malformed upstream
    // payload into an executor throw and an `unknown` leg holding a
    // reservation. Exactly the failure the rest of this function is defending
    // against, one line too late.
    if (typeof raw !== 'object' || raw === null) continue;
    const p = raw as {
      chainId?: unknown;
      dexId?: unknown;
      labels?: unknown;
      pairAddress?: unknown;
      liquidity?: { usd?: unknown };
      baseToken?: { address?: unknown };
      quoteToken?: { address?: unknown };
    };
    if (p.chainId !== DEXSCREENER_CHAIN_SLUG) continue;
    if (typeof p.dexId !== 'string' || typeof p.pairAddress !== 'string') continue;
    if (typeof p.baseToken?.address !== 'string' || typeof p.quoteToken?.address !== 'string') continue;

    const liq = Number(p.liquidity?.usd);
    out.push({
      dexId: p.dexId,
      // DexScreener carries the version in a `labels` array (`["v3"]`). A V2-era
      // pair has no labels at all, which lands here as '' and classifies as
      // unsupported — the correct answer, since no V2 executor exists.
      label: Array.isArray(p.labels) && typeof p.labels[0] === 'string' ? p.labels[0].toLowerCase() : '',
      pairAddress: p.pairAddress,
      // Normalised HERE, once, so no comparison downstream can meet a NaN.
      liquidityUsd: Number.isFinite(liq) && liq > 0 ? liq : 0,
      baseToken: p.baseToken.address,
      quoteToken: p.quoteToken.address,
    });
  }
  return out;
}

export const fetchDexScreenerPools: PoolFetcher = async (token) => {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, {
    signal: AbortSignal.timeout(DEXSCREENER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
  return parseDexScreenerPools(await res.json());
};

// ---------------------------------------------------------------------------
// The impure half: fill in what DexScreener does not carry
// ---------------------------------------------------------------------------

/** `fee()` on a Uniswap V3 pool. */
const V3_FEE_SELECTOR = '0xddca3f43';

/**
 * Read a V3 pool's fee tier.
 *
 * SwapRouter02 identifies a pool by (tokenIn, tokenOut, fee) — the fee tier is
 * not decoration, it is a third of the pool's identity. Pass the wrong one and
 * the router computes a different pool address, which either reverts or, worse,
 * routes into a DIFFERENT pool of the same pair that nobody measured the
 * liquidity of. DexScreener does not return it, so it is read from the pool.
 */
export async function readV3Fee(rpc: EvmRpc, poolAddress: string): Promise<number | null> {
  const raw = await rpc.call(poolAddress, V3_FEE_SELECTOR);
  if (!raw || raw === '0x') return null;
  const fee = Number(BigInt(raw));
  // Fee is uint24. A value outside that range means we read something that is
  // not a V3 pool, and building a swap on it would be building on a guess.
  return Number.isInteger(fee) && fee >= 0 && fee < 2 ** 24 ? fee : null;
}

/**
 * Recover a V4 PoolKey from its poolId.
 *
 * A V4 poolId is `keccak256(abi.encode(poolKey))`, so it cannot be inverted —
 * and a V4 swap needs the key, not the id. The PoolManager's `Initialize` event
 * is the only place the key is recorded, and the poolId is its first indexed
 * topic, so one filtered `eth_getLogs` over all history returns exactly one log.
 * (Verified against a live pool: a full-range query on this single indexed match
 * is served fine, while an unfiltered range on the same node is refused for
 * exceeding the log limit — the topic filter is doing real work here, not
 * decoration.)
 *
 * Returns null rather than throwing on a miss, so an unrecoverable key becomes
 * "this pool is not routable" instead of an executor throw.
 */
export async function readV4PoolKey(rpc: EvmRpc, poolId: string): Promise<V4PoolKey | null> {
  const logs = await rpc.getLogs({
    address: UNISWAP_V4_POOL_MANAGER,
    topics: [V4_INITIALIZE_TOPIC, poolId],
    fromBlock: '0x0',
    toBlock: 'latest',
  });
  const log = logs[0];
  if (!log || log.topics.length < 4) return null;

  // topics: [sig, id, currency0, currency1]
  // data:   (uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)
  const d = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
  if (d.length < 64 * 3) return null;

  const word = (i: number): string => d.slice(i * 64, (i + 1) * 64);
  const tickSpacingRaw = BigInt('0x' + word(1));
  return {
    currency0: '0x' + log.topics[2].slice(26),
    currency1: '0x' + log.topics[3].slice(26),
    fee: Number(BigInt('0x' + word(0))),
    // tickSpacing is int24: a negative value is two's-complement in a 256-bit
    // word. It is never negative in practice, but decoding it as unsigned would
    // turn -1 into a colossal positive number that hashes to the wrong poolId,
    // and the resulting swap would revert with nothing to point at.
    tickSpacing: Number(BigInt.asIntN(256, tickSpacingRaw)),
    hooks: '0x' + word(2).slice(24),
  };
}

/**
 * Full routing: discover, rank, and resolve the on-chain facts for the winner.
 *
 * If enriching the deepest routable pool fails (a fee tier that will not read, a
 * PoolKey that is not in the logs), it falls through to the next routable
 * candidate rather than aborting outright — the fallback is still a real,
 * depth-ranked choice, not a guess.
 */
export async function resolveRoute(
  token: string,
  deps: { rpc: EvmRpc; fetchPools?: PoolFetcher },
): Promise<RoutingDecision> {
  const pools = await (deps.fetchPools ?? fetchDexScreenerPools)(token);
  const candidates = rankPools(pools, token);
  const deepest = candidates[0]?.pool ?? null;

  for (const c of candidates) {
    if (!c.routable) continue;

    if (c.family === 'uniswap_v3') {
      const fee = await readV3Fee(deps.rpc, c.pool.pairAddress);
      if (fee === null) continue;
      return {
        route: {
          family: 'uniswap_v3',
          poolAddress: c.pool.pairAddress,
          fee,
          liquidityUsd: c.pool.liquidityUsd,
        },
        candidates,
        deepest,
      };
    }

    const poolKey = await readV4PoolKey(deps.rpc, c.pool.pairAddress);
    if (!poolKey) continue;
    return {
      route: {
        family: 'uniswap_v4',
        poolId: c.pool.pairAddress,
        poolKey,
        // Currencies in a PoolKey are sorted ascending, and native ETH is the
        // zero address, so native is always currency0 when it is in the pool.
        // Asserting it rather than assuming it keeps the swap direction honest
        // if that ever stops being true.
        zeroForOne: eq(poolKey.currency0, V4_NATIVE_CURRENCY),
        liquidityUsd: c.pool.liquidityUsd,
      },
      candidates,
      deepest,
    };
  }

  return { route: null, candidates, deepest };
}

/** One-line rendering of the pool set, for an abort reason an operator can act on. */
export function describeCandidates(candidates: PoolCandidate[], limit = 3): string {
  if (candidates.length === 0) return 'no pools found';
  return candidates
    .slice(0, limit)
    .map((c) => {
      const d = `${c.pool.dexId}${c.pool.label ? `/${c.pool.label}` : ''} $${Math.round(c.pool.liquidityUsd)}`;
      return c.routable ? d : `${d} (${c.reason})`;
    })
    .join(', ');
}
