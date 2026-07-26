// Calldata layer (plan §3, §7).
//
// Krystal builds the transaction; we validate it; the signer (plan §4) executes
// it behind the Safe + Guard. Nothing exported from here can sign or broadcast.

export {
  LP_TXN_PATHS,
  type CalldataPolicy,
  type LpTxnKind,
  type PreparedTransaction,
  type PreparedTransactionMeta,
} from './types.js';

export {
  CalldataValidationError,
  KRYSTAL_TARGETS_ROBINHOOD_UNISWAP_V3,
  OBSERVED_SELECTORS,
  ROBINHOOD_UNISWAP_V3_TARGETS,
  parseHexQuantity,
  parseOptionalHexQuantity,
  validateLpTxnResponse,
  type ValidateOptions,
} from './validate.js';

export {
  buildAdjustRange,
  buildCompound,
  buildSwapAndIncrease,
  buildSwapAndMint,
  buildWithdrawAndSwap,
  slippageFraction,
  type AdjustRangeParams,
  type CompoundParams,
  type LpTxnContext,
  type SwapAndIncreaseParams,
  type SwapAndMintParams,
  type WithdrawAndSwapParams,
} from './lpTxn.js';

export {
  dryRun,
  type DryRunOptions,
  type DryRunResult,
  type EthCallCapableClient,
} from './dryRun.js';
