// Lifecycle loop tests.
//
// PURE AND MOCKED. No network, no chain, no filesystem, no key. Every
// collaborator is a fake implementing the port from `src/lifecycle/types.ts`,
// including a stub `TransactionSigner` — which is the point: the behaviours
// worth testing here are the ones that cannot be provoked on demand against a
// live system.
//
// What each block is protecting:
//   • intent-write failure       -> a transaction that would not be logged is
//                                   never sent (fail closed).
//   • unresolved intent          -> a position that may have a transaction in
//                                   flight from a previous run is not touched.
//   • observed vs confirmed      -> only a confirmed crossing may broadcast.
//   • per-position lock          -> never two in-flight actions for one position.
//   • execution-time allowlist   -> a pool removed from the policy after the
//                                   decision is still refused.
//   • quiet ticks are logged     -> a rule that never fires stays
//                                   distinguishable from a broken rule.
//   • shutdown                   -> stops cleanly and waits for in-flight work.

import { describe, expect, it, vi } from 'vitest';
import type { AuditRecord, PendingAction } from '../src/audit/log.js';
import type { PreparedTransaction } from '../src/calldata/types.js';
import type {
  ConfirmedCrossing,
  CrossingEvent,
  ObservedCrossing,
  PoolWatcherCallbacks,
  WatchedRange,
  WatcherStatus,
} from '../src/ingest/rpc/types.js';
import { DEFAULT_POLICY } from '../src/policy/index.js';
import type {
  SignerStatus,
  SubmitOutcome,
  SubmitRequest,
  TransactionSigner,
} from '../src/signer/types.js';
import { LifecycleLoop } from '../src/lifecycle/loop.js';
import { PositionLocks } from '../src/lifecycle/locks.js';
import { Quarantine, deriveLastCompounded } from '../src/lifecycle/unresolved.js';
import { rangeFromCenter, recenterRange } from '../src/lifecycle/range.js';
import type {
  AuditPort,
  CalldataBuilder,
  Logger,
  PolicyBundle,
  PolicySource,
  PositionFeed,
  PositionWatcher,
} from '../src/lifecycle/types.js';
import type { Address, AutomationPolicy, Decision, LpPosition } from '../src/types.js';

// --- fixtures ---------------------------------------------------------------

const POOL = '0x69bfaf19d1f3f0c0a1b8f0a8a4c5d6e7f8091a2b' as Address;
const OTHER_POOL = '0x1111111111111111111111111111111111111111' as Address;
const SAFE = '0x2222222222222222222222222222222222222222' as Address;
const NOW = 1_800_000_000_000;

function policy(over: Partial<AutomationPolicy> = {}): AutomationPolicy {
  return { ...DEFAULT_POLICY, allowedPools: [POOL], ...over };
}

function position(over: Partial<LpPosition> = {}): LpPosition {
  return {
    tokenId: '395774',
    pool: {
      address: POOL,
      chainId: 4663,
      platform: 'uniswapv3',
      feeTierBps: 10_000,
      token0: { address: OTHER_POOL, symbol: 'WETH', decimals: 18 },
      token1: { address: SAFE, symbol: 'USDG', decimals: 6 },
      tvlUsd: 500_000,
      volume24hUsd: 100_000,
      feeApr: 0.4,
    },
    // Quiet by default: in range, so a bare poll tick takes no action. Tests
    // that exercise a rebalance either emit a watcher crossing (which carries its
    // own out-of-range tick) or set `status: 'out_of_range'` + an outside tick
    // explicitly. The default must be quiet now that the slow poll evaluates
    // rebalance too (the level-triggered backstop).
    status: 'in_range',
    tickLower: 141_800,
    tickUpper: 148_800,
    currentTick: 145_000,
    valueUsd: 250,
    unclaimedFeesUsd: 0,
    openedAt: NOW - 3_600_000,
    lastCompoundedAt: NOW - 3_600_000,
    ...over,
  };
}

function preparedTransaction(builtAt = NOW): PreparedTransaction {
  return Object.freeze({
    to: '0x73991a25c818bf1f1128deaab1492d45638de0d3' as Address,
    value: 0n,
    data: '0xb88d4fde0000',
    meta: {
      kind: 'adjust_range',
      chainId: 4663,
      platform: 'uniswapv3',
      from: SAFE,
      selector: '0xb88d4fde',
      estimateGas: null,
      gasLimit: null,
      usedDefaultGas: false,
      builtAt,
      txInfo: null,
    },
  }) as PreparedTransaction;
}

function crossing(phase: 'observed', tick?: number): ObservedCrossing;
function crossing(phase: 'confirmed', tick?: number): ConfirmedCrossing;
function crossing(phase: 'observed' | 'confirmed', tick = 200_000): CrossingEvent {
  const watched: WatchedRange = {
    tokenId: '395774',
    pool: POOL,
    tickLower: 141_800,
    tickUpper: 148_800,
  };
  const base = {
    watched,
    observation: {
      pool: POOL,
      tick,
      source: 'swap' as const,
      blockNumber: 100n,
      observedAt: NOW,
      mode: 'websocket' as const,
    },
    previousSide: 'inside' as const,
    side: 'above' as const,
    exitPercent: 42,
    ticksOutside: 51_200,
  };
  return phase === 'observed'
    ? { phase: 'observed', ...base }
    : { phase: 'confirmed', verifiedBy: 'slot0', depth: 3, ...base };
}

// --- fakes ------------------------------------------------------------------

class FakeSigner implements TransactionSigner {
  readonly submitted: SubmitRequest[] = [];
  readonly simulated: SubmitRequest[] = [];
  armState: 'armed' | 'disarmed' = 'armed';
  simulateResult: { ok: boolean; reason?: string } = { ok: true };
  outcome: SubmitOutcome = { status: 'broadcast', txHash: '0xdeadbeef' };
  /** Resolves when `submit` is entered; lets a test hold a transaction open. */
  onSubmit: (() => Promise<void>) | null = null;

  async getStatus(): Promise<SignerStatus> {
    return {
      armState: this.armState,
      operatorAddress: SAFE,
      safeAddress: SAFE,
      moduleAddress: SAFE,
      moduleEnabled: true,
      remainingDailyAllowanceWei: 10n ** 18n,
      chainId: 4663,
    };
  }

  async simulate(request: SubmitRequest): Promise<{ ok: boolean; reason?: string }> {
    this.simulated.push(request);
    return this.simulateResult;
  }

  async submit(request: SubmitRequest): Promise<SubmitOutcome> {
    this.submitted.push(request);
    if (this.onSubmit !== null) await this.onSubmit();
    return this.outcome;
  }
}

class FakeAudit implements AuditPort {
  records: AuditRecord[] = [];
  readonly intents: PendingAction[] = [];
  readonly outcomes: { pending: PendingAction; txHash: string | null; error: string | null }[] = [];
  readonly evaluations: Decision[] = [];
  failIntent = false;
  failOutcome = false;

  async read(): Promise<{ records: AuditRecord[]; malformed: string[] }> {
    return { records: this.records, malformed: [] };
  }

  async recordIntent(pending: PendingAction): Promise<void> {
    if (this.failIntent) throw new Error('disk full');
    this.intents.push(pending);
  }

  async recordOutcome(
    pending: PendingAction,
    outcome: { txHash: string | null; error: string | null },
    _now: number,
    outcomeSnapshot?: Record<string, unknown>,
  ): Promise<void> {
    if (this.failOutcome) throw new Error('disk full');
    this.outcomes.push({ pending, ...outcome, outcomeSnapshot });
  }

  async recordEvaluation(decision: Decision): Promise<void> {
    this.evaluations.push(decision);
  }

  rules(): string[] {
    return this.evaluations.map((decision) => decision.rule);
  }
}

class FakeWatcher implements PositionWatcher {
  started = false;
  stopped = false;
  watched: readonly WatchedRange[] = [];
  constructor(readonly callbacks: PoolWatcherCallbacks) {}
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  setWatched(ranges: readonly WatchedRange[]): void {
    this.watched = ranges;
  }
  getStatus(): WatcherStatus {
    return {
      mode: 'websocket',
      health: 'live',
      lowLatency: true,
      reason: null,
      lastBlockAt: NOW,
      lastBlockNumber: 100n,
      reconnectAttempts: 0,
      watchedPools: [POOL],
      watchedRanges: this.watched.length,
    };
  }
  emit(event: CrossingEvent): void {
    this.callbacks.onCrossing?.(event);
  }
}

class FakeCalldata implements CalldataBuilder {
  compoundCalls = 0;
  rebalanceCalls = 0;
  builtAt = NOW;
  failWith: Error | null = null;

  async compound(): Promise<PreparedTransaction> {
    this.compoundCalls += 1;
    if (this.failWith) throw this.failWith;
    return preparedTransaction(this.builtAt);
  }

  async rebalance(): Promise<PreparedTransaction> {
    this.rebalanceCalls += 1;
    if (this.failWith) throw this.failWith;
    return preparedTransaction(this.builtAt);
  }
}

class FakeFeed implements PositionFeed {
  constructor(public positions: LpPosition[]) {}
  loads = 0;
  async loadPositions(): Promise<LpPosition[]> {
    this.loads += 1;
    return this.positions;
  }
}

class FakePolicySource implements PolicySource {
  constructor(public bundle: PolicyBundle) {}
  async load(): Promise<PolicyBundle> {
    return this.bundle;
  }
}

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** A promise a test can hold open, to keep an action in flight on demand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let queued microtasks (the action pipeline) run to their next await. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

interface Harness {
  loop: LifecycleLoop;
  signer: FakeSigner;
  audit: FakeAudit;
  calldata: FakeCalldata;
  feed: FakeFeed;
  policySource: FakePolicySource;
  watcher: () => FakeWatcher;
}

function harness(
  over: {
    positions?: LpPosition[];
    policies?: AutomationPolicy[];
    bindings?: Record<string, number>;
    records?: AuditRecord[];
    now?: () => number;
  } = {},
): Harness {
  const signer = new FakeSigner();
  const audit = new FakeAudit();
  audit.records = over.records ?? [];
  const calldata = new FakeCalldata();
  const feed = new FakeFeed(over.positions ?? [position()]);
  const policySource = new FakePolicySource({
    policies: over.policies ?? [policy()],
    bindings: over.bindings ?? {},
  });

  let watcher: FakeWatcher | null = null;
  let counter = 0;

  const loop = new LifecycleLoop({
    policySource,
    positions: feed,
    calldata,
    signer,
    audit,
    createWatcher: (callbacks) => {
      watcher = new FakeWatcher(callbacks);
      return watcher;
    },
    logger: silentLogger,
    now: over.now ?? ((): number => NOW),
    newId: () => `id-${(counter += 1)}`,
    // Long enough that no test trips the poll timer by accident; ticks are
    // driven explicitly via `runPositionTick()`.
    options: { positionPollIntervalMs: 3_600_000, gasCostUsd: 1 },
  });

  return {
    loop,
    signer,
    audit,
    calldata,
    feed,
    policySource,
    watcher: () => {
      if (watcher === null) throw new Error('watcher not created yet — call loop.start() first');
      return watcher;
    },
  };
}

// --- the audit ordering property -------------------------------------------

describe('intent before broadcast', () => {
  it('does not submit when the intent write fails', async () => {
    const h = harness();
    h.audit.failIntent = true;
    await h.loop.start();

    h.watcher().emit(crossing('confirmed'));
    await h.loop.settle();

    expect(h.signer.simulated).toHaveLength(1); // the dry run still ran
    expect(h.signer.submitted).toEqual([]); // ...and then we stopped
    expect(h.audit.outcomes).toEqual([]);
    await h.loop.stop();
  });

  it('writes the intent before submitting, and the outcome after', async () => {
    const h = harness();
    const order: string[] = [];
    h.signer.onSubmit = async () => {
      order.push('submit');
    };
    const originalIntent = h.audit.recordIntent.bind(h.audit);
    h.audit.recordIntent = async (pending: PendingAction) => {
      order.push('intent');
      await originalIntent(pending);
    };
    const originalOutcome = h.audit.recordOutcome.bind(h.audit);
    h.audit.recordOutcome = async (pending, outcome, now) => {
      order.push('outcome');
      await originalOutcome(pending, outcome, now);
    };

    await h.loop.start();
    h.watcher().emit(crossing('confirmed'));
    await h.loop.settle();

    expect(order).toEqual(['intent', 'submit', 'outcome']);
    expect(h.audit.outcomes[0]?.txHash).toBe('0xdeadbeef');
    await h.loop.stop();
  });

  it('leaves the intent unresolved when the outcome write fails', async () => {
    const h = harness();
    h.audit.failOutcome = true;
    await h.loop.start();

    h.watcher().emit(crossing('confirmed'));
    await h.loop.settle();

    expect(h.signer.submitted).toHaveLength(1);
    expect(h.audit.outcomes).toEqual([]);
    // The intent record is on disk with no resolution — which is exactly what
    // the next startup is supposed to quarantine on.
    expect(h.audit.intents).toHaveLength(1);
    await h.loop.stop();
  });

  it('records a disarmed skip as a failure, never as a completed action', async () => {
    const h = harness();
    h.signer.armState = 'disarmed';
    h.signer.outcome = { status: 'skipped_disarmed', simulated: true };
    await h.loop.start();

    h.watcher().emit(crossing('confirmed'));
    await h.loop.settle();

    expect(h.audit.outcomes[0]?.txHash).toBeNull();
    expect(h.audit.outcomes[0]?.error).toMatch(/disarmed/);
    await h.loop.stop();
  });
});

// --- unresolved intents on startup -----------------------------------------

describe('unresolved intents block the position', () => {
  const unresolvedIntent = (tokenId: string | null): AuditRecord => ({
    id: 'stranded-1',
    phase: 'intent',
    timestamp: NOW - 60_000,
    action: 'rebalance',
    rule: 'rebalance.range_exit',
    reason: 'price left the range',
    snapshot: tokenId === null ? {} : { tokenId },
    txHash: null,
    error: null,
  });

  it('refuses to act on a position with an unresolved intent', async () => {
    const h = harness({ records: [unresolvedIntent('395774')] });
    await h.loop.start();

    h.watcher().emit(crossing('confirmed'));
    await h.loop.settle();

    expect(h.signer.submitted).toEqual([]);
    expect(h.calldata.rebalanceCalls).toBe(0); // refused before spending a round trip
    expect(h.audit.rules()).toContain('lifecycle.unresolved_intent');
    await h.loop.stop();
  });

  it('blocks every position when an unresolved intent cannot be attributed to one', async () => {
    const quarantine = Quarantine.fromRecords([unresolvedIntent(null)]);
    expect(quarantine.blocksEverything).toBe(true);
    expect(quarantine.blocks('any-token-at-all')).toBe(true);
    expect(quarantine.describe('any-token-at-all')).toMatch(/EVERY position/);
  });

  it('treats an intent with a matching outcome as resolved', async () => {
    const resolved: AuditRecord[] = [
      unresolvedIntent('395774'),
      { ...unresolvedIntent('395774'), phase: 'success', txHash: '0xabc' },
    ];
    const h = harness({ records: resolved });
    await h.loop.start();

    h.watcher().emit(crossing('confirmed'));
    await h.loop.settle();

    expect(h.signer.submitted).toHaveLength(1);
    await h.loop.stop();
  });

  it('never clears its own quarantine while the process runs', async () => {
    const h = harness({ records: [unresolvedIntent('395774')] });
    await h.loop.start();

    for (let i = 0; i < 3; i += 1) {
      h.watcher().emit(crossing('confirmed'));
      await h.loop.settle();
    }

    expect(h.signer.submitted).toEqual([]);
    expect(h.loop.getState().quarantinedIntents).toBe(1);
    await h.loop.stop();
  });
});

// --- observed vs confirmed --------------------------------------------------

describe('only confirmed crossings may broadcast', () => {
  it('warms calldata on observed but never submits', async () => {
    const h = harness();
    await h.loop.start();

    h.watcher().emit(crossing('observed'));
    await h.loop.settle();

    expect(h.calldata.rebalanceCalls).toBe(1); // speculative work happened
    expect(h.signer.submitted).toEqual([]); // nothing was broadcast
    expect(h.signer.simulated).toEqual([]);
    // The warm-up is logged as a non-action so it cannot be mistaken for one.
    const warm = h.audit.evaluations.find((d) => d.rule.startsWith('lifecycle.warm.'));
    expect(warm?.action).toBe('none');
    await h.loop.stop();
  });

  it('submits on confirmed, reusing the calldata warmed by the observed phase', async () => {
    const h = harness();
    await h.loop.start();

    h.watcher().emit(crossing('observed'));
    await h.loop.settle();
    h.watcher().emit(crossing('confirmed'));
    await h.loop.settle();

    expect(h.calldata.rebalanceCalls).toBe(1); // reused, not rebuilt
    expect(h.signer.submitted).toHaveLength(1);
    expect(h.signer.submitted[0]?.action).toBe('rebalance');
    await h.loop.stop();
  });

  it('drops warmed calldata when the crossing reverts', async () => {
    const h = harness();
    await h.loop.start();

    h.watcher().emit(crossing('observed'));
    await h.loop.settle();
    expect(h.loop.getState().warm).toBe(1);

    h.watcher().emit({ ...crossing('observed'), phase: 'reverted', reason: 'reorg' });
    await h.loop.settle();

    expect(h.loop.getState().warm).toBe(0);
    expect(h.signer.submitted).toEqual([]);
    await h.loop.stop();
  });

  it('rebuilds rather than reusing calldata that has gone stale', async () => {
    let clock = NOW;
    const h = harness({ now: () => clock });
    await h.loop.start();

    h.watcher().emit(crossing('observed'));
    await h.loop.settle();

    clock = NOW + 120_000; // past the 30s default freshness window
    h.calldata.builtAt = clock;
    h.watcher().emit(crossing('confirmed'));
    await h.loop.settle();

    expect(h.calldata.rebalanceCalls).toBe(2);
    expect(h.signer.submitted).toHaveLength(1);
    await h.loop.stop();
  });

  it('does not submit when the dry run fails', async () => {
    const h = harness();
    h.signer.simulateResult = { ok: false, reason: 'STF' };
    await h.loop.start();

    h.watcher().emit(crossing('confirmed'));
    await h.loop.settle();

    expect(h.signer.submitted).toEqual([]);
    expect(h.audit.intents).toEqual([]); // no intent, so nothing to quarantine
    expect(h.audit.rules()).toContain('lifecycle.simulation_failed');
    await h.loop.stop();
  });
});

// --- the per-position lock --------------------------------------------------

describe('per-position serialization', () => {
  it('refuses a second action while one is in flight for the same position', async () => {
    const h = harness();
    const gate = deferred();
    h.signer.onSubmit = () => gate.promise;

    await h.loop.start();

    h.watcher().emit(crossing('confirmed'));
    await flush(); // let the first action reach `submit`

    h.watcher().emit(crossing('confirmed')); // arrives mid-broadcast
    await flush();

    gate.resolve();
    await h.loop.settle();

    expect(h.signer.submitted).toHaveLength(1);
    expect(h.audit.rules()).toContain('lifecycle.position_busy');
    await h.loop.stop();
  });

  it('releases the lock even when the action throws', async () => {
    const locks = new PositionLocks();
    await expect(
      locks.tryRun('395774', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(locks.isHeld('395774')).toBe(false);

    const second = await locks.tryRun('395774', async () => 'ok');
    expect(second).toEqual({ ran: true, value: 'ok' });
  });

  it('does not serialize across different positions', async () => {
    const locks = new PositionLocks();
    const gate = deferred();
    const first = locks.tryRun('a', () => gate.promise);
    const second = await locks.tryRun('b', async () => 'ran');
    expect(second).toEqual({ ran: true, value: 'ran' });
    gate.resolve();
    await first;
  });
});

// --- the allowlist, at execution time --------------------------------------

describe('policy allowlist is enforced at execution time', () => {
  it('refuses a pool that was removed from the allowlist after the decision', async () => {
    const h = harness();
    await h.loop.start();

    // Warm the calldata while the pool is still approved...
    h.watcher().emit(crossing('observed'));
    await h.loop.settle();
    expect(h.loop.getState().warm).toBe(1);

    // ...then the operator un-ticks it in the dashboard.
    h.policySource.bundle = { policies: [policy({ allowedPools: [] })], bindings: {} };
    await h.loop.runPositionTick();

    h.watcher().emit(crossing('confirmed'));
    await h.loop.settle();

    expect(h.signer.submitted).toEqual([]);
    expect(h.audit.rules()).toContain('lifecycle.pool_not_allowed');
    await h.loop.stop();
  });

  it('refuses a position whose pinned policy version cannot be resolved', async () => {
    const h = harness({ bindings: { '395774': 99 } });
    await h.loop.start();

    h.watcher().emit(crossing('confirmed'));
    await h.loop.settle();

    expect(h.signer.submitted).toEqual([]);
    expect(h.audit.rules()).toContain('lifecycle.policy_unresolved');
    await h.loop.stop();
  });

  it('refuses to start with no valid policy at all', async () => {
    const h = harness({ policies: [{ ...policy(), version: -1 }] });
    await expect(h.loop.start()).rejects.toThrow(/no valid policy/);
  });
});

// --- every tick is logged ---------------------------------------------------

describe('evaluation logging', () => {
  it('records a tick that produced no action', async () => {
    // In range and no fees: neither trigger fires.
    const quiet = position({ status: 'in_range', currentTick: 145_000, unclaimedFeesUsd: 0 });
    const h = harness({ positions: [quiet] });
    await h.loop.start();

    expect(h.audit.evaluations.length).toBeGreaterThan(0);
    expect(h.audit.evaluations.every((decision) => decision.action === 'none')).toBe(true);
    expect(h.audit.rules()).toContain('compound.no_fees');
    expect(h.signer.submitted).toEqual([]);
    await h.loop.stop();
  });

  it('logs a refusal as action:none while preserving the refused decision', async () => {
    const h = harness({ policies: [policy({ allowedPools: [OTHER_POOL] })] });
    await h.loop.start();

    h.watcher().emit(crossing('confirmed'));
    await h.loop.settle();

    const refusal = h.audit.evaluations.find((d) => d.rule === 'lifecycle.pool_not_allowed');
    expect(refusal?.action).toBe('none');
    expect(refusal?.snapshot['refusedAction']).toBe('rebalance');
    expect(refusal?.snapshot['refusedRule']).toBe('rebalance.range_exit');
    await h.loop.stop();
  });

  it('logs a calldata build failure without writing an intent', async () => {
    const h = harness();
    h.calldata.failWith = new Error('Krystal 500');
    await h.loop.start();

    h.watcher().emit(crossing('confirmed'));
    await h.loop.settle();

    expect(h.audit.intents).toEqual([]);
    expect(h.audit.rules()).toContain('lifecycle.calldata_failed');
    await h.loop.stop();
  });

  it('compounds when the fees-vs-gas arm fires, and logs the intent decision', async () => {
    const rich = position({ status: 'in_range', currentTick: 145_000, unclaimedFeesUsd: 50 });
    const h = harness({ positions: [rich] });
    await h.loop.start();

    expect(h.signer.submitted).toHaveLength(1);
    expect(h.signer.submitted[0]?.action).toBe('compound');
    expect(h.audit.intents[0]?.decision.rule).toBe('compound.fees_vs_gas');
    // The acting tick is recorded by the intent/outcome pair, NOT additionally
    // as an evaluation — otherwise `summarize()` double-counts it.
    expect(h.audit.rules()).not.toContain('compound.fees_vs_gas');
    await h.loop.stop();
  });

  it('skips autonomous compound when auto-compound is disabled in policy', async () => {
    const rich = position({ status: 'in_range', currentTick: 145_000, unclaimedFeesUsd: 50 });
    const h = harness({
      positions: [rich],
      policies: [policy({ compoundTrigger: { ...DEFAULT_POLICY.compoundTrigger, enabled: false } })],
    });
    await h.loop.start();

    expect(h.signer.submitted).toEqual([]);
    expect(h.calldata.compoundCalls).toBe(0);
    expect(h.audit.rules()).toContain('policy.auto_compound_off');
    await h.loop.stop();
  });

  it('skips autonomous rebalance when auto-rebalance is disabled in policy', async () => {
    const h = harness({
      policies: [policy({ rebalanceTrigger: { ...DEFAULT_POLICY.rebalanceTrigger, enabled: false } })],
    });
    await h.loop.start();

    h.watcher().emit(crossing('confirmed'));
    await h.loop.settle();

    expect(h.signer.submitted).toEqual([]);
    expect(h.calldata.rebalanceCalls).toBe(0);
    expect(h.audit.rules()).toContain('policy.auto_rebalance_off');
    await h.loop.stop();
  });
});

// --- shutdown ---------------------------------------------------------------

describe('shutdown', () => {
  it('stops the watcher and clears state', async () => {
    const h = harness();
    await h.loop.start();
    expect(h.watcher().started).toBe(true);

    await h.loop.stop();

    expect(h.watcher().stopped).toBe(true);
    expect(h.loop.getState().running).toBe(false);
    expect(h.loop.getState().warm).toBe(0);
  });

  it('waits for an in-flight action instead of abandoning it mid-write', async () => {
    const h = harness();
    const gate = deferred();
    h.signer.onSubmit = () => gate.promise;

    await h.loop.start();
    h.watcher().emit(crossing('confirmed'));
    await flush();

    let stopped = false;
    const stopping = h.loop.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false); // still waiting on the in-flight submit

    gate.resolve();
    await stopping;

    expect(stopped).toBe(true);
    expect(h.audit.outcomes).toHaveLength(1); // the outcome write completed
  });

  it('is idempotent and ignores crossings after it', async () => {
    const h = harness();
    await h.loop.start();
    const watcher = h.watcher();

    await h.loop.stop();
    await h.loop.stop();

    watcher.emit(crossing('confirmed'));
    await h.loop.settle();
    expect(h.signer.submitted).toEqual([]);
  });
});

// --- supporting pure logic --------------------------------------------------

describe('deriveLastCompounded', () => {
  const record = (over: Partial<AuditRecord>): AuditRecord => ({
    id: 'x',
    phase: 'success',
    timestamp: NOW,
    action: 'compound',
    rule: 'compound.fees_vs_gas',
    reason: '',
    snapshot: { tokenId: '395774' },
    txHash: '0xabc',
    error: null,
    ...over,
  });

  it('takes the latest successful broadcast per position', () => {
    const map = deriveLastCompounded([
      record({ timestamp: NOW - 1000 }),
      record({ timestamp: NOW }),
      record({ timestamp: NOW - 5000, snapshot: { tokenId: 'other' } }),
    ]);
    expect(map.get('395774')).toBe(NOW);
    expect(map.get('other')).toBe(NOW - 5000);
  });

  it('ignores intents, failures, and outcomes with no transaction hash', () => {
    const map = deriveLastCompounded([
      record({ phase: 'intent' }),
      record({ phase: 'failure', error: 'reverted' }),
      record({ txHash: null }),
    ]);
    expect(map.size).toBe(0);
  });
});

describe('recenterRange', () => {
  // Pool default is feeTierBps 10_000 -> spacing 200; currentTick 200_000.
  // Expected bounds computed against `tick = round(ln(1±hw)/ln(1.0001))`,
  // snapped outwards to 200. See RANGE_STRATEGY_HALF_WIDTH.

  it('narrow: builds a ±5% price band, snapped outwards, centred on current tick', () => {
    const result = recenterRange(position({ currentTick: 200_000 }), 'narrow');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.range).toEqual({ tickLower: 199_400, tickUpper: 200_600 });
    expect(result.range.tickLower % 200).toBe(0);
    expect(result.range.tickUpper % 200).toBe(0);
  });

  it('wide is strictly wider than narrow around the same tick', () => {
    const narrow = recenterRange(position({ currentTick: 200_000 }), 'narrow');
    const wide = recenterRange(position({ currentTick: 200_000 }), 'wide');
    expect(wide.ok && narrow.ok).toBe(true);
    if (!wide.ok || !narrow.ok) return;
    expect(wide.range).toEqual({ tickLower: 197_600, tickUpper: 202_000 });
    const w = (r: { tickLower: number; tickUpper: number }) => r.tickUpper - r.tickLower;
    expect(w(wide.range)).toBeGreaterThan(w(narrow.range));
  });

  it('full: snaps the whole usable range inwards to valid multiples', () => {
    const result = recenterRange(position({ currentTick: 200_000 }), 'full');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.range).toEqual({ tickLower: -887_200, tickUpper: 887_200 });
  });

  it('narrow follows the current tick, not the old range', () => {
    // Old range is irrelevant now — the band re-centres wherever price is.
    const moved = recenterRange(position({ currentTick: 50_000 }), 'narrow');
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect((moved.range.tickLower + moved.range.tickUpper) / 2).toBeCloseTo(50_000, -3);
  });

  it('refuses a pool whose fee tier has no known tick spacing', () => {
    const odd = position();
    const result = recenterRange({ ...odd, pool: { ...odd.pool, feeTierBps: 7 } }, 'narrow');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/tick spacing/);
  });

  it('refuses when the target range is the one we already hold', () => {
    const centred = position({ tickLower: 199_400, tickUpper: 200_600, currentTick: 200_000 });
    const result = recenterRange(centred, 'narrow');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/identical/);
  });
});

describe('rangeFromCenter (shared by rebalance and enter)', () => {
  // feeUnits 10_000 -> spacing 200. Matches recenterRange's geometry exactly,
  // since recenterRange delegates here; the difference is enter has no existing
  // range, so there is no "identical range" guard to trip.

  it('narrow: same ±5% band recenterRange produces, without needing a position', () => {
    const result = rangeFromCenter(200_000, 10_000, 'narrow');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.range).toEqual({ tickLower: 199_400, tickUpper: 200_600 });
  });

  it('does NOT refuse a range that happens to equal a hypothetical current one', () => {
    // The very input recenterRange rejects as "identical" is fine for an enter —
    // there is no current range to be identical to.
    const result = rangeFromCenter(200_000, 10_000, 'narrow');
    expect(result.ok).toBe(true);
  });

  it('full snaps the whole usable range inwards to valid multiples', () => {
    const result = rangeFromCenter(200_000, 10_000, 'full');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.range).toEqual({ tickLower: -887_200, tickUpper: 887_200 });
  });

  it('refuses a fee unit with no known tick spacing', () => {
    const result = rangeFromCenter(200_000, 7, 'narrow');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/tick spacing/);
  });

  it('refuses a non-integer current tick', () => {
    const result = rangeFromCenter(200_000.5, 10_000, 'narrow');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not an integer/);
  });
});

describe('the loop never reaches the signer from an observed crossing', () => {
  it('has exactly one call site for submit, guarded by the confirmed phase', async () => {
    const h = harness();
    const submit = vi.spyOn(h.signer, 'submit');
    await h.loop.start();

    for (let i = 0; i < 5; i += 1) {
      h.watcher().emit(crossing('observed'));
      await h.loop.settle();
    }

    expect(submit).not.toHaveBeenCalled();
    await h.loop.stop();
  });
});

// ===========================================================================
// The rebalance backstop on the slow poll (level-triggered).
//
// Regression for position #418840: it crossed its upper bound right at the
// boundary (exit ~0% < 5% threshold), the watcher's one-shot check declined,
// and — because the watcher only fires on a side CHANGE — nothing re-evaluated
// rebalance as price kept drifting out. The position sat out of range for 20+
// minutes. The poll must catch a drifted position with no fresh crossing.
// ===========================================================================

describe('rebalance backstop on the slow poll', () => {
  it('rebalances an out-of-range position on a poll tick with NO watcher crossing', async () => {
    // The #418840 case: drifted well past the band, no fresh crossing event.
    const h = harness({ positions: [position({ status: 'out_of_range', currentTick: 200_000 })] });
    await h.loop.start(); // start() runs one runPositionTick — no crossing emitted
    await h.loop.settle();

    expect(h.calldata.rebalanceCalls).toBe(1);
    expect(h.signer.submitted.map((s) => s.action)).toContain('rebalance');
    await h.loop.stop();
  });

  it('leaves an in-range position alone on the poll', async () => {
    const h = harness({ positions: [position({ status: 'in_range', currentTick: 145_000 })] });
    await h.loop.start();
    await h.loop.settle();

    expect(h.calldata.rebalanceCalls).toBe(0);
    await h.loop.stop();
  });

  it('does not autonomously rebalance when auto-rebalance is off, but records why', async () => {
    const h = harness({
      positions: [position({ status: 'out_of_range', currentTick: 200_000 })],
      policies: [policy({ rebalanceTrigger: { enabled: false, rangeExitPercent: 5, rangeStrategy: 'narrow' } })],
    });
    await h.loop.start();
    await h.loop.settle();

    expect(h.calldata.rebalanceCalls).toBe(0);
    expect(h.audit.rules()).toContain('policy.auto_rebalance_off');
    await h.loop.stop();
  });
});
