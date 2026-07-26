// Pool discovery (plan §3, §9 point 2).
//
// ENDPOINT CHOICE — this differs from the plan, deliberately, because the plan's
// named endpoints do not work. Verified live on 2026-07-26:
//
//   GET /all/v1/pool/list                -> 500 "An internal error has occurred"
//                                           on EVERY chain, including Ethereum
//                                           and Base. Not a 4663 problem.
//   GET /all/v1/lp_explorer/top_pools    -> 400 "chain id N not supported"
//   GET /all/v1/lp_explorer/pool_detail  -> 400, same
//   GET /all/v1/lp_explorer/pool_chart   -> 400, same
//     ...all three for chainId 1, 8453 and 4663 alike.
//
//   GET /all/v2/lp_explorer/top_pools    -> 200. Works.
//
// The v2 route is NOT in Krystal's published OpenAPI spec (which documents only
// the broken v1 group), so treat its exact shape as observed-not-contracted and
// keep the mapper defensive. On chain 4663 it returned 1107 pools:
// 1039 uniswapv3, 57 uniswapv4, 11 uniswapv2.
//
// Filtering is done CLIENT-SIDE. `protocol` and `minTvl` query parameters were
// accepted by the server but produced byte-identical responses to omitting
// them, i.e. they are ignored. Relying on them would silently disable the
// policy's pool-selection criteria.

import type { Address, PoolCandidate, PoolSelectionCriteria, TokenRef } from '../../types.js';
import { getKrystalClient, type KrystalClient } from './client.js';
import {
  KrystalFieldError,
  percentToBps,
  percentToFraction,
  prop,
  requireAddress,
  requireArray,
  requireDecimals,
  requireFiniteNumber,
  requireInteger,
  requireNonNegativeNumber,
  requireObject,
  requireString,
} from './coerce.js';

export const TOP_POOLS_PATH = '/all/v2/lp_explorer/top_pools';

/** An entry the mapper refused to trust, with the reason. Never silently dropped. */
export interface SkippedEntry {
  index: number;
  identifier: string;
  reason: string;
}

export interface MappedPools {
  pools: PoolCandidate[];
  skipped: SkippedEntry[];
}

export interface FetchPoolsOptions {
  client?: KrystalClient;
  /** Krystal platform key, e.g. 'uniswapv3'. Omit to accept every platform. */
  platform?: string;
  /** Cap the number of rows Krystal returns. The `limit` query param does work. */
  limit?: number;
  /** Called once per rejected entry so ingest problems are visible, not silent. */
  onSkipped?: (entry: SkippedEntry) => void;
}

/**
 * Map one raw pool row from `/all/v2/lp_explorer/top_pools`.
 *
 * Pure — no network, no clock, no config. Throws `KrystalFieldError` on any
 * field it cannot read unambiguously; the caller decides whether to skip the
 * row or abort.
 *
 * Observed raw shape (chain 4663, real response):
 *   {
 *     chainId: 4663,
 *     protocol: "uniswapv3",
 *     poolAddress: "0x4c00...",
 *     feeTier: 1,                       // PERCENT, not bps: 1 => on-chain fee 10000
 *     tvlUsd: "4791.63651",             // string
 *     tvlToken0: "3631.757754",
 *     tvlToken1: "1159.878757",
 *     token0: { symbol, address, logo, decimals: "18", balance, usdPrice: "" },
 *     token1: { ... },
 *     stat1h/stat24h/stat7d/stat30d: { volumeUsd: "115603.48", feeUsd: "1156.03", apr: 8806.02 },
 *     drawdown24h, priceVolatility, isSupportLpAuto, hooks, dynamicFee, ...
 *   }
 *
 * Note `usdPrice` was `""` on all 1107 sampled rows — it is never read here, and
 * would have coerced to 0 under `Number()`.
 */
export function mapPoolCandidate(raw: unknown, path = 'pool'): PoolCandidate {
  const row = requireObject(raw, path);

  const chainId = requireInteger(prop(row, 'chainId', path), `${path}.chainId`);
  const platform = requireString(prop(row, 'protocol', path), `${path}.protocol`);

  // Uniswap V4 pools are identified by a 32-byte poolId, not a contract address
  // — `PoolCandidate.address` cannot represent one. On chain 4663 this is all 57
  // uniswapv4 rows and nothing else. Called out explicitly so these show up as
  // "structurally out of scope" rather than as 57 malformed-address warnings a
  // reader would learn to ignore, hiding a real data problem among them.
  const rawAddress = row.poolAddress;
  if (typeof rawAddress === 'string' && /^0x[0-9a-fA-F]{64}$/.test(rawAddress)) {
    throw new KrystalFieldError(
      `${path}.poolAddress`,
      rawAddress,
      `is a 32-byte pool id (${platform}), not a pool contract address; ` +
        'concentrated-liquidity-v4-style pools are out of scope for Phase 1',
    );
  }

  const address = requireAddress(rawAddress, `${path}.poolAddress`);

  const feeTierPercent = requireFiniteNumber(prop(row, 'feeTier', path), `${path}.feeTier`);
  if (feeTierPercent <= 0) {
    throw new KrystalFieldError(`${path}.feeTier`, feeTierPercent, 'is not a positive fee tier');
  }

  const tvlUsd = requireNonNegativeNumber(prop(row, 'tvlUsd', path), `${path}.tvlUsd`);

  const stat24h = requireObject(prop(row, 'stat24h', path), `${path}.stat24h`);
  const volume24hUsd = requireNonNegativeNumber(
    prop(stat24h, 'volumeUsd', `${path}.stat24h`),
    `${path}.stat24h.volumeUsd`,
  );
  const aprPercent = requireFiniteNumber(
    prop(stat24h, 'apr', `${path}.stat24h`),
    `${path}.stat24h.apr`,
  );

  return {
    address,
    chainId,
    platform,
    feeTierBps: percentToBps(feeTierPercent),
    token0: mapTokenRef(prop(row, 'token0', path), `${path}.token0`),
    token1: mapTokenRef(prop(row, 'token1', path), `${path}.token1`),
    tvlUsd,
    volume24hUsd,
    feeApr: percentToFraction(aprPercent),
  };
}

function mapTokenRef(raw: unknown, path: string): TokenRef {
  const token = requireObject(raw, path);
  return {
    address: requireAddress(prop(token, 'address', path), `${path}.address`),
    symbol: requireString(prop(token, 'symbol', path), `${path}.symbol`),
    decimals: requireDecimals(prop(token, 'decimals', path), `${path}.decimals`),
  };
}

/**
 * Map a whole `/all/v2/lp_explorer/top_pools` payload.
 *
 * A malformed row is skipped WITH A RECORDED REASON rather than aborting the
 * batch — one junk memecoin listing on a four-week-old chain must not blind the
 * evaluator to every other pool. A malformed envelope still throws, because
 * that means we are not looking at the response we think we are.
 */
export function mapTopPools(raw: unknown): MappedPools {
  const envelope = requireObject(raw, 'topPools');
  const rows = requireArray(prop(envelope, 'result', 'topPools'), 'topPools.result');

  const pools: PoolCandidate[] = [];
  const skipped: SkippedEntry[] = [];

  rows.forEach((row, index) => {
    try {
      pools.push(mapPoolCandidate(row, `topPools.result[${index}]`));
    } catch (error) {
      skipped.push({
        index,
        identifier: readIdentifier(row, 'poolAddress'),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return { pools, skipped };
}

function readIdentifier(row: unknown, key: string): string {
  if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
    const value = (row as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '<unknown>';
}

/**
 * Pool candidates on `chainId` that satisfy the policy's surfacing criteria.
 *
 * These are CANDIDATES ONLY. Per plan §9 point 2 nothing here admits a pool to
 * the allowlist — that stays a manual dashboard choice. `maxIlRiskScore` is
 * accepted but not applied: there is no IL risk model yet (see the TBD note on
 * `PoolSelectionCriteria` in types.ts), and inventing one here would silently
 * admit or exclude pools on a number nobody chose.
 */
export async function fetchPools(
  chainId: number,
  criteria: PoolSelectionCriteria,
  options: FetchPoolsOptions = {},
): Promise<PoolCandidate[]> {
  const client = options.client ?? getKrystalClient();
  const raw = await client.getJson(TOP_POOLS_PATH, {
    chainId,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });

  const { pools, skipped } = mapTopPools(raw);
  for (const entry of skipped) options.onSkipped?.(entry);

  return pools.filter(
    (pool) =>
      pool.chainId === chainId &&
      (options.platform === undefined || pool.platform === options.platform) &&
      pool.tvlUsd >= criteria.minTvlUsd &&
      pool.volume24hUsd >= criteria.min24hVolumeUsd,
  );
}

/** Index pools by address for cheap joins against position payloads. */
export function indexPoolsByAddress(pools: readonly PoolCandidate[]): Map<Address, PoolCandidate> {
  return new Map(pools.map((pool) => [pool.address, pool]));
}
