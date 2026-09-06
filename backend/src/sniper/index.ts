// Public surface of the sniper module.
//
// Composed as a self-contained module (matching backend/src/fomo) rather than
// imported piecemeal. It IS wired into backend/src/index.ts now, but only via
// the control plane at /sniper/v1 (api/sniper/router.ts) — there is still no
// tweet feed, so nothing in this module fires on its own. Every fire is a human
// pressing a button behind a typed confirmation.

export * from './types.js';
export { ruleMatchesTweet, matchesText, validateMatcher, MATCHER_MAX_DEPTH, MATCHER_MAX_NODES } from './matcher.js';
export { IdempotencyLedger, triggerKey, contentHash } from './idempotency.js';
export { InMemorySniperStore, utcDay } from './store.js';
export type { SniperStore, KillState, ReserveParams, ReleaseParams, ResolveFireParams } from './storeInterface.js';
export { getSniperStore, setSniperStore, JsonSniperStore, SupabaseSniperStore, resetLocalSniperCache } from './stores/index.js';
export { getSniperRuntime, setSniperRuntime } from './runtime.js';
export type { SniperRuntime } from './runtime.js';
export { computeLegs, validateLadderSplit, MAX_LADDER_LEGS } from './legs.js';
export { estimateFees } from './fees.js';
export { validateRule, validateRuleStructure } from './validateRule.js';
export type { ValidationReason, ValidationResult } from './validateRule.js';
export { isLinearSafeRegex } from './regexGuard.js';
export { executeFire } from './executeFire.js';
export type { FireResult, LegResult, LegState, FireDeps } from './executeFire.js';
export { fireRuleNow } from './fireOrchestrator.js';
export type { FireRuleNowParams, PreflightReason } from './fireOrchestrator.js';
export { ExecutorRegistry, processDryRun } from './executors/registry.js';
export { DryRunExecutor } from './executors/dryRun.js';
export { SlotsharkExecutor, extractSignature, narrowRegion, REGION_BASE_URLS } from './executors/slotshark.js';
export type { SlotsharkConfig, SlotsharkRegion } from './executors/slotshark.js';
// Slotshark's dashboard API: wallets, and the Twitter Sniper configs that drive
// the tweet -> buy loop INSIDE Slotshark. Authoring one still does not put OCT
// in that loop — no callback reaches us, so OCT's caps bind console fires only.
// (`executors/slotsharkTriggers.ts` was the placeholder for this before
// Slotshark published the docs on 2026-08-08; it is superseded and gone.)
export { SlotsharkDashboard, VendorAuthError, VendorContractError, VendorRequestError } from './venue/slotsharkDashboard.js';
export type { SlotsharkDashboardConfig, VenueWallet, VenueWalletBalance, VenueTwitterConfig } from './venue/slotsharkDashboard.js';
export {
  buildFullBody,
  buildPatchBody,
  normalizeHandle,
  TwitterConfigValidationError,
  TWITTER_MODES,
  SNIPE_PLATFORMS,
} from './venue/slotsharkTwitterConfig.js';
export type {
  TwitterMode,
  TwitterConfigInput,
  TwitterConfigPatch,
  TwitterConfigReason,
  TwitterConfigResult,
  TwitterSizing,
  FollowUnfollowSizing,
  ArrayReplacement,
  SnipeParams,
  SnipeParamsPatch,
  LimitSell,
  SnipePlatform,
} from './venue/slotsharkTwitterConfig.js';
export type { SniperReconciler, ReconciledFill } from './reconcile.js';
export { getVenueSecret, getVenueConnection, storeVenueSecretAsService } from './venueCredentials.js';
export type { VenueConnection } from './venueCredentials.js';

// --- EVM venue: Robinhood Chain (chainId 4663), Uniswap V3 + V4 -------------
//
// Non-custodial, unlike Slotshark: OCT signs with a key read from the process
// environment at fire time. The whole read path (routing, both pre-trade gates)
// works with no key at all, which is what makes the module testable and
// dry-runnable before one exists.
export {
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_DEFAULT_RPC_URL,
  robinhoodChain,
  WETH_ADDRESS,
  UNISWAP_V3_FACTORY,
  UNISWAP_SWAP_ROUTER_02,
  UNISWAP_UNIVERSAL_ROUTER,
  UNISWAP_V4_POOL_MANAGER,
  DEXSCREENER_CHAIN_SLUG,
} from './evm/chain.js';
export {
  readEvmSniperConfig,
  hasEvmSigningKey,
  parseAmount,
  parseIntIn,
  parseGateEnabled,
  parseTriggerChatIds,
  parseAddress,
  parseRpcUrl,
  DEFAULT_BUY_ETH,
  DEFAULT_DAILY_CAP_ETH,
  DEFAULT_SLIPPAGE_BPS,
  DEFAULT_MIN_LIQUIDITY_USD,
  DEFAULT_MIN_ROUNDTRIP_BPS,
  DEFAULT_DEADLINE_SECONDS,
  MAX_BUY_ETH,
  MAX_DAILY_CAP_ETH,
} from './evm/config.js';
export type { EvmSniperConfig, EnvBag } from './evm/config.js';
export { makeHttpEvmRpc, EvmRpcError } from './evm/rpc.js';
export type { EvmRpc, SimCall, SimCallResult, SimStateOverride } from './evm/rpc.js';
export {
  classifyPool,
  rankPools,
  bestRoutable,
  resolveRoute,
  parseDexScreenerPools,
  fetchDexScreenerPools,
  readV3Fee,
  readV4PoolKey,
  describeCandidates,
} from './evm/routing.js';
export type {
  DiscoveredPool,
  PoolCandidate,
  PoolFamily,
  PoolFetcher,
  Route,
  RoutingDecision,
  UnroutableReason,
  V4PoolKey,
} from './evm/routing.js';
export { buildBuyTx, buildSellTx, buildSellApprovals, applySlippage, PERMIT2_ADDRESS } from './evm/swap.js';
export type { SwapTx, BuildSwapParams } from './evm/swap.js';
export { runPreTradeGates, SIMULATION_SENDER } from './evm/gates.js';
export type { GateParams, GateResult, GateRejection } from './evm/gates.js';
export { EvmUniswapExecutor, ethToWei, classifySendFailure } from './executors/evmUniswap.js';
export type { EvmUniswapConfig } from './executors/evmUniswap.js';
export {
  createTelegramEvmTrigger,
  createProcessTelegramEvmTrigger,
  buildEvmRule,
  buildEvmWallet,
  ensureEvmWallet,
  extractEvmTokens,
  isTriggerChat,
  toTokenTrigger,
  EVM_RULE_ID,
  EVM_WALLET_ID,
} from './triggers/telegramChannel.js';
export type { EvmTriggerDeps } from './triggers/telegramChannel.js';
