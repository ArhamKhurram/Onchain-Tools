// User LP positions (plan §3, "Position state").
//
// Endpoint: GET /all/v1/lp/userPositions?addresses=&chainIds=  — works on 4663.
//
// THE TICK PROBLEM, and why this module splits responsibility the way it does.
//
// `LpPosition` needs `tickLower`, `tickUpper` and `currentTick`. Krystal returns
// NONE of them. It returns human-readable `minPrice` / `maxPrice` per position
// and a `pool.price`. Measured against the chain on 2026-07-26:
//
//   * RANGE BOUNDS ARE EXACTLY RECOVERABLE from minPrice/maxPrice via
//         tick = log_1.0001(price * 10^(decimals1 - decimals0))
//     Checked against `NonfungiblePositionManager.positions()` on chain 4663 for
//     5 positions, including 4 with unequal decimals (18/6 and 6/18) so the
//     decimal term was actually exercised, not cancelled out:
//         tokenId 395774 (18/18) -> derived [141800, 148800]  on-chain [141800, 148800]
//         tokenId 396426 (18/6)  -> derived [-350400, -343600] on-chain [-350400, -343600]
//         tokenId 396425 (18/6)  -> derived [-218820, -218400] on-chain [-218820, -218400]
//         tokenId 396418 (6/18)  -> derived [348200, 355000]  on-chain [348200, 355000]
//         tokenId 396417 (6/18)  -> derived [348200, 354600]  on-chain [348200, 354600]
//     Exact in every case, so `deriveTick` is used for the bounds.
//
//   * CURRENT TICK IS NOT. The same formula applied to `pool.price` disagreed
//     with the pool's own `slot0()` tick by up to 66 ticks (~0.66%) across 8
//     pools — Krystal's price is a cached/aggregated quote, not the pool's spot
//     tick. 66 ticks is small in absolute terms and fatal in the one place it
//     matters: `rangeExitPercent` (plan §5) decides whether a position has left
//     its range, and this is exactly the signal plan §3 says must come from our
//     own RPC watch layer rather than Krystal's REST API.
//
// So `currentTick` MUST be supplied by the caller from `src/ingest/rpc/`. It is
// a required argument, and a position with no authoritative tick is SKIPPED
// with a reason — never backfilled with Krystal's approximation, and never left
// as a NaN that would make an out-of-range position look in-range.

import type { Address, LpPosition, PoolCandidate, PositionStatus, TokenRef } from '../../types.js';
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
import type { SkippedEntry } from './pools.js';

export const USER_POSITIONS_PATH = '/all/v1/lp/userPositions';

const LN_TICK_BASE = Math.log(1.0001);

/**
 * Uniswap V3 tick for a human-readable token1-per-token0 price.
 *
 * `price` is Krystal's decimal-adjusted display price; the `10^(d1-d0)` term
 * converts it back to the raw-units ratio the tick is defined over.
 */
export function deriveTick(price: number, decimals0: number, decimals1: number): number {
  if (!Number.isFinite(price) || price <= 0) {
    throw new KrystalFieldError('position.price', price, 'is not a positive price');
  }
  const raw = Math.log(price) / LN_TICK_BASE + (decimals1 - decimals0) * (Math.LN10 / LN_TICK_BASE);
  if (!Number.isFinite(raw)) {
    throw new KrystalFieldError('position.price', price, 'produced a non-finite tick');
  }
  return Math.round(raw);
}

/**
 * Authoritative tick state for a pool, read from the chain by the RPC layer.
 * Keyed by pool address in `MapPositionsContext`.
 */
export interface PoolTickState {
  currentTick: number;
}

export interface MapPositionsContext {
  chainId: number;
  /**
   * Pool address -> live tick, from `src/ingest/rpc/`. REQUIRED: positions for
   * pools absent from this map are skipped rather than guessed. See the header.
   */
  currentTicks: ReadonlyMap<Address, PoolTickState>;
  /**
   * Optional enrichment from `fetchPools`. The position payload's embedded pool
   * object carries TVL and fee tier but NOT 24h volume, so a position whose pool
   * is missing here gets `volume24hUsd: 0` and is reported in `incomplete`.
   */
  poolIndex?: ReadonlyMap<Address, PoolCandidate>;
}

/**
 * A position that mapped successfully but whose `pool` carries a placeholder for
 * a field Krystal did not supply. The rule evaluator MUST treat these as
 * ineligible for any spend decision that reads the listed fields — a
 * `volume24hUsd` of 0 here means "unknown", not "no volume".
 */
export interface IncompletePosition {
  tokenId: string;
  missing: string[];
}

export interface MappedPositions {
  positions: LpPosition[];
  skipped: SkippedEntry[];
  incomplete: IncompletePosition[];
}

export interface FetchUserPositionsOptions {
  client?: KrystalClient;
  /** See `MapPositionsContext.currentTicks`. Required — no chain data, no positions. */
  currentTicks: ReadonlyMap<Address, PoolTickState>;
  poolIndex?: ReadonlyMap<Address, PoolCandidate>;
  /** 'all' | 'open' | 'closed'; Krystal defaults to 'all'. */
  positionStatus?: 'all' | 'open' | 'closed';
  limit?: number;
  onSkipped?: (entry: SkippedEntry) => void;
  onIncomplete?: (entry: IncompletePosition) => void;
}

/** Krystal's status strings, observed live: IN_RANGE, OUT_RANGE, CLOSED. */
export function mapPositionStatus(raw: unknown, path: string): PositionStatus {
  const status = requireString(raw, path).toUpperCase();
  switch (status) {
    case 'IN_RANGE':
      return 'in_range';
    case 'OUT_RANGE':
    case 'OUT_OF_RANGE':
      return 'out_of_range';
    case 'CLOSED':
      return 'closed';
    default:
      throw new KrystalFieldError(path, raw, 'is not a recognised position status');
  }
}

/**
 * Sum the USD quotes of a Krystal token-amount array (`feePending`,
 * `currentAmounts`, ...). An entry whose `quotes.usd.value` is unreadable throws
 * rather than contributing 0 — unclaimed fees drive the compound trigger
 * (plan §5 `minFeesVsGasRatio`), so an undercount suppresses a real action and
 * an overcount authorises a pointless one.
 */
export function sumUsdQuotes(raw: unknown, path: string): number {
  const entries = requireArray(raw, path);
  let total = 0;
  entries.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const row = requireObject(entry, entryPath);
    const quotes = requireObject(prop(row, 'quotes', entryPath), `${entryPath}.quotes`);
    const usd = requireObject(prop(quotes, 'usd', `${entryPath}.quotes`), `${entryPath}.quotes.usd`);
    total += requireNonNegativeNumber(
      prop(usd, 'value', `${entryPath}.quotes.usd`),
      `${entryPath}.quotes.usd.value`,
    );
  });
  return total;
}

interface EmbeddedPool {
  candidate: PoolCandidate;
  decimals0: number;
  decimals1: number;
  missing: string[];
}

/**
 * Build a `PoolCandidate` from the `pool` object embedded in a position.
 *
 * This is a DIFFERENT shape from `/all/v2/lp_explorer/top_pools`:
 *   { poolAddress, projectKey: "uniswapv3", projectAddress, tickSpacing: 200,
 *     fees: [1, 0],                    // percent, same units as v2 `feeTier`
 *     tvl: 134724.36,                  // number, not a string
 *     price: 1437266.38,
 *     tokenAmounts: [ { token: { address, symbol, decimals: 18, price } }, ... ] }
 *
 * There is no 24h volume field, hence `missing`.
 */
function mapEmbeddedPool(
  raw: unknown,
  path: string,
  chainId: number,
  poolIndex: ReadonlyMap<Address, PoolCandidate> | undefined,
): EmbeddedPool {
  const pool = requireObject(raw, path);
  const address = requireAddress(prop(pool, 'poolAddress', path), `${path}.poolAddress`);
  const platform = requireString(prop(pool, 'projectKey', path), `${path}.projectKey`);

  const tokenAmounts = requireArray(prop(pool, 'tokenAmounts', path), `${path}.tokenAmounts`);
  if (tokenAmounts.length < 2) {
    throw new KrystalFieldError(`${path}.tokenAmounts`, tokenAmounts.length, 'has fewer than 2 tokens');
  }
  const token0 = mapEmbeddedToken(tokenAmounts[0], `${path}.tokenAmounts[0]`);
  const token1 = mapEmbeddedToken(tokenAmounts[1], `${path}.tokenAmounts[1]`);

  const fees = requireArray(prop(pool, 'fees', path), `${path}.fees`);
  if (fees.length === 0) throw new KrystalFieldError(`${path}.fees`, fees, 'is empty');
  const feeTierPercent = requireFiniteNumber(fees[0], `${path}.fees[0]`);
  if (feeTierPercent <= 0) {
    throw new KrystalFieldError(`${path}.fees[0]`, feeTierPercent, 'is not a positive fee tier');
  }

  const tvlUsd = requireNonNegativeNumber(prop(pool, 'tvl', path), `${path}.tvl`);

  // Prefer the richer discovery record when we have it; it is the only source
  // of 24h volume and of a fee APR.
  const known = poolIndex?.get(address);
  const missing: string[] = [];
  if (known === undefined) missing.push('pool.volume24hUsd', 'pool.feeApr');

  const candidate: PoolCandidate = known ?? {
    address,
    chainId,
    platform,
    feeTierBps: percentToBps(feeTierPercent),
    token0,
    token1,
    tvlUsd,
    volume24hUsd: 0,
    feeApr: 0,
  };

  return { candidate, decimals0: token0.decimals, decimals1: token1.decimals, missing };
}

function mapEmbeddedToken(raw: unknown, path: string): TokenRef {
  const entry = requireObject(raw, path);
  const token = requireObject(prop(entry, 'token', path), `${path}.token`);
  return {
    address: requireAddress(prop(token, 'address', `${path}.token`), `${path}.token.address`),
    symbol: requireString(prop(token, 'symbol', `${path}.token`), `${path}.token.symbol`),
    decimals: requireDecimals(prop(token, 'decimals', `${path}.token`), `${path}.token.decimals`),
  };
}

/**
 * Map one raw position row. Pure. Throws `KrystalFieldError` on anything it
 * cannot read unambiguously, including a missing authoritative current tick.
 */
export function mapLpPosition(
  raw: unknown,
  context: MapPositionsContext,
  path = 'position',
): { position: LpPosition; missing: string[] } {
  const row = requireObject(raw, path);

  const chainId = requireInteger(prop(row, 'chainId', path), `${path}.chainId`);
  if (chainId !== context.chainId) {
    throw new KrystalFieldError(`${path}.chainId`, chainId, `is not the requested chain ${context.chainId}`);
  }

  const tokenId = requireString(prop(row, 'tokenId', path), `${path}.tokenId`);
  const pool = mapEmbeddedPool(prop(row, 'pool', path), `${path}.pool`, chainId, context.poolIndex);

  const minPrice = requireFiniteNumber(prop(row, 'minPrice', path), `${path}.minPrice`);
  const maxPrice = requireFiniteNumber(prop(row, 'maxPrice', path), `${path}.maxPrice`);
  const tickLower = deriveTick(minPrice, pool.decimals0, pool.decimals1);
  const tickUpper = deriveTick(maxPrice, pool.decimals0, pool.decimals1);
  if (tickUpper <= tickLower) {
    throw new KrystalFieldError(`${path}.maxPrice`, maxPrice, 'derives a tick at or below tickLower');
  }

  const tickState = context.currentTicks.get(pool.candidate.address);
  if (tickState === undefined) {
    throw new KrystalFieldError(
      `${path}.pool.poolAddress`,
      pool.candidate.address,
      'has no authoritative current tick; supply one from the RPC layer (Krystal’s pool.price is ' +
        'a cached quote and drifted up to 66 ticks from slot0() when measured)',
    );
  }

  const status = mapPositionStatus(prop(row, 'status', path), `${path}.status`);
  const valueUsd = requireNonNegativeNumber(
    prop(row, 'currentPositionValue', path),
    `${path}.currentPositionValue`,
  );
  const unclaimedFeesUsd = sumUsdQuotes(prop(row, 'feePending', path), `${path}.feePending`);
  const openedAt = requireInteger(prop(row, 'openedTime', path), `${path}.openedTime`);

  const position: LpPosition = {
    tokenId,
    pool: pool.candidate,
    status,
    tickLower,
    tickUpper,
    currentTick: tickState.currentTick,
    valueUsd,
    unclaimedFeesUsd,
    openedAt,
    // Krystal exposes no last-compound timestamp on any position endpoint we
    // sampled. Null is honest; the compound trigger's `maxIntervalHours` arm
    // has to come from our own audit log (plan §10 step 6), not from Krystal.
    lastCompoundedAt: null,
  };

  return { position, missing: pool.missing };
}

/** Map a whole `/all/v1/lp/userPositions` payload. Pure. */
export function mapUserPositions(raw: unknown, context: MapPositionsContext): MappedPositions {
  const envelope = requireObject(raw, 'userPositions');
  const rows = requireArray(prop(envelope, 'positions', 'userPositions'), 'userPositions.positions');

  const positions: LpPosition[] = [];
  const skipped: SkippedEntry[] = [];
  const incomplete: IncompletePosition[] = [];

  rows.forEach((row, index) => {
    const rowPath = `userPositions.positions[${index}]`;
    try {
      const mapped = mapLpPosition(row, context, rowPath);
      positions.push(mapped.position);
      if (mapped.missing.length > 0) {
        incomplete.push({ tokenId: mapped.position.tokenId, missing: mapped.missing });
      }
    } catch (error) {
      skipped.push({
        index,
        identifier: readTokenId(row),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return { positions, skipped, incomplete };
}

function readTokenId(row: unknown): string {
  if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
    const value = (row as Record<string, unknown>).tokenId;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '<unknown>';
}

/** Open and closed LP positions held by `owner` on `chainId`. */
export async function fetchUserPositions(
  chainId: number,
  owner: Address,
  options: FetchUserPositionsOptions,
): Promise<LpPosition[]> {
  const client = options.client ?? getKrystalClient();
  const raw = await client.getJson(USER_POSITIONS_PATH, {
    addresses: owner,
    chainIds: chainId,
    positionStatus: options.positionStatus ?? 'all',
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });

  const result = mapUserPositions(raw, {
    chainId,
    currentTicks: options.currentTicks,
    ...(options.poolIndex === undefined ? {} : { poolIndex: options.poolIndex }),
  });

  for (const entry of result.skipped) options.onSkipped?.(entry);
  for (const entry of result.incomplete) options.onIncomplete?.(entry);

  return result.positions;
}
