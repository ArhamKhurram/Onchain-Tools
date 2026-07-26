// ============================================================================
// SECURITY BOUNDARY — read this before changing anything below.
// ============================================================================
//
// Krystal is a third-party HTTP API. It is UNTRUSTED INPUT. Its output is a
// destination address, a native-token amount, and an opaque blob of calldata,
// and the next thing that happens to all three is that a key with real funds
// signs them. There is no other point in the pipeline where a wrong `to` or an
// inflated `value` gets caught off-chain.
//
// This module is that point. It is not input hygiene and it is not a formality:
// a compromised, hijacked, or simply buggy Krystal response reaching a signer
// unvalidated is a total loss of the automation wallet.
//
// It is also NOT the last line of defence, by design. Plan §4 puts a Guard
// contract on the Safe that re-checks destination and spend caps ON-CHAIN, so
// this code being wrong is survivable. The two layers exist because they fail
// differently: the Guard cannot be bypassed by compromising this process, and
// this validator catches things (a revert, a stale quote) before gas is spent.
// Neither replaces the other. Do not delete one because the other exists.
//
// Rules for edits:
//   * Never widen a check to make a call site work. Fix the call site.
//   * Never add a "skip validation" flag, a bypass, or a warn-only mode.
//   * Every rejection throws. There is no partial success.
// ============================================================================

import type { Address } from '../types.js';
import type {
  CalldataPolicy,
  LpTxnKind,
  PreparedTransaction,
  PreparedTransactionMeta,
} from './types.js';

/** Thrown when a Krystal response fails validation. Always fatal to the action. */
export class CalldataValidationError extends Error {
  readonly field: string;
  readonly received: unknown;

  constructor(field: string, received: unknown, detail: string) {
    super(`Krystal calldata rejected: ${field} ${detail}`);
    this.name = 'CalldataValidationError';
    this.field = field;
    this.received = received;
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_DATA = /^0x[0-9a-fA-F]*$/;

/** Default ceiling on calldata size. Real 4663 payloads were 1418–2954 hex chars. */
const DEFAULT_MAX_DATA_BYTES = 8192;

/**
 * Contract addresses Krystal named as `txData.to` on chain 4663 for Uniswap V3,
 * observed live across all five `lp_transaction/*` endpoints on 2026-07-26.
 *
 * TWO distinct targets, because Krystal uses two different flows:
 *
 *   swap_and_mint / swap_and_increase
 *     -> 0xb4acbc082b5e7ded571c98ee4257778a9d784b36  (Krystal v3utils helper)
 *        selectors 0x954543e6 / 0x3dce3e25, called directly.
 *
 *   compound / adjust_range / withdraw_and_swap
 *     -> 0x73991a25c818bf1f1128deaab1492d45638de0d3  (Uniswap V3
 *        NonfungiblePositionManager on 4663)
 *        selector 0xb88d4fde = safeTransferFrom(address,address,uint256,bytes),
 *        i.e. the position NFT is handed to the v3utils helper with the
 *        instructions in the trailing `bytes`.
 *
 * THIS IS AN OBSERVED SET, NOT A PUBLISHED ONE. Krystal can redeploy v3utils and
 * change the helper address without telling us; when that happens this list must
 * be updated deliberately AND the Guard's on-chain allowlist updated with the
 * offline co-signer (plan §9 point 3). A validation failure here is the intended
 * behaviour in that situation — it is the system refusing to sign for a contract
 * nobody reviewed.
 */
export const KRYSTAL_TARGETS_ROBINHOOD_UNISWAP_V3 = {
  v3utils: '0xb4acbc082b5e7ded571c98ee4257778a9d784b36' as Address,
  positionManager: '0x73991a25c818bf1f1128deaab1492d45638de0d3' as Address,
} as const;

export const ROBINHOOD_UNISWAP_V3_TARGETS: readonly Address[] = [
  KRYSTAL_TARGETS_ROBINHOOD_UNISWAP_V3.v3utils,
  KRYSTAL_TARGETS_ROBINHOOD_UNISWAP_V3.positionManager,
];

/**
 * Selectors observed for each operation. Checked as a WARNING-FREE hard match
 * only when a caller opts in via `expectedSelectors`, because Krystal versions
 * its helper (`version=2` query param) and a legitimate upgrade would change
 * these. The destination allowlist is the load-bearing check; this is defence
 * in depth against a response that is well-formed but for the wrong operation.
 */
export const OBSERVED_SELECTORS: Record<LpTxnKind, `0x${string}`> = {
  compound: '0xb88d4fde',
  adjust_range: '0xb88d4fde',
  withdraw_and_swap: '0xb88d4fde',
  swap_and_mint: '0x954543e6',
  swap_and_increase: '0x3dce3e25',
};

/**
 * Parse a quantity Krystal returned as a hex string.
 *
 * Krystal is INCONSISTENT about this across its own endpoints, verified live:
 *   swap_and_mint / swap_and_increase -> value: "0x0"
 *   compound / adjust_range / withdraw_and_swap -> value: ""   (empty string!)
 *   native-token zap-in -> value: "0x38d7ea4c68000"  (= 1e15 wei, non-zero)
 *
 * `BigInt('')` throws and `Number('')` is 0, so the empty case must be handled
 * explicitly. It is treated as zero ONLY because we confirmed those three
 * endpoints send no native value; anything else non-hex is an error.
 */
export function parseHexQuantity(raw: unknown, field: string): bigint {
  if (typeof raw !== 'string') {
    throw new CalldataValidationError(field, raw, 'is not a string');
  }
  const trimmed = raw.trim();
  if (trimmed === '') return 0n;
  if (!/^0x[0-9a-fA-F]+$/.test(trimmed)) {
    throw new CalldataValidationError(field, raw, 'is not a hex quantity');
  }
  return BigInt(trimmed);
}

/** Optional hex quantity: returns null when absent/empty rather than a fake 0. */
export function parseOptionalHexQuantity(raw: unknown, field: string): bigint | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  return parseHexQuantity(raw, field);
}

function requireAddressField(raw: unknown, field: string): Address {
  if (typeof raw !== 'string') throw new CalldataValidationError(field, raw, 'is not a string');
  if (!ADDRESS.test(raw)) throw new CalldataValidationError(field, raw, 'is not a 20-byte address');
  return raw.toLowerCase() as Address;
}

export interface ValidateOptions {
  kind: LpTxnKind;
  policy: CalldataPolicy;
  /** When true, require the selector to match `OBSERVED_SELECTORS[kind]`. */
  enforceSelector?: boolean;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/**
 * Validate a raw Krystal `lp_transaction/*` response and produce an inert
 * `PreparedTransaction`. Throws `CalldataValidationError` on any failure.
 *
 * Checks, in order:
 *   1. envelope is an object with a `txData` object
 *   2. `to` is a well-formed address AND is on the destination allowlist
 *   3. `from` matches the Safe we intend to execute from
 *   4. `data` is well-formed hex, has a whole number of bytes, carries a 4-byte
 *      selector, and is not absurdly large
 *   5. `value` parses (including Krystal's "" case) and is within `maxValueWei`
 *   6. optional: selector matches the operation requested
 */
export function validateLpTxnResponse(raw: unknown, options: ValidateOptions): PreparedTransaction {
  const { kind, policy } = options;
  const now = options.now ?? Date.now;

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CalldataValidationError('response', raw, 'is not an object');
  }
  const envelope = raw as Record<string, unknown>;

  const txDataRaw = envelope.txData;
  if (typeof txDataRaw !== 'object' || txDataRaw === null || Array.isArray(txDataRaw)) {
    throw new CalldataValidationError('txData', txDataRaw, 'is missing or not an object');
  }
  const txData = txDataRaw as Record<string, unknown>;

  // --- 2. destination allowlist -------------------------------------------
  // The single most important check in this file. Everything else limits the
  // damage; this one decides which contract gets to move the funds at all.
  const to = requireAddressField(txData.to, 'txData.to');
  const allowed = policy.allowedTargets.map((address) => address.toLowerCase());
  if (!allowed.includes(to)) {
    throw new CalldataValidationError(
      'txData.to',
      to,
      `is not on the destination allowlist [${allowed.join(', ')}]`,
    );
  }

  // --- 3. the transaction must be built for OUR account -------------------
  const from = requireAddressField(txData.from, 'txData.from');
  if (from !== policy.expectedFrom.toLowerCase()) {
    throw new CalldataValidationError(
      'txData.from',
      from,
      `was built for a different account (expected ${policy.expectedFrom})`,
    );
  }

  // --- 4. calldata well-formedness ----------------------------------------
  const dataRaw = txData.data;
  if (typeof dataRaw !== 'string') {
    throw new CalldataValidationError('txData.data', dataRaw, 'is not a string');
  }
  if (!HEX_DATA.test(dataRaw)) {
    throw new CalldataValidationError('txData.data', dataRaw.slice(0, 24), 'is not 0x-prefixed hex');
  }
  const hexBody = dataRaw.slice(2);
  if (hexBody.length % 2 !== 0) {
    throw new CalldataValidationError('txData.data', hexBody.length, 'has an odd number of hex digits');
  }
  if (hexBody.length < 8) {
    throw new CalldataValidationError('txData.data', hexBody.length, 'is shorter than a 4-byte selector');
  }
  const maxBytes = policy.maxDataBytes ?? DEFAULT_MAX_DATA_BYTES;
  if (hexBody.length / 2 > maxBytes) {
    throw new CalldataValidationError('txData.data', hexBody.length / 2, `exceeds ${maxBytes} bytes`);
  }
  const data = `0x${hexBody.toLowerCase()}` as `0x${string}`;
  const selector = data.slice(0, 10) as `0x${string}`;

  if (options.enforceSelector === true && selector !== OBSERVED_SELECTORS[kind]) {
    throw new CalldataValidationError(
      'txData.data',
      selector,
      `is not the selector observed for ${kind} (${OBSERVED_SELECTORS[kind]})`,
    );
  }

  // --- 5. native value bounds ---------------------------------------------
  // Non-zero only for native-token zap-ins, where it equals amountIn.
  const value = parseHexQuantity(txData.value, 'txData.value');
  if (value < 0n) throw new CalldataValidationError('txData.value', value, 'is negative');
  if (value > policy.maxValueWei) {
    throw new CalldataValidationError(
      'txData.value',
      value.toString(),
      `exceeds the per-transaction cap of ${policy.maxValueWei.toString()} wei`,
    );
  }

  const meta: PreparedTransactionMeta = {
    kind,
    chainId: policy.chainId,
    platform: policy.platform,
    from,
    selector,
    estimateGas: parseOptionalHexQuantity(txData.estimateGas, 'txData.estimateGas'),
    gasLimit: parseOptionalHexQuantity(txData.gasLimit, 'txData.gasLimit'),
    usedDefaultGas: txData.usedDefaultGas === true,
    builtAt: now(),
    txInfo: envelope.txInfo ?? null,
  };

  return Object.freeze({ to, value, data, meta });
}
