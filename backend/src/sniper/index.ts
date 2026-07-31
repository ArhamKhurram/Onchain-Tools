// Public surface of the sniper module. M1: the fire path in dry-run.
//
// Not yet wired into backend/src/index.ts — that (the live J7 feed, the tweet
// handler, per-user gateways) is a later milestone. This barrel keeps the module
// self-contained and testable in isolation, matching how backend/src/fomo is
// composed rather than imported piecemeal.

export * from './types.js';
export { ruleMatchesTweet, matchesText, validateMatcher, MATCHER_MAX_DEPTH, MATCHER_MAX_NODES } from './matcher.js';
export { IdempotencyLedger, triggerKey, contentHash } from './idempotency.js';
export { InMemorySniperStore, utcDay } from './store.js';
export type { WalletConfig, FireRecord } from './store.js';
export { computeLegs } from './legs.js';
export { estimateFees } from './fees.js';
export { executeFire } from './executeFire.js';
export type { FireResult, LegResult, LegState, FireDeps } from './executeFire.js';
export { ExecutorRegistry, processDryRun } from './executors/registry.js';
export { DryRunExecutor } from './executors/dryRun.js';
export { SlotsharkExecutor, extractSignature } from './executors/slotshark.js';
export type { SlotsharkConfig, SlotsharkRegion } from './executors/slotshark.js';
export { getVenueSecret, storeVenueSecretAsService } from './venueCredentials.js';
