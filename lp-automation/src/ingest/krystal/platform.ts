// Krystal DEX "platform" identifiers.
//
// RESOLVES LP_AUTOMATION_PLAN.md §11 item 3 — the value the `lp-txn` endpoints
// expect for Uniswap V3 on Robinhood Chain (4663).
//
// The answer is the plain string `uniswapv3`, confirmed against the LIVE API on
// 2026-07-26 by four independent observations:
//
//  1. GET /all/v1/strategies/supportedProtocols
//       chain 4663 ("robinhood") -> protocols [{ key: "uniswapv3", name: "Uniswap V3" },
//                                              { key: "uniswapv4", name: "Uniswap V4" }]
//  2. GET /all/v1/lp_explorer/configs
//       chains["4663"].protocols -> id "uniswapv3", supportPositions: true
//  3. GET /all/v1/lp_transaction/* — negative controls prove the check is on the
//     (chain, platform) PAIR, not a global platform name list:
//       platform=uniswapv3   chainId=4663  -> passes platform validation
//       platform=aerodromecl chainId=4663  -> 500 "unsupported chain 4663 or platform aerodromecl"
//                                             (aerodromecl is valid on Base, so the
//                                              rejection is chain-specific)
//       platform=uniswapv3   chainId=99999 -> 500 "unsupported chain 99999 or platform uniswapv3"
//  4. GET /all/v1/lp_transaction/swap_and_mint?platform=uniswapv3&chainId=4663&...
//     returned HTTP 200 with real, executable calldata against a real 4663 pool.
//
// There is no chain-specific suffix or variant: the identifier is the same
// `uniswapv3` used on every other Krystal chain.

import { ROBINHOOD_CHAIN_ID } from '../../types.js';

/** Uniswap V3, on every chain Krystal supports it — including 4663. */
export const PLATFORM_UNISWAP_V3 = 'uniswapv3';

/** Uniswap V4. Present on 4663 but out of scope for Phase 1. */
export const PLATFORM_UNISWAP_V4 = 'uniswapv4';

/**
 * Platforms Krystal reports for Robinhood Chain, in the order the live API
 * returns them. `uniswapv2` appears in `lp_explorer/configs` and in pool
 * listings but not in `strategies/supportedProtocols`, so it is not automation-
 * eligible and is excluded here.
 */
export const ROBINHOOD_PLATFORMS = [PLATFORM_UNISWAP_V3, PLATFORM_UNISWAP_V4] as const;

export type RobinhoodPlatform = (typeof ROBINHOOD_PLATFORMS)[number];

/** The single platform Phase 1 targets (plan §1, §10). */
export const PHASE1_PLATFORM: RobinhoodPlatform = PLATFORM_UNISWAP_V3;

/**
 * Guard for the one combination Phase 1 is allowed to build calldata for.
 * Deliberately narrow: widening it is a policy decision (plan §10 Phase 3),
 * not something a caller should be able to do by passing a different string.
 */
export function isSupportedPhase1Target(chainId: number, platform: string): boolean {
  return chainId === ROBINHOOD_CHAIN_ID && platform === PHASE1_PLATFORM;
}
