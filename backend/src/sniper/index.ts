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
