// Krystal `lp_transaction/*` wrappers (plan §3, §7).
//
// CUSTODY BOUNDARY: Krystal only ever returns calldata. It never signs, never
// holds funds, and never sees a key. Nothing in this module may construct a
// signer/account/wallet client, read a private key from anywhere, or broadcast.
// Every function here returns an inert `PreparedTransaction` and nothing else.
// If a future change needs to send a transaction, it belongs in `src/signer/`
// behind the Safe + Guard — not here.
//
// Every response passes through `validateLpTxnResponse` before it is returned.
// There is no code path in this file that yields unvalidated Krystal output.
//
// PARAMETER UNITS — verified against the live API, because the docs do not say:
//
//   swapSlippage / liquiditySlippage / withdrawSlippage are FRACTIONS, not
//   percent and not basis points. The server rejects >= 1 with
//   "slippage must be < 100 percent", and 0.005 is accepted and behaves as
//   0.5%. Passing `50` meaning "50 bps" is a 400; passing `0.5` silently means
//   FIFTY PERCENT. `slippageFraction` below exists so this cannot be fumbled.
//
//   liquidityPercent (withdraw_and_swap) is likewise a fraction: 1 = 100%.

import type { Address } from '../types.js';
import { getKrystalClient, type KrystalClient } from '../ingest/krystal/client.js';
import { LP_TXN_PATHS, type CalldataPolicy, type PreparedTransaction } from './types.js';
import { CalldataValidationError, validateLpTxnResponse } from './validate.js';

/** Largest slippage we will ever ask Krystal for: 5%. */
const MAX_SLIPPAGE_FRACTION = 0.05;

export interface LpTxnContext {
  policy: CalldataPolicy;
  client?: KrystalClient;
  /**
   * Krystal's fee-attribution wallet. MUST NOT be the zero address —
   * Cloudflare 403s any query string containing it (see `assertNoWafTripwire`).
   * Defaults to the Safe, which is always non-zero and attributes to ourselves.
   */
  platformWallet?: Address;
  /** Hard-require the operation's observed selector. Off by default (Krystal versions v3utils). */
  enforceSelector?: boolean;
}

/**
 * Guard slippage at the call site. A slippage figure that is out by 100x is a
 * direct, silent loss of funds — the transaction succeeds, it just executes at a
 * terrible price, so neither the dry-run nor the Guard would flag it.
 */
export function slippageFraction(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new CalldataValidationError(field, value, 'is not a finite number');
  }
  if (value <= 0) {
    throw new CalldataValidationError(field, value, 'must be greater than 0');
  }
  if (value > MAX_SLIPPAGE_FRACTION) {
    throw new CalldataValidationError(
      field,
      value,
      `exceeds the ${MAX_SLIPPAGE_FRACTION} (${MAX_SLIPPAGE_FRACTION * 100}%) ceiling. ` +
        'Krystal expects a FRACTION: 0.005 is 0.5%, 0.5 is 50%.',
    );
  }
  return value;
}

function assertPositiveIntegerString(value: string, field: string): string {
  if (!/^\d+$/.test(value)) {
    throw new CalldataValidationError(field, value, 'is not a non-negative integer string');
  }
  return value;
}

function assertTick(value: number, field: string): number {
  if (!Number.isInteger(value)) {
    throw new CalldataValidationError(field, value, 'is not an integer tick');
  }
  // Uniswap V3 hard bounds.
  if (value < -887272 || value > 887272) {
    throw new CalldataValidationError(field, value, 'is outside the Uniswap V3 tick range');
  }
  return value;
}

function baseQuery(context: LpTxnContext): Record<string, string | number> {
  return {
    platform: context.policy.platform,
    chainId: context.policy.chainId,
    userAddress: context.policy.expectedFrom,
    platformWallet: context.platformWallet ?? context.policy.expectedFrom,
  };
}

async function build(
  kind: keyof typeof LP_TXN_PATHS,
  context: LpTxnContext,
  query: Record<string, string | number>,
): Promise<PreparedTransaction> {
  const client = context.client ?? getKrystalClient();
  const raw = await client.getJson(LP_TXN_PATHS[kind], { ...baseQuery(context), ...query });
  return validateLpTxnResponse(raw, {
    kind,
    policy: context.policy,
    ...(context.enforceSelector === undefined ? {} : { enforceSelector: context.enforceSelector }),
  });
}

export interface CompoundParams {
  tokenId: string;
  swapSlippage: number;
  liquiditySlippage: number;
  /** Receive native instead of wrapped. Krystal defaults to false. */
  unwrap?: boolean;
}

/** Compound accrued fees back into an existing position (plan §7). */
export function buildCompound(
  context: LpTxnContext,
  params: CompoundParams,
): Promise<PreparedTransaction> {
  return build('compound', context, {
    tokenId: assertPositiveIntegerString(params.tokenId, 'tokenId'),
    swapSlippage: slippageFraction(params.swapSlippage, 'swapSlippage'),
    liquiditySlippage: slippageFraction(params.liquiditySlippage, 'liquiditySlippage'),
    ...(params.unwrap === undefined ? {} : { unwrap: String(params.unwrap) }),
  });
}

export interface AdjustRangeParams {
  tokenId: string;
  newTickLower: number;
  newTickUpper: number;
  swapSlippage: number;
  liquiditySlippage: number;
  unwrap?: boolean;
}

/** Rebalance: move an existing position to a new tick range (plan §7). */
export function buildAdjustRange(
  context: LpTxnContext,
  params: AdjustRangeParams,
): Promise<PreparedTransaction> {
  const lower = assertTick(params.newTickLower, 'newTickLower');
  const upper = assertTick(params.newTickUpper, 'newTickUpper');
  if (upper <= lower) {
    throw new CalldataValidationError('newTickUpper', upper, 'is not above newTickLower');
  }
  return build('adjust_range', context, {
    tokenId: assertPositiveIntegerString(params.tokenId, 'tokenId'),
    newTickLower: lower,
    newTickUpper: upper,
    swapSlippage: slippageFraction(params.swapSlippage, 'swapSlippage'),
    liquiditySlippage: slippageFraction(params.liquiditySlippage, 'liquiditySlippage'),
    ...(params.unwrap === undefined ? {} : { unwrap: String(params.unwrap) }),
  });
}

export interface SwapAndMintParams {
  poolAddress: Address;
  tickLower: number;
  tickUpper: number;
  tokenInAddress: Address;
  /** Raw base units, as a decimal string. Never a JS number — precision loss. */
  amountIn: string;
  swapSlippage: number;
  liquiditySlippage: number;
}

/** Enter: zap into a brand-new position (plan §7). */
export function buildSwapAndMint(
  context: LpTxnContext,
  params: SwapAndMintParams,
): Promise<PreparedTransaction> {
  const lower = assertTick(params.tickLower, 'tickLower');
  const upper = assertTick(params.tickUpper, 'tickUpper');
  if (upper <= lower) {
    throw new CalldataValidationError('tickUpper', upper, 'is not above tickLower');
  }
  return build('swap_and_mint', context, {
    poolAddress: params.poolAddress,
    tickLower: lower,
    tickUpper: upper,
    tokenInAddress: params.tokenInAddress,
    amountIn: assertPositiveIntegerString(params.amountIn, 'amountIn'),
    swapSlippage: slippageFraction(params.swapSlippage, 'swapSlippage'),
    liquiditySlippage: slippageFraction(params.liquiditySlippage, 'liquiditySlippage'),
  });
}

export interface SwapAndIncreaseParams {
  tokenId: string;
  tokenInAddress: Address;
  amountIn: string;
  swapSlippage: number;
  liquiditySlippage: number;
}

/** Add liquidity to an existing position (plan §7). */
export function buildSwapAndIncrease(
  context: LpTxnContext,
  params: SwapAndIncreaseParams,
): Promise<PreparedTransaction> {
  return build('swap_and_increase', context, {
    tokenId: assertPositiveIntegerString(params.tokenId, 'tokenId'),
    tokenInAddress: params.tokenInAddress,
    amountIn: assertPositiveIntegerString(params.amountIn, 'amountIn'),
    swapSlippage: slippageFraction(params.swapSlippage, 'swapSlippage'),
    liquiditySlippage: slippageFraction(params.liquiditySlippage, 'liquiditySlippage'),
  });
}

export interface WithdrawAndSwapParams {
  tokenId: string;
  targetToken: Address;
  /** Fraction of liquidity to withdraw: 1 = 100%. */
  liquidityPercent: number;
  swapSlippage: number;
  withdrawSlippage?: number;
  unwrap?: boolean;
}

/** Exit: withdraw liquidity and swap out to a single token (plan §7). */
export function buildWithdrawAndSwap(
  context: LpTxnContext,
  params: WithdrawAndSwapParams,
): Promise<PreparedTransaction> {
  const { liquidityPercent } = params;
  if (!Number.isFinite(liquidityPercent) || liquidityPercent <= 0 || liquidityPercent > 1) {
    throw new CalldataValidationError(
      'liquidityPercent',
      liquidityPercent,
      'must be a fraction in (0, 1]; 1 means withdraw 100%',
    );
  }
  return build('withdraw_and_swap', context, {
    tokenId: assertPositiveIntegerString(params.tokenId, 'tokenId'),
    targetToken: params.targetToken,
    liquidityPercent,
    swapSlippage: slippageFraction(params.swapSlippage, 'swapSlippage'),
    ...(params.withdrawSlippage === undefined
      ? {}
      : { withdrawSlippage: slippageFraction(params.withdrawSlippage, 'withdrawSlippage') }),
    ...(params.unwrap === undefined ? {} : { unwrap: String(params.unwrap) }),
  });
}
