// Verified on-chain facts for Robinhood Chain (id 4663).
//
// EVERY value in this file was verified against the live chain on 2026-07-26 and
// is recorded in LP_AUTOMATION_PLAN.md §11 item 4 and §4 ("The Robinhood Chain
// allowlist — concrete values"). They are NOT re-derived at runtime, but they ARE
// asserted at runtime: `preflight.ts` proves each address has code before anyone
// signs anything based on it.
//
// If you are tempted to edit an address here, stop. A wrong address in this file
// is the single highest-impact mistake available in this whole setup
// (contracts/README.md §5 step 5), and it is unrecoverable once an owner has
// signed it onto the module's allowlist.

import type { Address } from '../../src/types.js';
import { ROBINHOOD_CHAIN_ID } from '../../src/types.js';
import {
  KRYSTAL_TARGETS_ROBINHOOD_UNISWAP_V3,
  OBSERVED_SELECTORS,
} from '../../src/calldata/validate.js';

export { ROBINHOOD_CHAIN_ID };

/** The only chain these scripts will touch without an explicit override flag. */
export const EXPECTED_CHAIN_ID = ROBINHOOD_CHAIN_ID;

/** Public HTTPS RPC. Used only as a documented fallback when LP_RPC_URL is unset. */
export const PUBLIC_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

export const BLOCK_EXPLORER = 'https://robinhoodchain.blockscout.com';

/** The Safe web UI, for executing the owner-signed payloads these scripts emit. */
export const SAFE_UI_BASE = 'https://app.safe.global';

/**
 * Safe deployments confirmed present on 4663 by direct `eth_getCode`
 * (plan §11 item 4). v1.4.1 is the one to use for a new Safe; v1.3.0 is listed
 * so `preflight` can tell you what it actually found rather than only what it
 * hoped for.
 */
export const SAFE_DEPLOYMENTS = {
  v1_4_1: {
    singleton: '0x41675C099F32341bf84BFc5382aF534df5C7461a' as Address,
    proxyFactory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67' as Address,
  },
  v1_3_0: {
    singleton: '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552' as Address,
    safeL2Singleton: '0x3E5c63644E683549055b9Be8653de26E0B4CD36E' as Address,
    proxyFactory: '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2' as Address,
  },
} as const;

/** Sentinel that starts Safe's `getModulesPaginated` linked list. */
export const SENTINEL_MODULES = '0x0000000000000000000000000000000000000001' as Address;

/**
 * Reference contracts on 4663. Recorded so nobody re-derives them — and flagged
 * here explicitly because **neither belongs on the module allowlist**
 * (plan §4). They are for pool verification and token identification only.
 */
export const REFERENCE_CONTRACTS = {
  uniswapV3Factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa' as Address,
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address,
} as const;

/**
 * The complete intended module allowlist: two destinations, three selectors.
 *
 * Sourced from `src/calldata/validate.ts` rather than retyped, so the off-chain
 * validator's destination allowlist and the on-chain module's allowlist cannot
 * silently drift apart. `test/scripts.test.ts` asserts they still agree.
 */
export interface AllowlistDestination {
  readonly name: string;
  readonly address: Address;
  /** 4-byte selectors to enable on this destination, in a stable order. */
  readonly selectors: readonly `0x${string}`[];
  /** What each selector is for, in plain English, for the confirmation prompt. */
  readonly selectorPurpose: Readonly<Record<string, string>>;
}

export const ROBINHOOD_ALLOWLIST: readonly AllowlistDestination[] = [
  {
    name: 'Krystal v3utils helper',
    address: KRYSTAL_TARGETS_ROBINHOOD_UNISWAP_V3.v3utils,
    selectors: [OBSERVED_SELECTORS.swap_and_mint, OBSERVED_SELECTORS.swap_and_increase],
    selectorPurpose: {
      [OBSERVED_SELECTORS.swap_and_mint]: 'swap_and_mint — open a new position (enter)',
      [OBSERVED_SELECTORS.swap_and_increase]: 'swap_and_increase — add to an existing position',
    },
  },
  {
    name: 'Uniswap V3 NonfungiblePositionManager',
    address: KRYSTAL_TARGETS_ROBINHOOD_UNISWAP_V3.positionManager,
    selectors: [OBSERVED_SELECTORS.compound],
    selectorPurpose: {
      // One selector, three operations. This asymmetry is deliberate and is
      // called out in plan §4 and §11 item 5: allowlisting 0xb88d4fde
      // authorizes compound AND adjust_range AND withdraw_and_swap at once,
      // because all three arrive as safeTransferFrom on the position NFT and
      // differ only in the trailing `bytes` argument, which the module does not
      // and cannot inspect.
      [OBSERVED_SELECTORS.compound]:
        'safeTransferFrom — covers compound, adjust_range AND withdraw_and_swap (one selector, three operations)',
    },
  },
] as const;

/** Upper bound the module enforces on `dailyValueCap` (type(uint192).max). */
export const MAX_DAILY_VALUE_CAP = (1n << 192n) - 1n;

/** Below this the operator cannot reliably pay for gas. Advisory, not a hard fail. */
export const MIN_OPERATOR_GAS_WEI = 1_000_000_000_000_000n; // 0.001 ETH
