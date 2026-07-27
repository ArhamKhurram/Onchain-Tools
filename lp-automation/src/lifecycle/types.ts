// Ports the lifecycle loop runs against (LP_AUTOMATION_PLAN.md §2, §7).
//
// The loop is the only component in this workspace that TOUCHES EVERYTHING —
// chain watch, Krystal, rules, calldata, audit, signer. That makes it the one
// place where an accidental dependency turns the whole process into something
// that can only be tested against a live chain with a funded key. So every
// outward-facing collaborator is declared here as a narrow interface and
// injected; `src/lifecycle/adapters/` holds the real implementations and is the
// only lifecycle code that performs I/O.
//
// The signer is the sharpest case: the loop consumes `TransactionSigner` from
// `src/signer/types.ts` and nothing else from that directory. It never
// constructs an account, a wallet client, or a key. If you find yourself
// importing anything else from `src/signer/`, the seam has been broken.

import type { AuditRecord, OutcomeSnapshotExtra, PendingAction } from '../audit/log.js';
import type { PreparedTransaction } from '../calldata/types.js';
import type { PoolWatcherCallbacks, WatchedRange, WatcherStatus } from '../ingest/rpc/types.js';
// The ONLY import from `src/signer/` anywhere in `src/lifecycle/`. It is a
// type-only import of the seam file, which is itself dependency-free.
import type { SubmitOutcome } from '../signer/types.js';
import type { Address, AutomationPolicy, Decision, LpPosition } from '../types.js';

/** Injectable clock. Every timestamp in the loop comes through one of these. */
export type Clock = () => number;

/** Correlation-id factory. One id ties an intent record to its outcome record. */
export type IdFactory = () => string;

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * The append-only audit log, as the loop needs it.
 *
 * Structurally satisfied by `AuditLog` from `src/audit/log.ts`. Declared as a
 * port rather than imported as a class so the tests can make a write FAIL —
 * "the intent write failed, therefore we must not broadcast" is a behaviour
 * that cannot be exercised against a real filesystem without contriving one.
 */
export interface AuditPort {
  read(): Promise<{ records: AuditRecord[]; malformed: string[] }>;
  recordIntent(pending: PendingAction): Promise<void>;
  recordOutcome(
    pending: PendingAction,
    outcome: { txHash: string | null; error: string | null },
    now: number,
    outcomeSnapshot?: OutcomeSnapshotExtra,
  ): Promise<void>;
  recordEvaluation(decision: Decision, id: string, now: number): Promise<void>;
}

/**
 * Policy as the process sees it: a set of versions plus the per-position
 * pinning that `src/policy/versioning.ts` resolves against.
 *
 * A position with no binding inherits the current default (source §5.1). A
 * position WITH a binding is resolved strictly — an unknown or duplicated
 * version stops that position rather than falling back to the newest policy,
 * which is the retroactive-application bug `versioning.ts` exists to prevent.
 */
export interface PolicyBundle {
  policies: AutomationPolicy[];
  /** tokenId -> pinned policy version. Absent means "inherit the default". */
  bindings: Record<string, number>;
}

export interface PolicySource {
  load(): Promise<PolicyBundle>;
}

/** The slow lane: fees, TVL and position state from Krystal (plan §2). */
export interface PositionFeed {
  /**
   * Current open positions. Implementations MUST supply `currentTick` from the
   * chain, never from Krystal's cached `pool.price` (plan §3, and the header of
   * `ingest/krystal/positions.ts`). A position whose tick cannot be read is
   * omitted, not guessed.
   */
  loadPositions(): Promise<LpPosition[]>;
}

/**
 * Calldata construction, narrowed to the operations the loop can currently
 * perform. Krystal builds it; this port never signs and never broadcasts.
 */
export interface CalldataBuilder {
  compound(request: {
    position: LpPosition;
    policy: AutomationPolicy;
  }): Promise<PreparedTransaction>;
  rebalance(request: {
    position: LpPosition;
    policy: AutomationPolicy;
    tickLower: number;
    tickUpper: number;
  }): Promise<PreparedTransaction>;
  /**
   * Exit: withdraw the position and swap out to a single token.
   *
   * OPTIONAL, and deliberately unimplemented by `KrystalCalldataBuilder` today.
   * Krystal's `withdraw_and_swap` requires a `targetToken` — WHICH token the
   * operator wants to be left holding — and nothing in the policy schema (plan
   * §5) expresses that. Token ordering in a pool is by address, not by role, so
   * picking `token1` because it "looks like the quote token" would be a coin
   * flip between exiting into a stable and exiting into the volatile side.
   *
   * A manual exit command therefore reaches the loop and is REFUSED with that
   * reason recorded, rather than executed on a guess. The seam exists here so
   * wiring it up later is an adapter change and a policy field, not a change to
   * the execution path — and so the tests can exercise the full guard ladder
   * for `exit` without a real builder.
   */
  exit?(request: {
    position: LpPosition;
    policy: AutomationPolicy;
  }): Promise<PreparedTransaction>;
  /**
   * Enter: zap into a BRAND-NEW position (Krystal `swap_and_mint`).
   *
   * OPTIONAL for the same structural reason as `exit?`: a `CalldataBuilder` used
   * in a test need not implement it, and the loop refuses a manual enter with a
   * recorded reason when it is absent, rather than throwing. Unlike the other
   * operations there is no `position` — the position does not exist yet — so the
   * pool, the input token + amount and the target ticks are all passed
   * explicitly. The ticks are computed by the loop from the pool's LIVE on-chain
   * tick (see `PoolStateReader`), never from a cached price.
   */
  enter?(request: {
    poolAddress: Address;
    tokenInAddress: Address;
    /** Raw base units, decimal string. Never a JS number — precision loss. */
    amountIn: string;
    tickLower: number;
    tickUpper: number;
    /** Per-enter slippage override (fraction). Absent uses the builder default. */
    swapSlippage?: number;
  }): Promise<PreparedTransaction>;
  /**
   * Increase: zap more liquidity into an EXISTING position (Krystal `swap_and_increase`).
   */
  increase?(request: {
    position: LpPosition;
    tokenInAddress: Address;
    amountIn: string;
    swapSlippage?: number;
  }): Promise<PreparedTransaction>;
}

/**
 * The authoritative on-chain state of a pool, read for an enter.
 *
 * `feeUnits` is Uniswap's on-chain fee unit (10000 == 1%), read from the pool's
 * `fee()` — the same unit `TICK_SPACING_BY_FEE_BPS` is keyed by, so it maps to a
 * tick spacing without conversion. `currentTick` is `slot0().tick`, the same
 * value the range-exit watcher trusts (plan §3).
 */
export interface PoolState {
  currentTick: number;
  feeUnits: number;
  token0: Address;
  token1: Address;
}

/**
 * Reads {@link PoolState} for a pool. RPC-backed in production; a fake in tests.
 * Kept a narrow port for the same reason `readTick` is on the position feed:
 * enter must not be forced to run against a live chain to be tested.
 */
export interface PoolStateReader {
  readPoolState(pool: Address): Promise<PoolState>;
}

/**
 * The chain watcher, as the loop uses it. `PoolWatcher` satisfies this
 * structurally. Callbacks are constructor-time on the real watcher, hence the
 * factory shape rather than an `on(...)` method.
 */
export interface PositionWatcher {
  start(): void;
  stop(): void;
  setWatched(ranges: readonly WatchedRange[]): void;
  getStatus(): WatcherStatus;
}

export type WatcherFactory = (callbacks: PoolWatcherCallbacks) => PositionWatcher;

/** Actions the loop can actually take. `none` is a decision, not an action. */
export type ExecutableAction = 'compound' | 'rebalance' | 'exit' | 'enter' | 'increase' | 'approve';

/**
 * Why an action was refused before it reached the signer. Each maps to an audit
 * entry with `action: 'none'`, so a refusal is as visible in the log as a
 * completed transaction.
 */
export interface Refusal {
  rule: string;
  reason: string;
}

/** What was written (or would have been written) to the audit outcome record. */
export interface RecordedOutcome {
  txHash: string | null;
  error: string | null;
}

export type ActionResult =
  /** Reached the signer. `recorded` is the chain-confirmed audit outcome. */
  | { status: 'submitted'; auditId: string; outcome: SubmitOutcome; recorded: RecordedOutcome }
  /** Refused before any intent was written. Nothing is in flight. */
  | { status: 'refused'; refusal: Refusal }
  /** The dry run said this would fail. Nothing is in flight. */
  | { status: 'simulation_failed'; refusal: Refusal }
  /**
   * The intent write failed, so the broadcast was NOT attempted. This is the
   * fail-closed path: an unlogged transaction over real funds is worse than a
   * missed opportunity (`audit/log.ts`).
   */
  | { status: 'intent_write_failed'; error: string }
  /**
   * The transaction was submitted but its outcome could not be recorded. The
   * intent is now UNRESOLVED on disk and the next startup will quarantine this
   * position. That is the intended behaviour, not a leak.
   */
  | {
      status: 'outcome_write_failed';
      auditId: string;
      outcome: SubmitOutcome;
      recorded: RecordedOutcome;
      error: string;
    };
