// The runtime loop (LP_AUTOMATION_PLAN.md §2, §7). This is the process.
//
// ---------------------------------------------------------------------------
// TWO SPEEDS, ONE EXECUTION PATH
// ---------------------------------------------------------------------------
//
//   RPC watcher (crossings) ─┐
//   Krystal poll (fees/TVL) ─┼─> evaluate (rules) ─> build calldata (Krystal)
//                             │     ─> dry run ─> audit intent ─> signer.submit
//                             │                              ─> audit outcome
//
// The fast lane exists because Krystal's REST API cannot tell us "price just
// left the range" in under a second; the slow lane exists because the chain
// cannot tell us what fees have accrued in USD. Neither is a fallback for the
// other. They meet at `act()`, which is the single funnel every action passes
// through — one lock, one guard set, one audit path.
//
// ---------------------------------------------------------------------------
// `observed` WARMS, `confirmed` ACTS
// ---------------------------------------------------------------------------
// The watcher emits every crossing twice: `observed` at the chain head, then
// `confirmed` once it still holds at depth (or `reverted` if it did not). An
// `observed` crossing is explicitly documented as safe for speculative work and
// NOT for broadcasting, because a reorg can take it back
// (`ingest/rpc/poolWatcher.ts` header).
//
// So `observed` does everything except sign: resolve the policy, run the rule,
// build the calldata, and park it. `confirmed` then reuses that calldata if it
// is still fresh, which is where the latency saving actually comes from — the
// Krystal round trip has already happened by the time the crossing confirms.
// `reverted` throws the parked calldata away. Nothing in the `observed` path
// can reach `signer.submit`; the only call site is `act()`, and only the
// `confirmed` branch calls it.
//
// ---------------------------------------------------------------------------
// EVERY TICK IS LOGGED
// ---------------------------------------------------------------------------
// Plan §6 requires the score and its inputs recorded at every evaluation tick,
// not just when something fires — otherwise a rule that never fires is
// indistinguishable from a rule that is broken. Two conventions keep that
// honest here:
//
//   * A tick that ACTS is recorded by the intent/outcome pair in
//     `ActionExecutor`, which carries the same `Decision`. Writing an
//     evaluation entry as well would double-count it in `summarize()`.
//   * A tick that does NOT act — including one whose rule fired but was
//     refused — is recorded via `recordEvaluation` with `action: 'none'` and
//     the original decision preserved in the snapshot. A refusal must never be
//     logged under the action it refused, or the log will read as though the
//     rebalance happened.

import { shouldCompound, shouldRebalance } from '../rules/index.js';
import type { PreparedTransaction } from '../calldata/types.js';
import { currentDefaultPolicy, resolvePolicyForPosition, validatePolicy } from '../policy/index.js';
import type {
  ConfirmedCrossing,
  CrossingEvent,
  ObservedCrossing,
  WatchedRange,
} from '../ingest/rpc/types.js';
import type { Erc20ReadClient } from '../calldata/erc20Approve.js';
import { ensureErc20Allowance, type EnsureAllowanceResult } from './allowance.js';
import type { TransactionSigner } from '../signer/types.js';
import { isPoolAllowed } from '../policy/pools.js';
import { ROBINHOOD_CHAIN_ID } from '../types.js';
import type { Address, AutomationPolicy, Decision, LpPosition, RangeStrategy } from '../types.js';
import type { CommandResult, CommandSource, LpCommand } from './commandSource.js';
import { ActionExecutor } from './executor.js';
import { PositionLocks } from './locks.js';
import { rangeFromCenter, recenterRange, type TickRange } from './range.js';
import { deriveLastCompounded, Quarantine } from './unresolved.js';
import type { AlertDispatcher } from '../alerts/dispatch.js';
import { OutOfRangeTracker } from '../alerts/outOfRange.js';
import type { LpAlertPayload } from '../alerts/types.js';
import type {
  ActionResult,
  AuditPort,
  CalldataBuilder,
  Clock,
  ExecutableAction,
  IdFactory,
  Logger,
  PolicyBundle,
  PolicySource,
  PoolState,
  PoolStateReader,
  PositionFeed,
  PositionWatcher,
  Refusal,
  WatcherFactory,
} from './types.js';

export interface LifecycleOptions {
  /** Krystal poll cadence — the slow lane. */
  positionPollIntervalMs?: number;
  /**
   * Manual-command poll cadence. Deliberately much shorter than the position
   * tick: a human pressed a button and is watching a spinner. It is cheap —
   * one indexed `status = 'pending'` read against our own database, not a
   * third-party API call — so it does not belong on the 60s Krystal cadence.
   */
  commandPollIntervalMs?: number;
  /** Parked calldata older than this is rebuilt rather than submitted. */
  calldataMaxAgeMs?: number;
  /**
   * Operator-supplied gas cost estimate in USD for one lifecycle transaction.
   *
   * `null` means UNKNOWN, and unknown is not free: `shouldCompound` refuses to
   * evaluate its fees-vs-gas arm without it, leaving only the interval
   * backstop. That is the honest degradation — see the report.
   */
  gasCostUsd?: number | null;
  alertOutOfRangeMinutes?: number;
  alertGasThresholdUsd?: number | null;
}

export interface AllowanceConfig {
  owner: Address;
  chainId: number;
  approvableTokens: readonly Address[];
  reader: Erc20ReadClient;
}

export interface LifecycleDeps {
  policySource: PolicySource;
  positions: PositionFeed;
  calldata: CalldataBuilder;
  /**
   * The dashboard's manual command queue. Absent means the feature is simply
   * off — the loop never polls and the automation behaves exactly as it did
   * before the queue existed. There is no inbound surface either way (plan §9
   * point 1); this process always reaches out.
   */
  commands?: CommandSource;
  signer: TransactionSigner;
  audit: AuditPort;
  /**
   * Reads a pool's live on-chain state (tick, fee, tokens). Required for `enter`
   * (Zap In) — the target ticks are computed from the pool's current tick, never
   * a cached price. Absent means enter is refused with a recorded reason, exactly
   * as an absent `calldata.enter` is.
   */
  poolState?: PoolStateReader;
  /**
   * ERC-20 approve pre-flight for zap flows (enter / increase). When absent,
   * those actions refuse with a recorded reason rather than failing at simulation.
   */
  allowance?: AllowanceConfig;
  /** Wait for a mined receipt after broadcast (chain confirmation + gas for PnL). */
  waitForReceipt?: (
    txHash: string,
  ) => Promise<
    | { status: 'success'; gasUsed: bigint; effectiveGasPrice: bigint }
    | { status: 'reverted' }
    | null
  >;
  /** Native token USD price — converts receipt gas to `gasSpentUsd`. */
  nativeTokenUsd?: number | null;
  alerts?: AlertDispatcher;
  createWatcher: WatcherFactory;
  logger: Logger;
  now?: Clock;
  newId?: IdFactory;
  options?: LifecycleOptions;
}

interface WarmCalldata {
  action: ExecutableAction;
  transaction: PreparedTransaction;
  decision: Decision;
}

const DEFAULTS = {
  positionPollIntervalMs: 60_000,
  commandPollIntervalMs: 5_000,
  calldataMaxAgeMs: 30_000,
} as const;

export class LifecycleLoop {
  private readonly deps: LifecycleDeps;
  private readonly now: Clock;
  private readonly newId: IdFactory;
  private readonly logger: Logger;
  private readonly locks = new PositionLocks();
  private readonly executor: ActionExecutor;
  private readonly positionPollIntervalMs: number;
  private readonly commandPollIntervalMs: number;
  private readonly calldataMaxAgeMs: number;
  private readonly gasCostUsd: number | null;
  private readonly alertOutOfRangeMinutes: number;
  private readonly alertGasThresholdUsd: number | null;
  private readonly alerts: AlertDispatcher | null;
  private readonly outOfRangeTracker = new OutOfRangeTracker();

  private quarantine = Quarantine.empty();
  private bundle: PolicyBundle = { policies: [], bindings: {} };
  private readonly positionsByToken = new Map<string, LpPosition>();
  private lastCompounded = new Map<string, number>();
  private readonly warm = new Map<string, WarmCalldata>();
  private readonly inflight = new Set<Promise<unknown>>();

  private watcher: PositionWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private commandTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * One command at a time, process-wide. The command tick is short, and a slow
   * action must not have a second tick claim another command underneath it —
   * the per-position lock protects one position, this protects the ordering the
   * operator sees.
   */
  private commandTickBusy = false;
  private running = false;
  private stopping = false;

  constructor(deps: LifecycleDeps) {
    this.deps = deps;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? defaultIdFactory;
    this.positionPollIntervalMs =
      deps.options?.positionPollIntervalMs ?? DEFAULTS.positionPollIntervalMs;
    this.commandPollIntervalMs =
      deps.options?.commandPollIntervalMs ?? DEFAULTS.commandPollIntervalMs;
    this.calldataMaxAgeMs = deps.options?.calldataMaxAgeMs ?? DEFAULTS.calldataMaxAgeMs;
    this.gasCostUsd = deps.options?.gasCostUsd ?? null;
    this.alertOutOfRangeMinutes = deps.options?.alertOutOfRangeMinutes ?? 0;
    this.alertGasThresholdUsd = deps.options?.alertGasThresholdUsd ?? null;
    this.alerts = deps.alerts ?? null;

    this.executor = new ActionExecutor({
      audit: deps.audit,
      signer: deps.signer,
      logger: this.logger,
      now: this.now,
      newId: this.newId,
      quarantine: () => this.quarantine,
      calldataMaxAgeMs: this.calldataMaxAgeMs,
      waitForReceipt: deps.waitForReceipt,
      nativeTokenUsd: deps.nativeTokenUsd ?? null,
      estimatedGasCostUsd: this.gasCostUsd,
    });
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * Recover, configure, connect, evaluate. Throws only on conditions that make
   * the process meaningless to run — a corrupt audit log it cannot read, or no
   * valid policy at all. Everything else (Krystal down, RPC flapping) is a
   * transient the loop is expected to survive.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;

    await this.recoverFromAuditLog();
    await this.loadPolicies({ required: true });

    this.watcher = this.deps.createWatcher({
      onCrossing: (event) => this.onCrossing(event),
      onStale: (alert) =>
        this.logger.error('lp-lifecycle: chain watch is STALE — positions are not being watched', {
          sinceMs: alert.sinceMs,
          thresholdMs: alert.thresholdMs,
          mode: alert.mode,
          repeat: alert.repeat,
        }),
      onStatus: (status) =>
        this.logger.info('lp-lifecycle: watcher status', {
          mode: status.mode,
          health: status.health,
          lowLatency: status.lowLatency,
          watchedRanges: status.watchedRanges,
          reason: status.reason,
        }),
      onError: (error) =>
        this.logger.warn('lp-lifecycle: watcher error', { scope: error.scope, message: error.message }),
    });
    this.watcher.start();

    // A failure here must not abort startup: the watcher is already up and a
    // Krystal outage is exactly the kind of transient the poll loop retries out
    // of. It is logged as an error, not swallowed.
    try {
      await this.runPositionTick();
    } catch (error) {
      this.logger.error('lp-lifecycle: first position tick failed; will retry on the poll interval', {
        error: describe(error),
      });
    }

    this.pollTimer = setInterval(() => {
      this.track(this.runPositionTick());
    }, this.positionPollIntervalMs);

    // Started AFTER the first position tick on purpose: a command names a
    // position, and `runCommand` refuses one it has no state for. Polling
    // before the first tick would fail every command queued during startup for
    // a reason that is about our timing, not about their request.
    if (this.deps.commands !== undefined) {
      this.commandTimer = setInterval(() => {
        this.track(this.runCommandTick());
      }, this.commandPollIntervalMs);
    }

    this.logger.info('lp-lifecycle: running', {
      positionPollIntervalMs: this.positionPollIntervalMs,
      calldataMaxAgeMs: this.calldataMaxAgeMs,
      gasCostUsd: this.gasCostUsd,
      manualCommands: this.deps.commands === undefined ? 'disabled' : 'enabled',
      commandPollIntervalMs: this.deps.commands === undefined ? null : this.commandPollIntervalMs,
    });
  }

  /**
   * Stop watching, let in-flight work finish, and go quiet. Idempotent.
   *
   * "In-flight work" specifically includes an action that is mid-audit-write:
   * abandoning one of those would create the unresolved intent that
   * `unresolved.ts` exists to make loud, for no reason at all. Shutdown waits.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;

    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.commandTimer !== null) {
      clearInterval(this.commandTimer);
      this.commandTimer = null;
    }
    this.watcher?.stop();

    const held = this.locks.active();
    if (held.length > 0) {
      this.logger.info('lp-lifecycle: waiting for in-flight actions before shutdown', {
        positions: held,
      });
    }
    await this.settle();

    this.watcher = null;
    this.warm.clear();
    this.running = false;
    this.logger.info('lp-lifecycle: stopped');
  }

  /** Await every tracked background task. Used by `stop()` and by the tests. */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  /** Diagnostics — never used to make a decision. */
  getState(): {
    running: boolean;
    positions: number;
    warm: number;
    lockedPositions: string[];
    quarantinedIntents: number;
    policyVersions: number[];
  } {
    return {
      running: this.running,
      positions: this.positionsByToken.size,
      warm: this.warm.size,
      lockedPositions: this.locks.active(),
      quarantinedIntents: this.quarantine.intents.length,
      policyVersions: this.bundle.policies.map((policy) => policy.version),
    };
  }

  // --- startup recovery ----------------------------------------------------

  private async recoverFromAuditLog(): Promise<void> {
    const { records, malformed } = await this.deps.audit.read();

    if (malformed.length > 0) {
      // A corrupt line may itself have been an unresolved intent, so this is not
      // cosmetic. Loud, and deliberately not fatal — the surrounding good lines
      // are still the best evidence we have.
      this.logger.error('lp-lifecycle: audit log contains unparseable lines', {
        count: malformed.length,
        sample: malformed.slice(0, 3),
      });
    }

    this.quarantine = Quarantine.fromRecords(records);
    this.lastCompounded = deriveLastCompounded(records);

    if (this.quarantine.isEmpty) {
      this.logger.info('lp-lifecycle: audit log clean — no unresolved intents', {
        records: records.length,
      });
      return;
    }

    // One loud line per unresolved intent. This is the single most important
    // thing in the startup log: it means a transaction MAY be in flight from a
    // previous run and this process will not touch those positions until a
    // human resolves them.
    this.logger.error(
      'lp-lifecycle: UNRESOLVED INTENTS FOUND — a transaction may be in flight from a previous run',
      {
        count: this.quarantine.intents.length,
        blocksEveryPosition: this.quarantine.blocksEverything,
      },
    );
    for (const intent of this.quarantine.intents) {
      this.logger.error('lp-lifecycle: quarantined intent', {
        auditId: intent.auditId,
        tokenId: intent.tokenId ?? '<unattributable — blocks ALL positions>',
        action: intent.action,
        at: new Date(intent.timestamp).toISOString(),
        remedy:
          'check the chain for this position, append a resolving outcome entry with the same id, then restart',
      });
    }
  }

  // --- policy --------------------------------------------------------------

  private async loadPolicies(options: { required: boolean }): Promise<void> {
    const bundle = await this.deps.policySource.load();

    // The policy is authored elsewhere (plan §9 point 1) and arrives here as an
    // untyped blob. Validate before it can authorize anything; an invalid
    // version is dropped rather than repaired.
    const policies: AutomationPolicy[] = [];
    for (const candidate of bundle.policies ?? []) {
      const result = validatePolicy(candidate);
      if (result.valid) {
        policies.push(candidate);
        continue;
      }
      this.logger.error('lp-lifecycle: dropping invalid policy version', {
        version: (candidate as { version?: unknown } | undefined)?.version,
        issues: result.issues,
      });
    }

    if (policies.length === 0 && options.required) {
      throw new Error(
        'no valid policy available — the process would be unable to authorize anything. ' +
          'Fix the policy source before starting.',
      );
    }
    if (policies.length === 0) {
      this.logger.error('lp-lifecycle: policy source returned no valid policy; nothing can be acted on');
    }

    this.bundle = { policies, bindings: bundle.bindings ?? {} };
  }

  /**
   * The policy THIS position is governed by.
   *
   * A pinned version resolves strictly (no fallback to the newest policy — see
   * `policy/versioning.ts`); an unpinned position inherits the current default,
   * which is how a new position gets rules with zero setup.
   */
  private resolvePolicy(tokenId: string): { ok: true; policy: AutomationPolicy } | { ok: false; reason: string } {
    const pinned = this.bundle.bindings[tokenId];
    if (pinned !== undefined) {
      const resolution = resolvePolicyForPosition({ tokenId, policyVersion: pinned }, this.bundle.policies);
      if (resolution.ok) return { ok: true, policy: resolution.policy };
      return {
        ok: false,
        reason: `policy v${resolution.requestedVersion} pinned to ${tokenId} could not be resolved (${resolution.reason}); refusing to evaluate under a different version`,
      };
    }

    const fallback = currentDefaultPolicy(this.bundle.policies);
    if (fallback === null) return { ok: false, reason: 'no default policy is available' };
    return { ok: true, policy: fallback };
  }

  // --- slow lane: Krystal poll ---------------------------------------------

  /**
   * One slow-lane tick: refresh policy + positions, re-point the watcher, and
   * evaluate the compound AND rebalance triggers for every position.
   *
   * REBALANCE IS EVALUATED HERE TOO, as a LEVEL-triggered backstop to the
   * watcher's EDGE-triggered fast lane. The watcher fires on a range crossing —
   * an inside→outside *transition* — and evaluates the threshold once, at that
   * instant. If price crosses right at the boundary (exit ≈ 0%, below the
   * threshold) and then keeps drifting out, the watcher never re-fires (it is
   * already "above"; there is no new transition), so nothing would ever move a
   * position that is genuinely, increasingly out of range. That gap is exactly
   * how position #418840 sat out of range for 20+ minutes without rebalancing.
   *
   * Evaluating it here is SAFE and does not violate plan §3: the position's
   * `currentTick` is the authoritative `slot0()` tick injected by the position
   * feed (`ingest/krystal/positions.ts` requires it be RPC-sourced, and skips a
   * position whose tick cannot be read) — NOT Krystal's cached `pool.price`,
   * which is the thing §3 forbids trading on. The watcher stays the sub-second
   * fast path for a price that jumps past the threshold in one move; this is the
   * ≤60s catch-up for slow drift and for the boundary-crossing gap above. Both
   * meet at `act()`, whose per-position lock stops them racing.
   */
  async runPositionTick(): Promise<void> {
    if (this.stopping) return;

    try {
      await this.loadPolicies({ required: false });
    } catch (error) {
      this.logger.error('lp-lifecycle: policy refresh failed; continuing on the previous policy set', {
        error: describe(error),
      });
    }

    let positions: LpPosition[];
    try {
      positions = await this.deps.positions.loadPositions();
    } catch (error) {
      this.logger.error('lp-lifecycle: position refresh failed; skipping this tick', {
        error: describe(error),
      });
      return;
    }

    this.positionsByToken.clear();
    const ranges: WatchedRange[] = [];
    for (const position of positions) {
      const withHistory = this.applyCompoundHistory(position);
      this.positionsByToken.set(position.tokenId, withHistory);
      if (position.status === 'closed') continue;
      ranges.push({
        tokenId: position.tokenId,
        pool: position.pool.address,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
      });
    }
    try {
      this.watcher?.setWatched(ranges);
    } catch (error) {
      // The watcher rejects a malformed range at registration. One bad position
      // must not cost us the watch on every other one, and it must not abort
      // the tick before the compound evaluations below.
      this.logger.error('lp-lifecycle: watcher rejected the watch set; ranges may be stale', {
        ranges: ranges.length,
        error: describe(error),
      });
    }

    for (const position of this.positionsByToken.values()) {
      if (this.stopping) return;
      this.evaluateOutOfRangeAlert(position);
      await this.evaluateCompound(position);
      if (this.stopping) return;
      await this.evaluateRebalance(position);
    }
  }

  /**
   * Krystal has no last-compound timestamp (plan §11 item 9), so it comes from
   * our own audit log. Without this the interval backstop measures from
   * `openedAt` forever and would re-fire on every tick after the first day.
   */
  private applyCompoundHistory(position: LpPosition): LpPosition {
    const lastCompoundedAt = this.lastCompounded.get(position.tokenId);
    if (lastCompoundedAt === undefined) return position;
    return { ...position, lastCompoundedAt };
  }

  private async evaluateCompound(position: LpPosition): Promise<void> {
    const resolved = this.resolvePolicy(position.tokenId);
    if (!resolved.ok) {
      await this.recordRefusal(
        unresolvedPolicyDecision(position, resolved.reason),
        { rule: 'lifecycle.policy_unresolved', reason: resolved.reason },
      );
      return;
    }
    const policy = resolved.policy;

    if (!policy.compoundTrigger.enabled) {
      await this.logEvaluation({
        action: 'none',
        rule: 'policy.auto_compound_off',
        reason:
          'auto-compound is disabled in policy; autonomous compounding will not fire (manual compound commands still work)',
        snapshot: {
          tokenId: position.tokenId,
          pool: position.pool.address,
          policyVersion: policy.version,
        },
      });
      return;
    }

    // `NaN` for an unknown gas cost is not laziness: `shouldCompound` treats a
    // non-finite gas figure as "the fees-vs-gas arm cannot be evaluated" and
    // says so in its reason, rather than treating gas as free.
    const decision = shouldCompound(position, policy, this.gasCostUsd ?? Number.NaN, this.now());

    if (decision.action !== 'compound') {
      await this.logEvaluation(decision);
      return;
    }

    await this.act({
      position,
      policy,
      decision,
      action: 'compound',
      build: () => this.deps.calldata.compound({ position, policy }),
    });
  }

  /**
   * Slow-lane rebalance: the LEVEL-triggered backstop to the watcher's edge.
   *
   * Runs `shouldRebalance` against the position's authoritative `slot0` tick. It
   * ACTS when the trigger fires — that is the whole point, catching a position
   * the watcher's one-shot crossing check let slip past the threshold. When it
   * does NOT fire it stays quiet for an in-range position (the compound tick
   * already recorded that position this tick), but records the evaluation for an
   * OUT-OF-RANGE one, so a position sitting outside its band while under the
   * threshold is visible in the log rather than silent.
   */
  private async evaluateRebalance(position: LpPosition): Promise<void> {
    if (position.status === 'closed') return;

    const resolved = this.resolvePolicy(position.tokenId);
    // A policy that could not be resolved was already recorded by
    // `evaluateCompound` this same tick; a second identical refusal would only
    // double the log.
    if (!resolved.ok) return;
    const policy = resolved.policy;

    if (!policy.rebalanceTrigger.enabled) {
      // Autonomous rebalance is off. Manual rebalance commands still work. Only
      // note it for an out-of-range position, where "we are deliberately not
      // moving this" is the fact worth having in the log.
      if (position.status === 'out_of_range') {
        await this.logEvaluation({
          action: 'none',
          rule: 'policy.auto_rebalance_off',
          reason:
            'auto-rebalance is disabled in policy; this out-of-range position will NOT be moved ' +
            'autonomously (manual rebalance commands still work)',
          snapshot: {
            tokenId: position.tokenId,
            pool: position.pool.address,
            status: position.status,
            policyVersion: policy.version,
          },
        });
      }
      return;
    }

    const decision = shouldRebalance(position, policy);

    if (decision.action !== 'rebalance') {
      // Record only when out of range — an in-range "no rebalance" is already
      // implied by this tick's compound entry, and logging it for every position
      // every tick would double the log for no signal.
      if (position.status === 'out_of_range') {
        await this.logEvaluation(decision);
      }
      return;
    }

    const range = recenterRange(position, policy.rebalanceTrigger.rangeStrategy);
    if (!range.ok) {
      await this.recordRefusal(decision, {
        rule: 'lifecycle.no_target_range',
        reason: `rebalance triggered but no target range could be derived: ${range.reason}`,
      });
      return;
    }

    await this.act({
      position,
      policy,
      decision,
      action: 'rebalance',
      build: () =>
        this.deps.calldata.rebalance({
          position,
          policy,
          tickLower: range.range.tickLower,
          tickUpper: range.range.tickUpper,
        }),
    });
  }

  // --- fast lane: chain watcher --------------------------------------------

  private onCrossing(event: CrossingEvent): void {
    if (this.stopping) return;
    switch (event.phase) {
      case 'observed':
        this.track(this.onObservedCrossing(event));
        return;
      case 'confirmed':
        this.track(this.onConfirmedCrossing(event));
        return;
      case 'reverted': {
        // The crossing did not hold. Anything parked for it describes a world
        // that no longer exists.
        const dropped = this.warm.delete(event.watched.tokenId);
        this.logger.info('lp-lifecycle: crossing reverted', {
          tokenId: event.watched.tokenId,
          reason: event.reason,
          droppedWarmCalldata: dropped,
        });
        return;
      }
    }
  }

  /**
   * Speculative path. Builds and parks calldata; CANNOT submit.
   *
   * The audit entry it writes is forced to `action: 'none'` with a
   * `lifecycle.warm.*` rule, because nothing was done — recording it under
   * `rebalance` would make a warm-up indistinguishable from an executed
   * rebalance in `summarize()`.
   */
  private async onObservedCrossing(event: ObservedCrossing): Promise<void> {
    const prepared = this.prepareRebalance(event);
    if (prepared === null) return;
    const { position, policy, decision } = prepared;

    if (decision.action !== 'rebalance') return;
    if (this.executor.checkGuards(position, policy) !== null) return; // refusal is recorded on confirm

    const range = recenterRange(position, policy.rebalanceTrigger.rangeStrategy);
    if (!range.ok) return;

    try {
      const transaction = await this.deps.calldata.rebalance({
        position,
        policy,
        tickLower: range.range.tickLower,
        tickUpper: range.range.tickUpper,
      });
      this.warm.set(position.tokenId, { action: 'rebalance', transaction, decision });
      await this.logEvaluation({
        action: 'none',
        rule: `lifecycle.warm.${decision.rule}`,
        reason:
          `range exit observed but NOT confirmed; calldata built and parked. ` +
          `Nothing was broadcast — awaiting confirmation. (${decision.reason})`,
        snapshot: { ...decision.snapshot, crossingPhase: 'observed', warmed: true },
      });
    } catch (error) {
      // A failed warm-up costs nothing: the confirmed path rebuilds.
      this.logger.warn('lp-lifecycle: warm calldata build failed', {
        tokenId: position.tokenId,
        error: describe(error),
      });
    }
  }

  /** The actionable path. This is the only branch that can reach the signer. */
  private async onConfirmedCrossing(event: ConfirmedCrossing): Promise<void> {
    const prepared = this.prepareRebalance(event);
    if (prepared === null) return;
    const { position, policy, decision } = prepared;

    if (decision.action !== 'rebalance') {
      await this.logEvaluation(decision);
      this.warm.delete(position.tokenId);
      return;
    }

    const range = recenterRange(position, policy.rebalanceTrigger.rangeStrategy);
    if (!range.ok) {
      await this.recordRefusal(decision, {
        rule: 'lifecycle.no_target_range',
        reason: `rebalance triggered but no target range could be derived: ${range.reason}`,
      });
      return;
    }

    await this.act({
      position,
      policy,
      decision,
      action: 'rebalance',
      build: () =>
        this.deps.calldata.rebalance({
          position,
          policy,
          tickLower: range.range.tickLower,
          tickUpper: range.range.tickUpper,
        }),
    });
  }

  /**
   * Shared setup for both crossing phases: find the position, resolve its
   * policy, and evaluate the rebalance trigger against the tick the WATCHER
   * observed — never against the tick Krystal last reported.
   */
  private prepareRebalance(
    event: ObservedCrossing | ConfirmedCrossing,
  ): { position: LpPosition; policy: AutomationPolicy; decision: Decision } | null {
    const tokenId = event.watched.tokenId;
    const known = this.positionsByToken.get(tokenId);
    if (known === undefined) {
      // A crossing for a position we have no state for. Not actionable — the
      // rules need fees and value, and guessing them is not an option.
      this.logger.warn('lp-lifecycle: crossing for an unknown position; skipping', {
        tokenId,
        phase: event.phase,
      });
      return null;
    }

    const resolved = this.resolvePolicy(tokenId);
    if (!resolved.ok) {
      this.track(
        this.recordRefusal(unresolvedPolicyDecision(known, resolved.reason), {
          rule: 'lifecycle.policy_unresolved',
          reason: resolved.reason,
        }),
      );
      return null;
    }

    const position: LpPosition = { ...known, currentTick: event.observation.tick };
    const policy = resolved.policy;

    if (!policy.rebalanceTrigger.enabled) {
      const disabled: Decision = {
        action: 'none',
        rule: 'policy.auto_rebalance_off',
        reason:
          'auto-rebalance is disabled in policy; autonomous rebalancing will not fire (manual rebalance commands still work)',
        snapshot: {
          tokenId,
          pool: position.pool.address,
          policyVersion: policy.version,
          crossingPhase: event.phase,
          watcherExitPercent: event.exitPercent,
          watcherSide: event.side,
          watcherPreviousSide: event.previousSide,
          observedTick: event.observation.tick,
          observationSource: event.observation.source,
          ...(event.phase === 'confirmed'
            ? { confirmationDepth: event.depth, verifiedBy: event.verifiedBy }
            : {}),
        },
      };
      return { position, policy, decision: disabled };
    }

    const decision = shouldRebalance(position, policy);

    // The watcher's own `exitPercent` is computed from the tick it VERIFIED at
    // confirmation depth, while the rules re-derive it from `observation.tick`
    // (the verified tick itself is not exposed on the event). They agree to
    // within a block of price movement; both are recorded so a disagreement is
    // visible rather than silently resolved in favour of one.
    const enriched: Decision = {
      ...decision,
      snapshot: {
        ...decision.snapshot,
        crossingPhase: event.phase,
        watcherExitPercent: event.exitPercent,
        watcherSide: event.side,
        watcherPreviousSide: event.previousSide,
        observedTick: event.observation.tick,
        observationSource: event.observation.source,
        ...(event.phase === 'confirmed'
          ? { confirmationDepth: event.depth, verifiedBy: event.verifiedBy }
          : {}),
      },
    };

    return { position, policy, decision: enriched };
  }

  // --- manual lane: the dashboard's command queue ---------------------------
  //
  // A THIRD TRIGGER, NOT A THIRD PATH. The dashboard cannot sign and this
  // process cannot be reached (plan §9 point 1), so a manual action arrives as
  // a row we poll for. Once claimed it goes through `act()` — the same funnel
  // the watcher and the Krystal poll use — so it inherits the lock, the
  // quarantine check, the execution-time allowlist, the dry run and the
  // intent-before-broadcast ordering without a single one of them being
  // re-implemented here. Nothing below is allowed to reach `signer.submit`
  // except through `act()`.

  /**
   * One manual-command tick: claim at most one command and run it.
   *
   * A claim that fails (database down) is logged and dropped — the command
   * stays `pending` and the next tick will try again, which is the right
   * degradation for a trigger. A command that IS claimed is always resolved,
   * even if executing it throws, or the row sits on `claimed` forever and the
   * position's single command slot is wedged until a human intervenes.
   */
  async runCommandTick(): Promise<void> {
    const source = this.deps.commands;
    if (source === undefined || this.stopping || this.commandTickBusy) return;

    this.commandTickBusy = true;
    try {
      let command: LpCommand | null;
      try {
        command = await source.claimNext();
      } catch (error) {
        this.logger.error('lp-lifecycle: could not poll the manual command queue', {
          error: describe(error),
        });
        return;
      }
      if (command === null) return;

      this.logger.info('lp-lifecycle: manual command claimed', {
        commandId: command.id,
        tokenId: command.tokenId,
        action: command.action,
        requestedAt: new Date(command.requestedAt).toISOString(),
      });

      let result: CommandResult;
      try {
        result = await this.runCommand(command);
      } catch (error) {
        // Nothing below `act()` is expected to throw, but a claimed command
        // that is never resolved is worse than a wrong reason, so this is a
        // catch-all rather than a bug we let escape.
        result = {
          txHash: null,
          error: `the worker threw while executing this command: ${describe(error)}`,
        };
      }

      try {
        await source.complete(command, result);
      } catch (error) {
        this.logger.error(
          'lp-lifecycle: manual command outcome could not be recorded — the row is stuck on ' +
            '"claimed"; the AUDIT LOG is authoritative for what actually happened',
          { commandId: command.id, tokenId: command.tokenId, ...result, error: describe(error) },
        );
        return;
      }

      this.logger.info('lp-lifecycle: manual command resolved', {
        commandId: command.id,
        tokenId: command.tokenId,
        action: command.action,
        status: result.error === null ? 'done' : 'failed',
        txHash: result.txHash,
        error: result.error,
      });
    } finally {
      this.commandTickBusy = false;
    }
  }

  /**
   * Execute one claimed command through the normal funnel.
   *
   * Every refusal below produces a `failed` result with the reason in it AND an
   * audit entry (via `act`/`recordRefusal`), so the dashboard and the log tell
   * the same story. A refusal is never reported as `done`.
   */
  private async runCommand(command: LpCommand): Promise<CommandResult> {
    // Enter opens a NEW position, so it has no tokenId to look up and takes a
    // separate path. Everything below this branch is position-scoped.
    if (command.action === 'enter') {
      return this.runEnter(command);
    }

    if (command.tokenId === null) {
      // Only enter is allowed a null tokenId (enforced by the DB shape CHECK and
      // `rowToCommand`). Reaching here means a row got past both — refuse rather
      // than dereference it.
      return failure(`command ${command.id} has action "${command.action}" but no token_id.`);
    }

    const position = this.positionsByToken.get(command.tokenId);
    if (position === undefined) {
      // Not tracked: closed, in a pool whose tick could not be read, or held by
      // a different Safe. Guessing at any of those would mean acting on a
      // position we have no state for.
      return failure(
        `position ${command.tokenId} is not currently tracked (it may be closed, or its pool's ` +
          'current tick could not be read). Nothing was attempted.',
      );
    }

    // The command carries the pool the requester was looking at. If the
    // position has since moved, the request describes a world that no longer
    // exists — and the allowlist decision the dashboard made was made about a
    // different pool.
    if (position.pool.address !== command.poolAddress) {
      return failure(
        `position ${command.tokenId} is in pool ${position.pool.address}, but the command was ` +
          `queued for ${command.poolAddress}. Refusing to act on a stale request.`,
      );
    }

    const resolved = this.resolvePolicy(command.tokenId);
    if (!resolved.ok) {
      await this.recordRefusal(unresolvedPolicyDecision(position, resolved.reason), {
        rule: 'lifecycle.policy_unresolved',
        reason: resolved.reason,
      });
      return failure(resolved.reason);
    }
    const policy = resolved.policy;

    if (command.action === 'compound_rebalance') {
      return this.runCompoundRebalance(command, position, policy);
    }

    if (command.action === 'increase') {
      return this.runIncrease(command, position, policy);
    }

    const singleStep = command as LpCommand & { action: SingleStepCommandAction };
    const decision = manualDecision(singleStep, position, policy);

    const build = this.commandBuilder(singleStep, position, policy);
    if (typeof build === 'string') {
      await this.recordRefusal(decision, { rule: 'lifecycle.manual_unavailable', reason: build });
      return failure(build);
    }

    const result = await this.act({
      position,
      policy,
      decision,
      action: singleStep.action,
      build,
    });

    return commandResult(result);
  }

  /**
   * Manual compound then rebalance on the same tokenId.
   *
   * The compound step uses the queued position id; rebalance may mint a new
   * NFT. Fails fast — rebalance is not attempted if compound does not broadcast.
   */
  private async runCompoundRebalance(
    command: LpCommand,
    position: LpPosition,
    policy: AutomationPolicy,
  ): Promise<CommandResult> {
    const compoundDecision = manualCompoundRebalanceStep(command, position, policy, 'compound');
    const compoundResult = await this.act({
      position,
      policy,
      decision: compoundDecision,
      action: 'compound',
      build: () => this.deps.calldata.compound({ position, policy }),
    });
    const compoundOutcome = commandResult(compoundResult);
    if (compoundOutcome.error !== null) {
      return compoundOutcome;
    }

    const range = recenterRange(position, policy.rebalanceTrigger.rangeStrategy);
    if (!range.ok) {
      const reason =
        `compound succeeded but rebalance could not proceed: ${range.reason}` +
        (compoundOutcome.txHash !== null ? ` (compound tx ${compoundOutcome.txHash})` : '');
      await this.recordRefusal(manualCompoundRebalanceStep(command, position, policy, 'rebalance'), {
        rule: 'lifecycle.manual_unavailable',
        reason,
      });
      return failure(reason);
    }

    const rebalanceDecision = manualCompoundRebalanceStep(command, position, policy, 'rebalance');
    const rebalanceResult = await this.act({
      position,
      policy,
      decision: rebalanceDecision,
      action: 'rebalance',
      build: () =>
        this.deps.calldata.rebalance({
          position,
          policy,
          tickLower: range.range.tickLower,
          tickUpper: range.range.tickUpper,
        }),
    });
    const rebalanceOutcome = commandResult(rebalanceResult);
    if (rebalanceOutcome.error !== null && compoundOutcome.txHash !== null) {
      return {
        txHash: compoundOutcome.txHash,
        error: `compound succeeded (tx ${compoundOutcome.txHash}) but rebalance failed: ${rebalanceOutcome.error}`,
      };
    }
    return rebalanceOutcome;
  }

  /**
   * Enter: open a BRAND-NEW position from a manual command (Zap In).
   *
   * There is no existing position, so this does the extra work the other manual
   * actions get for free from the position feed — resolve the default policy,
   * gate the pool at the allowlist, read the pool's LIVE tick, and compute the
   * target range — then hands a SYNTHETIC position to the same `act()` funnel.
   * The synthetic position exists only so the funnel's lock, guard ladder and
   * executor can run; only its `tokenId` (the command id, for lock + quarantine
   * attribution) and `pool.address`/`feeTierBps` are read by that path. Nothing
   * here reaches the signer except through `act()`.
   */
  private async runEnter(command: LpCommand): Promise<CommandResult> {
    if (command.tokenInAddress === undefined || command.amountIn === undefined) {
      // rowToCommand guarantees these for an enter; a missing one means a shape
      // slipped past it. Refuse rather than build a transaction from a hole.
      return failure(`enter command ${command.id} is missing its parameters; nothing was attempted.`);
    }
    const tokenIn = command.tokenInAddress;
    const amountIn = command.amountIn;

    const reader = this.deps.poolState;
    const buildEnter = this.deps.calldata.enter;
    if (reader === undefined || buildEnter === undefined) {
      const reason =
        'enter (Zap In) is not wired into this worker: no pool-state reader or enter calldata ' +
        'builder is configured. Nothing was attempted.';
      await this.recordRefusal(enterDecision(command, null), { rule: 'lifecycle.manual_unavailable', reason });
      return failure(reason);
    }

    const policy = currentDefaultPolicy(this.bundle.policies);
    if (policy === null) {
      const reason = 'no default policy is available; refusing to enter.';
      await this.recordRefusal(enterDecision(command, null), { rule: 'lifecycle.policy_unresolved', reason });
      return failure(reason);
    }

    // Execution-time allowlist gate. The backend checked at queue time, but the
    // policy can change between; this is the same `isPoolAllowed` gate `act()`
    // re-applies, checked here first so the failure names the pool clearly and no
    // pool state is read for a pool we may not touch.
    if (!isPoolAllowed(policy, command.poolAddress)) {
      const reason =
        `pool ${command.poolAddress} is not on policy v${policy.version}'s allowlist ` +
        `(${policy.allowedPools.length} pool(s)); refusing to enter.`;
      await this.recordRefusal(enterDecision(command, policy), { rule: 'lifecycle.pool_not_allowed', reason });
      return failure(reason);
    }

    let state: PoolState;
    try {
      state = await reader.readPoolState(command.poolAddress);
    } catch (error) {
      const reason = `could not read pool state for ${command.poolAddress}: ${describe(error)}`;
      await this.recordRefusal(enterDecision(command, policy), { rule: 'lifecycle.pool_state_failed', reason });
      return failure(reason);
    }

    // The input token must be one side of the pool. Krystal would otherwise have
    // to route a swap we never priced, and the operator picked from the pair.
    if (tokenIn !== state.token0 && tokenIn !== state.token1) {
      const reason =
        `token ${tokenIn} is not in pool ${command.poolAddress} ` +
        `(${state.token0} / ${state.token1}); refusing to enter.`;
      await this.recordRefusal(enterDecision(command, policy), { rule: 'lifecycle.token_not_in_pool', reason });
      return failure(reason);
    }

    const strategy = command.rangeStrategy ?? policy.rebalanceTrigger.rangeStrategy;
    const range = rangeFromCenter(state.currentTick, state.feeUnits, strategy);
    if (!range.ok) {
      const reason = `enter requested but no target range could be derived: ${range.reason}`;
      await this.recordRefusal(enterDecision(command, policy), { rule: 'lifecycle.no_target_range', reason });
      return failure(reason);
    }

    const position = syntheticEnterPosition(command, state, range.range, this.now());
    const decision = enterDecision(command, policy, {
      tickLower: range.range.tickLower,
      tickUpper: range.range.tickUpper,
      strategy,
      currentTick: state.currentTick,
    });
    const swapSlippage = command.swapSlippage;

    const allowance = await this.ensureZapAllowance({
      token: tokenIn,
      amountRequired: BigInt(amountIn),
      position,
      policy,
      commandId: command.id,
      refusalDecision: enterDecision(command, policy, {
        tickLower: range.range.tickLower,
        tickUpper: range.range.tickUpper,
        strategy,
        currentTick: state.currentTick,
      }),
    });
    if (!allowance.ok) {
      return failure(allowance.reason);
    }

    const result = await this.actZap({
      position,
      policy,
      decision,
      action: 'enter',
      build: () =>
        buildEnter.call(this.deps.calldata, {
          poolAddress: command.poolAddress,
          tokenInAddress: tokenIn,
          amountIn,
          tickLower: range.range.tickLower,
          tickUpper: range.range.tickUpper,
          ...(swapSlippage === null || swapSlippage === undefined ? {} : { swapSlippage }),
        }),
    });

    return commandResult(result);
  }

  /**
   * Increase: zap more liquidity into an EXISTING position (Krystal `swap_and_increase`).
   *
   * FAILURE MODE — simulation passed, chain reverted (e.g. tx
   * `0x0104…5949` on position #419551): Krystal embeds swap min-outs in the
   * calldata. `simulateContract` runs at the pending head; the tx can land
   * several blocks later and after other txs in the same block have moved the
   * pool, so the quote is stale even though preflight passed. Balance and
   * allowance are unaffected. `actZap` re-quotes once when the mined receipt
   * reports `reverted`.
   */
  private async runIncrease(
    command: LpCommand,
    position: LpPosition,
    policy: AutomationPolicy,
  ): Promise<CommandResult> {
    if (command.tokenInAddress === undefined || command.amountIn === undefined) {
      return failure(`increase command ${command.id} is missing its parameters; nothing was attempted.`);
    }
    const tokenIn = command.tokenInAddress;
    const amountIn = command.amountIn;

    const buildIncrease = this.deps.calldata.increase;
    if (buildIncrease === undefined) {
      const reason =
        'increase is not wired into this worker: no increase calldata builder is configured. Nothing was attempted.';
      await this.recordRefusal(increaseDecision(command, position, policy), {
        rule: 'lifecycle.manual_unavailable',
        reason,
      });
      return failure(reason);
    }

    if (tokenIn !== position.pool.token0.address && tokenIn !== position.pool.token1.address) {
      const reason =
        `token ${tokenIn} is not in pool ${position.pool.address} ` +
        `(${position.pool.token0.address} / ${position.pool.token1.address}); refusing to increase.`;
      await this.recordRefusal(increaseDecision(command, position, policy), {
        rule: 'lifecycle.token_not_in_pool',
        reason,
      });
      return failure(reason);
    }

    const decision = increaseDecision(command, position, policy);
    const swapSlippage = command.swapSlippage;

    const allowance = await this.ensureZapAllowance({
      token: tokenIn,
      amountRequired: BigInt(amountIn),
      position,
      policy,
      commandId: command.id,
      refusalDecision: decision,
    });
    if (!allowance.ok) {
      return failure(allowance.reason);
    }

    const result = await this.actZap({
      position,
      policy,
      decision,
      action: 'increase',
      build: () =>
        buildIncrease.call(this.deps.calldata, {
          position,
          tokenInAddress: tokenIn,
          amountIn,
          ...(swapSlippage === null || swapSlippage === undefined ? {} : { swapSlippage }),
        }),
    });

    return commandResult(result);
  }

  private async ensureZapAllowance(params: {
    token: Address;
    amountRequired: bigint;
    position: LpPosition;
    policy: AutomationPolicy;
    commandId: string;
    refusalDecision: Decision;
  }): Promise<EnsureAllowanceResult> {
    const cfg = this.deps.allowance;
    if (cfg === undefined) {
      const reason =
        'ERC-20 allowance pre-flight is not configured on this worker; refusing to zap without it.';
      await this.recordRefusal(params.refusalDecision, { rule: 'lifecycle.manual_unavailable', reason });
      return { ok: false, reason };
    }

    return ensureErc20Allowance(
      {
        owner: cfg.owner,
        chainId: cfg.chainId,
        approvableTokens: cfg.approvableTokens,
        reader: cfg.reader,
        executor: this.executor,
        now: this.now,
        newId: this.newId,
        logger: this.logger,
        recordRefusal: (decision, refusal) => this.recordRefusal(decision, refusal),
      },
      {
        token: params.token,
        amountRequired: params.amountRequired,
        position: params.position,
        policy: params.policy,
        commandId: params.commandId,
      },
    );
  }

  /**
   * Pick the calldata builder for a manual action, or return the reason there
   * isn't one. A string return is a refusal, not an error.
   */
  private commandBuilder(
    command: LpCommand & { action: SingleStepCommandAction },
    position: LpPosition,
    policy: AutomationPolicy,
  ): (() => Promise<PreparedTransaction>) | string {
    switch (command.action) {
      case 'compound':
        return () => this.deps.calldata.compound({ position, policy });

      case 'rebalance': {
        // Same target range an automatic rebalance would use. The operator
        // chose to rebalance, not where to rebalance to — that stays a
        // property of the position and the policy.
        const range = recenterRange(position, policy.rebalanceTrigger.rangeStrategy);
        if (!range.ok) {
          return `rebalance requested but no target range could be derived: ${range.reason}`;
        }
        return () =>
          this.deps.calldata.rebalance({
            position,
            policy,
            tickLower: range.range.tickLower,
            tickUpper: range.range.tickUpper,
          });
      }

      case 'exit': {
        const exit = this.deps.calldata.exit;
        if (exit === undefined) {
          // See the `exit?` doc comment in `types.ts`. Krystal's
          // `withdraw_and_swap` needs a target token and the policy has no
          // field for one; picking a side of the pair here would be a coin flip
          // over real funds, so this refuses instead of guessing.
          return (
            'exit is not wired into the calldata builder yet: Krystal requires a target token to ' +
            'swap out to, and the policy has no field naming one. Refusing to guess which side of ' +
            'the pair to exit into. Withdraw manually through the Safe until this is configurable.'
          );
        }
        return () => exit.call(this.deps.calldata, { position, policy });
      }
    }
  }

  /**
   * Zap flows (enter / increase): run `act`, and if the chain receipt shows a
   * revert, re-quote from Krystal and try once more. Simulation cannot see
   * intra-block ordering or price drift between quote time and inclusion.
   */
  private async actZap(request: {
    position: LpPosition;
    policy: AutomationPolicy;
    decision: Decision;
    action: 'enter' | 'increase';
    build: () => Promise<PreparedTransaction>;
  }): Promise<ActionResult | { status: 'position_busy'; reason: string }> {
    const first = await this.act(request);
    if (
      first.status !== 'submitted' ||
      first.recorded.error === null ||
      !first.recorded.error.includes('reverted on chain')
    ) {
      return first;
    }

    this.logger.warn('lp-lifecycle: zap action reverted on chain; re-quoting once', {
      tokenId: request.position.tokenId,
      action: request.action,
      txHash: first.recorded.txHash,
    });

    return this.act(request);
  }

  // --- the single execution funnel -----------------------------------------

  /**
   * Take one action for one position: lock, guard, build, execute, record.
   *
   * Every path out of here leaves exactly one audit trace — an intent/outcome
   * pair when the signer was reached, or a single `action: 'none'` evaluation
   * entry when it was not.
   *
   * The return value exists for the manual lane, which has to tell the person
   * who pressed the button what happened. The autonomous callers ignore it: the
   * audit log is their record, and it is written here either way.
   */
  private async act(request: {
    position: LpPosition;
    policy: AutomationPolicy;
    decision: Decision;
    action: ExecutableAction;
    build: () => Promise<PreparedTransaction>;
  }): Promise<ActionResult | { status: 'position_busy'; reason: string }> {
    const { position, policy, action, build } = request;
    const decision = withPositionSnapshot(request.decision, position);

    const attempt = await this.locks.tryRun(position.tokenId, async (): Promise<ActionResult> => {
      // Guards first: refusing here avoids a Krystal round trip, and — more
      // importantly — refusing to build calldata for a quarantined position
      // means there is no parked transaction lying around for a later tick to
      // pick up.
      const guard = this.executor.checkGuards(position, policy);
      if (guard !== null) {
        await this.recordRefusal(decision, guard);
        return { status: 'refused', refusal: guard };
      }

      let transaction: PreparedTransaction;
      const warm = this.takeWarm(action, position.tokenId);
      if (warm !== null) {
        transaction = warm;
      } else {
        try {
          transaction = await build();
        } catch (error) {
          const refusal: Refusal = {
            rule: 'lifecycle.calldata_failed',
            reason: `could not build calldata: ${describe(error)}`,
          };
          await this.recordRefusal(decision, refusal);
          return { status: 'refused', refusal };
        }
      }

      const result = await this.executor.execute({ position, policy, decision, action, transaction });

      switch (result.status) {
        case 'submitted':
          if (action === 'compound' && result.recorded.error === null && result.recorded.txHash !== null) {
            // Keep the in-memory backstop clock in step with the log we just
            // wrote, so the next tick does not re-fire the interval arm.
            this.lastCompounded.set(position.tokenId, this.now());
          }
          if (action === 'rebalance' && result.recorded.error === null && result.recorded.txHash !== null) {
            await this.recordRebalanceLineage(position, decision);
          }
          this.logger.info('lp-lifecycle: action submitted', {
            tokenId: position.tokenId,
            action,
            auditId: result.auditId,
            outcome: result.outcome.status,
          });
          return result;
        case 'refused':
        case 'simulation_failed':
          await this.recordRefusal(decision, result.refusal);
          return result;
        case 'intent_write_failed':
          // Already logged loudly by the executor. Nothing was submitted and
          // nothing is in flight; another audit write would very likely fail
          // the same way, so we do not attempt one.
          return result;
        case 'outcome_write_failed':
          this.logger.error('lp-lifecycle: action left UNRESOLVED in the audit log', {
            tokenId: position.tokenId,
            action,
            auditId: result.auditId,
          });
          return result;
      }
    });

    if (!attempt.ran) {
      // The other lane is mid-action on this position. Refuse, do not queue —
      // a queued action would execute against pre-transaction state.
      const reason = `another action is already in flight for position ${position.tokenId}; refusing to start a second`;
      await this.recordRefusal(decision, { rule: 'lifecycle.position_busy', reason });
      return { status: 'position_busy', reason };
    }

    void this.emitActAlerts(request, attempt.value);
    return attempt.value;
  }

  private evaluateOutOfRangeAlert(position: LpPosition): void {
    if (this.alerts === null || this.alertOutOfRangeMinutes <= 0) return;
    const minutes = this.outOfRangeTracker.observe(position, this.now());
    if (minutes === null || !this.outOfRangeTracker.shouldAlert(position.tokenId, minutes, this.alertOutOfRangeMinutes)) return;
    this.outOfRangeTracker.markAlerted(position.tokenId);
    void this.sendAlert({ kind: 'out_of_range', timestamp: this.now(), tokenId: position.tokenId, poolAddress: position.pool.address, reason: 'position is out of range and has not been rebalanced', outOfRangeMinutes: minutes });
  }
  private emitActAlerts(request: { position: LpPosition; action: ExecutableAction; decision: Decision }, result: ActionResult | { status: 'position_busy'; reason: string }): void {
    if (this.alerts === null) return;
    const poolAddress = request.position.pool.address; const tokenId = request.position.tokenId; const now = this.now();
    if (request.action === 'rebalance' && result.status === 'submitted' && result.recorded.error === null) {
      void this.sendAlert({ kind: 'rebalance_fired', timestamp: now, tokenId, poolAddress, action: request.action, reason: request.decision.reason, txHash: result.recorded.txHash, gasSpentUsd: result.gasSpentUsd });
    }
    if ((request.action === 'enter' || request.action === 'increase') && this.isFailedAction(result)) {
      void this.sendAlert({ kind: 'action_failed', timestamp: now, tokenId, poolAddress, action: request.action, reason: this.describeActionFailure(result), txHash: result.status === 'submitted' ? result.recorded.txHash : null });
    }
    const threshold = this.alertGasThresholdUsd;
    if (threshold !== null && threshold > 0 && result.status === 'submitted' && result.recorded.error === null && result.gasSpentUsd !== undefined && result.gasSpentUsd >= threshold) {
      void this.sendAlert({ kind: 'gas_threshold', timestamp: now, tokenId, poolAddress, action: request.action, reason: `gas spend ${result.gasSpentUsd.toFixed(4)} exceeded threshold ${threshold.toFixed(4)}`, txHash: result.recorded.txHash, gasSpentUsd: result.gasSpentUsd });
    }
  }
  private isFailedAction(result: ActionResult | { status: 'position_busy'; reason: string }): boolean {
    if (result.status === 'position_busy') return true;
    if (result.status === 'refused' || result.status === 'simulation_failed') return true;
    if (result.status === 'intent_write_failed' || result.status === 'outcome_write_failed') return true;
    if (result.status === 'submitted' && result.recorded.error !== null) return true;
    return false;
  }
  private describeActionFailure(result: ActionResult | { status: 'position_busy'; reason: string }): string {
    switch (result.status) {
      case 'position_busy': return result.reason;
      case 'refused': case 'simulation_failed': return result.refusal.reason;
      case 'intent_write_failed': return result.error;
      case 'outcome_write_failed': return result.recorded.error ?? result.error;
      case 'submitted': return result.recorded.error ?? 'action failed';
    }
  }
  private sendAlert(payload: LpAlertPayload): Promise<void> { return this.alerts?.send(payload) ?? Promise.resolve(); }

  /** Parked calldata for this position, if it is the right action and fresh. */
  private takeWarm(action: ExecutableAction, tokenId: string): PreparedTransaction | null {
    const parked = this.warm.get(tokenId);
    if (parked === undefined) return null;
    this.warm.delete(tokenId);
    if (parked.action !== action) return null;
    if (this.now() - parked.transaction.meta.builtAt > this.calldataMaxAgeMs) return null;
    return parked.transaction;
  }

  // --- audit helpers -------------------------------------------------------

  private async recordRebalanceLineage(position: LpPosition, decision: Decision): Promise<void> {
    const oldTokenId = position.tokenId;
    const poolAddress = position.pool.address;

    let positions: LpPosition[];
    try {
      positions = await this.deps.positions.loadPositions();
    } catch (error) {
      this.logger.warn('lp-lifecycle: could not refresh positions for rebalance lineage', {
        oldTokenId,
        error: describe(error),
      });
      return;
    }

    const successor = positions
      .filter(
        (candidate) =>
          candidate.pool.address.toLowerCase() === poolAddress.toLowerCase() &&
          candidate.tokenId !== oldTokenId &&
          candidate.status !== 'closed',
      )
      .sort((a, b) => Number.parseInt(b.tokenId, 10) - Number.parseInt(a.tokenId, 10))[0];

    if (successor === undefined) {
      this.logger.warn('lp-lifecycle: rebalance succeeded but no successor position was found', {
        oldTokenId,
        pool: poolAddress,
      });
      return;
    }

    await this.logEvaluation({
      action: 'none',
      rule: 'lifecycle.rebalance.lineage',
      reason:
        `rebalance lineage: position #${oldTokenId} was withdrawn and re-minted as #${successor.tokenId}`,
      snapshot: {
        oldTokenId,
        newTokenId: successor.tokenId,
        pool: poolAddress,
        withdrawnValueUsd: position.valueUsd,
        remintedValueUsd: successor.valueUsd,
        unclaimedFeesUsd: position.unclaimedFeesUsd,
        policyVersion: decision.snapshot.policyVersion,
      },
    });
  }

  /**
   * Record a decision that produced no action.
   *
   * An audit write failure here is logged and swallowed: unlike the intent
   * write, nothing is about to touch funds, and taking the process down over a
   * bookkeeping entry would leave the positions unwatched.
   */
  private async logEvaluation(decision: Decision): Promise<void> {
    try {
      await this.deps.audit.recordEvaluation(decision, this.newId(), this.now());
    } catch (error) {
      this.logger.error('lp-lifecycle: evaluation write failed', {
        rule: decision.rule,
        error: describe(error),
      });
    }
  }

  /**
   * Record a decision that FIRED but was refused.
   *
   * `action` is forced to `'none'` and the original decision is preserved in
   * the snapshot. This is the difference between an audit log that says "we
   * rebalanced" and one that says "we wanted to rebalance and here is why we
   * did not".
   */
  private async recordRefusal(decision: Decision, refusal: Refusal): Promise<void> {
    this.logger.warn('lp-lifecycle: action refused', {
      rule: refusal.rule,
      reason: refusal.reason,
      intendedAction: decision.action,
    });
    await this.logEvaluation({
      action: 'none',
      rule: refusal.rule,
      reason: refusal.reason,
      snapshot: {
        ...decision.snapshot,
        refusedAction: decision.action,
        refusedRule: decision.rule,
        refusedReason: decision.reason,
      },
    });
  }

  // --- plumbing ------------------------------------------------------------

  /**
   * Track a background task so `stop()` can wait for it and so a rejection
   * surfaces as a log line rather than an unhandled rejection that kills a
   * process holding a key.
   */
  private track(work: Promise<unknown>): void {
    const tracked = work.catch((error: unknown) => {
      this.logger.error('lp-lifecycle: background task failed', { error: describe(error) });
    });
    this.inflight.add(tracked);
    void tracked.finally(() => {
      this.inflight.delete(tracked);
    });
  }
}

/** A `failed` command result. Exists so no call site can forget the null hash. */
function failure(reason: string): CommandResult {
  return { txHash: null, error: reason };
}

/**
 * The `Decision` a manual command is recorded under.
 *
 * `rule` is prefixed `manual.` so the audit log never confuses an action a
 * human asked for with one a rule fired for — those are different claims about
 * why money moved, and `summarize()` should not blur them. `snapshot.tokenId`
 * is mandatory for the same reason it is everywhere else: `unresolved.ts`
 * attributes a quarantined intent by that field, and an intent it cannot
 * attribute blocks EVERY position, not just this one.
 */
/**
 * Manual actions executed as a single on-chain step against an EXISTING
 * position. Excludes `compound_rebalance` (two steps) and `enter` (no existing
 * position — handled by `runEnter`, not `commandBuilder`).
 */
type SingleStepCommandAction = Exclude<LpCommand['action'], 'compound_rebalance' | 'enter' | 'increase'>;

function manualDecision(
  command: LpCommand & { action: SingleStepCommandAction },
  position: LpPosition,
  policy: AutomationPolicy,
): Decision {
  return {
    action: command.action,
    rule: `manual.${command.action}`,
    reason:
      `manual ${command.action} requested from the dashboard (command ${command.id}); ` +
      'running the same guard ladder as an automatic action',
    snapshot: {
      tokenId: position.tokenId,
      pool: position.pool.address,
      trigger: 'manual',
      commandId: command.id,
      requestedAt: command.requestedAt,
      policyVersion: policy.version,
      positionStatus: position.status,
      valueUsd: position.valueUsd,
      unclaimedFeesUsd: position.unclaimedFeesUsd,
    },
  };
}

function manualCompoundRebalanceStep(
  command: LpCommand,
  position: LpPosition,
  policy: AutomationPolicy,
  step: 'compound' | 'rebalance',
): Decision {
  return {
    action: step,
    rule: `manual.compound_rebalance.${step}`,
    reason:
      `manual compound_rebalance requested from the dashboard (command ${command.id}); ` +
      `${step} step — running the same guard ladder as an automatic action`,
    snapshot: {
      tokenId: position.tokenId,
      pool: position.pool.address,
      trigger: 'manual',
      commandId: command.id,
      requestedAt: command.requestedAt,
      policyVersion: policy.version,
      positionStatus: position.status,
      valueUsd: position.valueUsd,
      unclaimedFeesUsd: position.unclaimedFeesUsd,
      compoundRebalanceStep: step,
    },
  };
}

/**
 * The `Decision` an enter is recorded under.
 *
 * `snapshot.tokenId` is the COMMAND id, not a position id — there is no position
 * yet. It is still mandatory and still opaque-unique, which is exactly what
 * `unresolved.ts` needs: if the outcome write fails, the quarantine blocks this
 * one enter, not every position. `policy` is nullable so a refusal raised before
 * a policy is resolved (nothing wired, no default) still records a decision.
 */
function enterDecision(
  command: LpCommand,
  policy: AutomationPolicy | null,
  target?: { tickLower: number; tickUpper: number; strategy: RangeStrategy; currentTick: number },
): Decision {
  return {
    action: 'enter',
    rule: 'manual.enter',
    reason:
      `manual enter (Zap In) requested from the dashboard (command ${command.id}); ` +
      'running the same guard ladder as an automatic action',
    snapshot: {
      tokenId: command.id,
      pool: command.poolAddress,
      trigger: 'manual',
      commandId: command.id,
      requestedAt: command.requestedAt,
      ...(policy === null ? {} : { policyVersion: policy.version }),
      tokenInAddress: command.tokenInAddress ?? null,
      amountIn: command.amountIn ?? null,
      rangeStrategy: target?.strategy ?? command.rangeStrategy ?? null,
      ...(target === undefined
        ? {}
        : { tickLower: target.tickLower, tickUpper: target.tickUpper, currentTick: target.currentTick }),
    },
  };
}

function increaseDecision(command: LpCommand, position: LpPosition, policy: AutomationPolicy): Decision {
  return {
    action: 'increase',
    rule: 'manual.increase',
    reason:
      `manual increase (add liquidity) requested from the dashboard (command ${command.id}); ` +
      'running the same guard ladder as an automatic action',
    snapshot: {
      tokenId: position.tokenId,
      pool: position.pool.address,
      trigger: 'manual',
      commandId: command.id,
      requestedAt: command.requestedAt,
      policyVersion: policy.version,
      tokenInAddress: command.tokenInAddress ?? null,
      amountIn: command.amountIn ?? null,
      positionStatus: position.status,
      valueUsd: position.valueUsd,
      unclaimedFeesUsd: position.unclaimedFeesUsd,
    },
  };
}

/**
 * A stand-in `LpPosition` for an enter, so the execution funnel (lock, guards,
 * executor) can run for an action that has no real position yet.
 *
 * ONLY `tokenId` (the command id — lock key and quarantine attribution) and
 * `pool.address` / `pool.feeTierBps` are consulted by that path. Every other
 * field is a placeholder and MUST NOT be read as real position data: the value
 * and fees are zero because there is nothing here yet, and the token symbols /
 * decimals are unknown because the worker reads only addresses on-chain.
 */
function syntheticEnterPosition(
  command: LpCommand,
  state: PoolState,
  range: TickRange,
  now: number,
): LpPosition {
  return {
    tokenId: command.id,
    pool: {
      address: command.poolAddress,
      chainId: ROBINHOOD_CHAIN_ID,
      platform: 'uniswapv3',
      feeTierBps: state.feeUnits,
      token0: { address: state.token0, symbol: '', decimals: 0 },
      token1: { address: state.token1, symbol: '', decimals: 0 },
      tvlUsd: 0,
      volume24hUsd: 0,
      feeApr: 0,
    },
    status: 'in_range',
    tickLower: range.tickLower,
    tickUpper: range.tickUpper,
    currentTick: state.currentTick,
    valueUsd: 0,
    unclaimedFeesUsd: 0,
    openedAt: now,
    lastCompoundedAt: null,
  };
}

/**
 * Map what the funnel did onto what the dashboard is told.
 *
 * ONLY A GENUINE BROADCAST IS `done` (i.e. `error === null`). The distinction
 * that matters most here is `skipped_disarmed`: the whole ladder ran — guards,
 * calldata, dry run, audit intent — and the broadcast alone was skipped because
 * the process is not armed. Reporting that as success would tell an operator
 * their exit went through when nothing left this machine. Same rule the audit
 * log applies in `summarizeOutcome`, restated here rather than shared because
 * the two records are read by different audiences and must not drift silently.
 */
function commandResult(result: ActionResult | { status: 'position_busy'; reason: string }): CommandResult {
  switch (result.status) {
    case 'submitted':
      return recordedOutcomeToResult(result.recorded);
    case 'position_busy':
      return failure(result.reason);
    case 'refused':
    case 'simulation_failed':
      return failure(`${result.refusal.rule}: ${result.refusal.reason}`);
    case 'intent_write_failed':
      return failure(
        `the audit intent could not be written, so nothing was submitted: ${result.error}`,
      );
    case 'outcome_write_failed':
      // Submitted, but the audit log is now unresolved and the next startup
      // will quarantine this position. Say exactly that: the chain, not this
      // row, is the authority on what happened.
      return {
        txHash: result.recorded.txHash,
        error:
          'the transaction was submitted but its outcome could NOT be written to the audit log ' +
          `(${result.error}). This position is now quarantined until a human resolves it; ` +
          'check the chain — it is authoritative for what actually executed.',
      };
  }
}

function recordedOutcomeToResult(recorded: { txHash: string | null; error: string | null }): CommandResult {
  if (recorded.error === null) {
    return { txHash: recorded.txHash, error: null };
  }
  return { txHash: recorded.txHash, error: recorded.error };
}

function withPositionSnapshot(decision: Decision, position: LpPosition): Decision {
  return {
    ...decision,
    snapshot: {
      ...decision.snapshot,
      valueUsd: position.valueUsd,
      unclaimedFeesUsd: position.unclaimedFeesUsd,
    },
  };
}

function unresolvedPolicyDecision(position: LpPosition, reason: string): Decision {
  return {
    action: 'none',
    rule: 'lifecycle.policy_unresolved',
    reason,
    snapshot: { tokenId: position.tokenId, pool: position.pool.address },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultIdFactory(): string {
  // `randomUUID` is available on Node 18+ without importing `node:crypto`.
  return globalThis.crypto.randomUUID();
}
