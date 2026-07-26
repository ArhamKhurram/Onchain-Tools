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
import type { SubmitOutcome, TransactionSigner } from '../signer/types.js';
import type { AutomationPolicy, Decision, LpPosition } from '../types.js';
import type { CommandResult, CommandSource, LpCommand } from './commandSource.js';
import { ActionExecutor } from './executor.js';
import { PositionLocks } from './locks.js';
import { recenterRange } from './range.js';
import { deriveLastCompounded, Quarantine } from './unresolved.js';
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

    this.executor = new ActionExecutor({
      audit: deps.audit,
      signer: deps.signer,
      logger: this.logger,
      now: this.now,
      newId: this.newId,
      quarantine: () => this.quarantine,
      calldataMaxAgeMs: this.calldataMaxAgeMs,
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
   * evaluate the compound trigger for every position.
   *
   * Rebalance is NOT evaluated here — it is driven by the watcher, which is the
   * only component with an authoritative current tick (plan §3). Re-deriving it
   * from Krystal's cached price is precisely the thing `ingest/krystal/
   * positions.ts` refuses to do.
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
      await this.evaluateCompound(position);
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
    const decision = shouldRebalance(position, resolved.policy);

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

    return { position, policy: resolved.policy, decision: enriched };
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

    const decision = manualDecision(command, position, policy);

    const build = this.commandBuilder(command, position, policy);
    if (typeof build === 'string') {
      await this.recordRefusal(decision, { rule: 'lifecycle.manual_unavailable', reason: build });
      return failure(build);
    }

    const result = await this.act({
      position,
      policy,
      decision,
      action: command.action,
      build,
    });

    return commandResult(result);
  }

  /**
   * Pick the calldata builder for a manual action, or return the reason there
   * isn't one. A string return is a refusal, not an error.
   */
  private commandBuilder(
    command: LpCommand,
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
    const { position, policy, decision, action, build } = request;

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
          if (action === 'compound' && result.outcome.status === 'broadcast') {
            // Keep the in-memory backstop clock in step with the log we just
            // wrote, so the next tick does not re-fire the interval arm.
            this.lastCompounded.set(position.tokenId, this.now());
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

    return attempt.value;
  }

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
function manualDecision(
  command: LpCommand,
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
      return submitOutcomeToResult(result.outcome);
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
        txHash: result.outcome.status === 'broadcast' ? result.outcome.txHash : null,
        error:
          'the transaction was submitted but its outcome could NOT be written to the audit log ' +
          `(${result.error}). This position is now quarantined until a human resolves it; ` +
          'check the chain — it is authoritative for what actually executed.',
      };
  }
}

function submitOutcomeToResult(outcome: SubmitOutcome): CommandResult {
  switch (outcome.status) {
    case 'broadcast':
      return { txHash: outcome.txHash, error: null };
    case 'skipped_disarmed':
      return failure(
        'skipped_disarmed: the signer is disarmed, so the action was evaluated, simulated and ' +
          'audited but NOTHING WAS BROADCAST. Arm the worker (LP_ARMED) to execute it.',
      );
    case 'rejected':
      return failure(`rejected at ${outcome.stage}: ${outcome.reason}`);
    case 'failed':
      return { txHash: outcome.txHash, error: `failed: ${outcome.reason}` };
  }
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
