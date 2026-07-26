// The minimal slice of the Uniswap V3 pool interface this watcher needs,
// declared inline with viem's `parseAbi` rather than pulled in as a dependency.
//
// Only four things are used:
//   • Swap  — the only event that changes the pool's current tick. This is the
//             low-latency trigger the whole module exists for.
//   • Mint / Burn — change liquidity within a tick range. They do NOT move the
//             current tick, so they cannot cause a range crossing; they are
//             surfaced as informational only (see `onLiquidityChange`).
//   • slot0() — the authoritative current tick, used to seed state on connect,
//             to poll in the degraded fallback mode, and to re-verify a
//             crossing at its confirmation depth.
//
// Signatures are the canonical Uniswap V3 core ones (IUniswapV3PoolEvents /
// IUniswapV3PoolState); the indexed/non-indexed layout must match exactly or
// topic encoding silently matches nothing.

import { parseAbi, parseAbiItem } from 'viem';

/**
 * Emitted on every swap. `tick` is the pool's tick *after* the swap — this is
 * the value the watcher compares against position ranges.
 */
export const SWAP_EVENT = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);

export const MINT_EVENT = parseAbiItem(
  'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
);

export const BURN_EVENT = parseAbiItem(
  'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
);

/** Liquidity-affecting events, subscribed to only when a caller asks for them. */
export const LIQUIDITY_EVENTS = [MINT_EVENT, BURN_EVENT] as const;

/** Read-only pool functions used by the seed / poll / confirm paths. */
export const UNISWAP_V3_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
]);
