// Lifecycle orchestration (LP_AUTOMATION_PLAN.md §2, §7) — the runtime loop
// that turns the built components into a running process.
//
// Typical wiring lives in `src/index.ts`. The short version:
//
//   const loop = new LifecycleLoop({
//     policySource, positions, calldata, signer, audit, createWatcher, logger,
//   });
//   await loop.start();      // recovers from the audit log, then watches
//   await loop.stop();       // on SIGINT/SIGTERM
//
// Read `loop.ts`'s header before changing the order of anything: the sequence
// guards -> dry run -> intent -> submit -> outcome is the safety property, not
// an implementation detail.

export { LifecycleLoop, type LifecycleDeps, type LifecycleOptions } from './loop.js';
export { ActionExecutor, type ExecutorDeps } from './executor.js';
export { PositionLocks } from './locks.js';
export {
  Quarantine,
  deriveLastCompounded,
  type UnresolvedIntent,
} from './unresolved.js';
export {
  MAX_TICK,
  MIN_TICK,
  TICK_SPACING_BY_FEE_BPS,
  recenterRange,
  type RecenterResult,
  type TickRange,
} from './range.js';
export {
  FilePolicySource,
  KrystalCalldataBuilder,
  KrystalPositionFeed,
  type KrystalCalldataOptions,
  type KrystalPositionFeedOptions,
} from './adapters.js';
export type {
  ActionResult,
  AuditPort,
  CalldataBuilder,
  Clock,
  ExecutableAction,
  IdFactory,
  Logger,
  PolicyBundle,
  PolicySource,
  PositionFeed,
  PositionWatcher,
  Refusal,
  WatcherFactory,
} from './types.js';
