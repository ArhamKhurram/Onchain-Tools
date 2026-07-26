// Calldata layer types.
//
// Deliberately declared HERE and not in `src/types.ts`: the shared contract is
// the seam between ingest / rules / lifecycle / audit, and none of those need to
// know the shape of a transaction. Keeping `PreparedTransaction` local means the
// only modules that can hold one are the ones that asked for it.

import type { Address } from '../types.js';

/** The five Krystal `lp_transaction/*` operations we build calldata from. */
export type LpTxnKind =
  | 'compound'
  | 'adjust_range'
  | 'swap_and_mint'
  | 'swap_and_increase'
  | 'withdraw_and_swap';

/** Krystal path segment for each operation. */
export const LP_TXN_PATHS: Record<LpTxnKind, string> = {
  compound: '/all/v1/lp_transaction/compound',
  adjust_range: '/all/v1/lp_transaction/adjust_range',
  swap_and_mint: '/all/v1/lp_transaction/swap_and_mint',
  swap_and_increase: '/all/v1/lp_transaction/swap_and_increase',
  withdraw_and_swap: '/all/v1/lp_transaction/withdraw_and_swap',
};

/**
 * An inert, fully-validated transaction description.
 *
 * INERT IS THE POINT. This is data: no methods that send anything, no signer, no
 * client, no key material, nothing that can be awaited into a broadcast. The
 * signer (plan §4) takes one of these, runs it past the Safe + Guard, and is the
 * only component in the system that can turn it into a transaction.
 *
 * `value` is a bigint rather than a hex string so a downstream spend cap
 * comparison cannot accidentally be a string comparison.
 */
export interface PreparedTransaction {
  readonly to: Address;
  readonly value: bigint;
  readonly data: `0x${string}`;
  readonly meta: PreparedTransactionMeta;
}

export interface PreparedTransactionMeta {
  readonly kind: LpTxnKind;
  readonly chainId: number;
  readonly platform: string;
  /** The address Krystal built the calldata FOR — must be the Safe. */
  readonly from: Address;
  /** 4-byte selector, extracted for allowlisting and audit readability. */
  readonly selector: `0x${string}`;
  /** Krystal's gas estimate, if it supplied a usable one. */
  readonly estimateGas: bigint | null;
  /** Krystal's suggested gas limit, if it supplied a usable one. */
  readonly gasLimit: bigint | null;
  /** True when Krystal fell back to a default gas figure instead of estimating. */
  readonly usedDefaultGas: boolean;
  /** Wall-clock time the calldata was built. Calldata is perishable. */
  readonly builtAt: number;
  /** Raw `txInfo` block, carried verbatim for the audit log (plan §10 step 6). */
  readonly txInfo: unknown;
}

/** Bounds the validator enforces. Every field is a hard limit, not a hint. */
export interface CalldataPolicy {
  readonly chainId: number;
  readonly platform: string;
  /**
   * Contracts Krystal is permitted to name as `to`. Lowercase.
   * MIRRORS — does not replace — the on-chain Guard allowlist (plan §4).
   */
  readonly allowedTargets: readonly Address[];
  /** The Safe. Krystal's `txData.from` must equal this. */
  readonly expectedFrom: Address;
  /** Hard ceiling on native value in wei. Zap-ins with native ETH are non-zero. */
  readonly maxValueWei: bigint;
  /** Reject absurd calldata outright. Observed real payloads: 1418–2954 hex chars. */
  readonly maxDataBytes?: number;
}
