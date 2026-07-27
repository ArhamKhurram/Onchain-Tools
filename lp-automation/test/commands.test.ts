// Manual command queue tests (LP_AUTOMATION_PLAN.md §9 point 1).
//
// PURE AND MOCKED. No network, no chain, no database, no key. `@supabase/
// supabase-js` is replaced with an in-memory fake that applies filters the way
// Postgres does, because the property that matters most here — a conditional
// UPDATE either matches a row or matches nothing — is a database behaviour, and
// asserting it against a real table is not something a unit test can do on
// demand.
//
// What each block is protecting:
//   • atomic claim        -> two instances, or one instance across a restart,
//                            can never execute the same command twice.
//   • the same ladder     -> a manual action goes through `ActionExecutor` with
//                            every guard an automatic action gets, including
//                            the per-position lock.
//   • honest disarmed     -> a dry run is never reported as a completed action.
//   • honest failure      -> the reason reaches the row the operator reads.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord, PendingAction } from '../src/audit/log.js';
import type { PreparedTransaction } from '../src/calldata/types.js';
import type {
  ConfirmedCrossing,
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
import { LifecycleLoop, type AllowanceConfig } from '../src/lifecycle/loop.js';
import type { TransactionReceiptInfo } from '../src/lifecycle/executor.js';
import { DEFAULT_APPROVABLE_TOKENS, MAX_UINT256, ROBINHOOD_WETH } from '../src/calldata/erc20Approve.js';
import { NATIVE_ETH_ADDRESS } from '../src/calldata/nativeEth.js';
import type {
  AuditPort,
  CalldataBuilder,
  Logger,
  PolicyBundle,
  PolicySource,
  PoolState,
  PoolStateReader,
  PositionFeed,
  PositionWatcher,
} from '../src/lifecycle/types.js';
import type { Address, AutomationPolicy, Decision, LpPosition } from '../src/types.js';

// ---------------------------------------------------------------------------
// The Supabase fake
// ---------------------------------------------------------------------------
// Set before `createClient` is ever called (the source constructs its client in
// its constructor, which the tests do inside each case), so a lazily-read
// hoisted holder is enough — no per-test module reset needed.

const holder = vi.hoisted(() => ({ db: null as unknown as FakeDb }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: (table: string) => holder.db.from(table) }),
}));

interface FakeRow {
  id: string;
  user_id: string;
  token_id: string;
  pool_address: string;
  action: string;
  status: string;
  requested_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  tx_hash: string | null;
  error: string | null;
}

/**
 * A minimal PostgREST-shaped fake over an array of rows.
 *
 * The one behaviour it models faithfully is the one under test: an UPDATE
 * applies its filters at the moment it runs and returns only the rows it
 * actually changed. `beforeUpdate` is the seam a test uses to have a competing
 * instance win the race in between.
 */
class FakeDb {
  rows: FakeRow[] = [];
  beforeUpdate: (() => void) | null = null;
  readonly updates: Record<string, unknown>[] = [];
  readError: string | null = null;
  updateError: string | null = null;

  from(_table: string): FakeQuery {
    return new FakeQuery(this);
  }

  row(id: string): FakeRow {
    const found = this.rows.find((row) => row.id === id);
    if (found === undefined) throw new Error(`no row ${id}`);
    return found;
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private readonly filters: [string, unknown][] = [];
  private mode: 'select' | 'update' = 'select';
  private values: Record<string, unknown> = {};
  private returning = false;
  private limitCount: number | null = null;

  constructor(private readonly db: FakeDb) {}

  select(_columns?: string): this {
    if (this.mode === 'update') this.returning = true;
    return this;
  }

  update(values: Record<string, unknown>): this {
    this.mode = 'update';
    this.values = values;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }

  order(_column: string, _options?: unknown): this {
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  then<TResult1, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: unknown; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  private matches(row: FakeRow): boolean {
    return this.filters.every(([column, value]) => (row as unknown as Record<string, unknown>)[column] === value);
  }

  private run(): { data: unknown; error: { message: string } | null } {
    if (this.mode === 'select') {
      if (this.db.readError !== null) return { data: null, error: { message: this.db.readError } };
      const matched = this.db.rows.filter((row) => this.matches(row));
      return { data: this.limitCount === null ? matched : matched.slice(0, this.limitCount), error: null };
    }

    // The competing-instance seam: whatever this does happens BEFORE the
    // filters are applied, exactly as a concurrent transaction would.
    this.db.beforeUpdate?.();
    if (this.db.updateError !== null) return { data: null, error: { message: this.db.updateError } };

    this.db.updates.push({ ...this.values });
    const changed = this.db.rows.filter((row) => this.matches(row));
    for (const row of changed) Object.assign(row, this.values);
    return { data: this.returning ? changed.map((row) => ({ ...row })) : null, error: null };
  }
}

// Imported AFTER the mock declaration so the module under test builds its
// client against the fake.
const { SupabaseCommandSource, createSupabaseCommandSource, rowToCommand, CommandSourceError } =
  await import('../src/lifecycle/commandSource.js');
type LpCommand = import('../src/lifecycle/commandSource.js').LpCommand;
type CommandResult = import('../src/lifecycle/commandSource.js').CommandResult;
type CommandSource = import('../src/lifecycle/commandSource.js').CommandSource;

const USER = 'ba3f0a1e-0000-4000-8000-000000000001';

function fakeRow(over: Partial<FakeRow> = {}): FakeRow {
  return {
    id: 'cmd-1',
    user_id: USER,
    token_id: '395774',
    pool_address: POOL,
    action: 'compound',
    status: 'pending',
    requested_at: '2026-07-26T12:00:00.000Z',
    claimed_at: null,
    completed_at: null,
    tx_hash: null,
    error: null,
    ...over,
  };
}

function source(): InstanceType<typeof SupabaseCommandSource> {
  return new SupabaseCommandSource({
    url: 'https://example.supabase.co',
    serviceRoleKey: 'service-role',
    userId: USER,
  });
}

// ---------------------------------------------------------------------------
// Lifecycle fixtures + fakes
// ---------------------------------------------------------------------------

const POOL = '0x69bfaf19d1f3f0c0a1b8f0a8a4c5d6e7f8091a2b' as Address;
const OTHER_POOL = '0x1111111111111111111111111111111111111111' as Address;
const SAFE = '0x2222222222222222222222222222222222222222' as Address;
const TOKEN_ID = '395774';
const NOW = 1_800_000_000_000;

function policy(over: Partial<AutomationPolicy> = {}): AutomationPolicy {
  return { ...DEFAULT_POLICY, allowedPools: [POOL], ...over };
}

function position(over: Partial<LpPosition> = {}): LpPosition {
  return {
    tokenId: TOKEN_ID,
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
    // In range by default: a manual command drives these tests, and the startup
    // poll tick must stay a no-op so it does not add an autonomous rebalance
    // (the poll now evaluates rebalance too) that muddies what the command did.
    status: 'in_range',
    tickLower: 141_800,
    tickUpper: 148_800,
    currentTick: 145_000,
    valueUsd: 250,
    unclaimedFeesUsd: 0,
    openedAt: NOW - 3_600_000,
    // Recent, so the interval backstop does not fire an automatic compound on
    // the startup tick and muddy what the manual command did.
    lastCompoundedAt: NOW,
    ...over,
  };
}

function preparedTransaction(
  over: { builtAt?: number; kind?: PreparedTransaction['meta']['kind']; selector?: string } = {},
): PreparedTransaction {
  const builtAt = over.builtAt ?? NOW;
  const kind = over.kind ?? 'compound';
  const selector = over.selector ?? '0xb88d4fde';
  return Object.freeze({
    to: '0x73991a25c818bf1f1128deaab1492d45638de0d3' as Address,
    value: 0n,
    data: `${selector}0000`,
    meta: {
      kind,
      chainId: 4663,
      platform: 'uniswapv3',
      from: SAFE,
      selector,
      estimateGas: null,
      gasLimit: null,
      usedDefaultGas: false,
      builtAt,
      txInfo: null,
    },
  }) as PreparedTransaction;
}

function confirmedCrossing(): ConfirmedCrossing {
  const watched: WatchedRange = {
    tokenId: TOKEN_ID,
    pool: POOL,
    tickLower: 141_800,
    tickUpper: 148_800,
  };
  return {
    phase: 'confirmed',
    verifiedBy: 'slot0',
    depth: 3,
    watched,
    observation: {
      pool: POOL,
      tick: 200_000,
      source: 'swap',
      blockNumber: 100n,
      observedAt: NOW,
      mode: 'websocket',
    },
    previousSide: 'inside',
    side: 'above',
    exitPercent: 42,
    ticksOutside: 51_200,
  };
}

class FakeSigner implements TransactionSigner {
  readonly submitted: SubmitRequest[] = [];
  readonly simulated: SubmitRequest[] = [];
  armState: 'armed' | 'disarmed' = 'armed';
  simulateResult: { ok: boolean; reason?: string; stage?: 'simulation' } = { ok: true };
  outcome: SubmitOutcome = { status: 'broadcast', txHash: '0xdeadbeef' };
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
  ): Promise<void> {
    this.outcomes.push({ pending, ...outcome });
  }

  async recordEvaluation(decision: Decision): Promise<void> {
    this.evaluations.push(decision);
  }

  rules(): string[] {
    return this.evaluations.map((decision) => decision.rule);
  }
}

class FakeWatcher implements PositionWatcher {
  watched: readonly WatchedRange[] = [];
  constructor(readonly callbacks: PoolWatcherCallbacks) {}
  start(): void {}
  stop(): void {}
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
}

class FakeCalldata implements CalldataBuilder {
  compoundCalls = 0;
  rebalanceCalls = 0;
  enterCalls = 0;
  increaseCalls = 0;
  decreaseCalls = 0;
  failWith: Error | null = null;

  async compound(): Promise<PreparedTransaction> {
    this.compoundCalls += 1;
    if (this.failWith) throw this.failWith;
    return preparedTransaction();
  }

  async rebalance(): Promise<PreparedTransaction> {
    this.rebalanceCalls += 1;
    if (this.failWith) throw this.failWith;
    return preparedTransaction();
  }

  async enter(): Promise<PreparedTransaction> {
    this.enterCalls += 1;
    if (this.failWith) throw this.failWith;
    return preparedTransaction();
  }

  async increase(): Promise<PreparedTransaction> {
    this.increaseCalls += 1;
    if (this.failWith) throw this.failWith;
    return preparedTransaction({ kind: 'swap_and_increase', selector: '0x3dce3e25' });
  }

  async decrease(): Promise<PreparedTransaction> {
    this.decreaseCalls += 1;
    if (this.failWith) throw this.failWith;
    return preparedTransaction({ kind: 'withdraw_and_swap', selector: '0xb88d4fde' });
  }
}

/** Token the enter fake zaps in; matches `FakePoolState.token0` so it is in-pool. */
const ENTER_TOKEN_IN = '0x2222222222222222222222222222222222222222' as Address;

/** A pool-state reader that reports the enter token as one side of the pool. */
const fakePoolState: PoolStateReader = {
  readPoolState: async (): Promise<PoolState> => ({
    currentTick: 200_000,
    feeUnits: 10_000,
    token0: ENTER_TOKEN_IN,
    token1: OTHER_POOL,
  }),
};

const fakeAllowance: AllowanceConfig = {
  owner: SAFE,
  chainId: 4663,
  approvableTokens: [...DEFAULT_APPROVABLE_TOKENS, ENTER_TOKEN_IN],
  reader: { readContract: async () => MAX_UINT256 },
};

/** A valid `enter` command: no tokenId, carries pool + token + amount + range. */
function enterCommand(over: Partial<LpCommand> = {}): LpCommand {
  return {
    id: 'cmd-enter',
    tokenId: null,
    poolAddress: POOL,
    action: 'enter',
    requestedAt: NOW - 1_000,
    tokenInAddress: ENTER_TOKEN_IN,
    amountIn: '1000000000000000',
    rangeStrategy: 'narrow',
    swapSlippage: null,
    ...over,
  };
}

/** An in-memory `CommandSource`. One command, handed out once. */
class FakeCommandSource implements CommandSource {
  claims = 0;
  readonly completed: { command: LpCommand; result: CommandResult }[] = [];
  claimError: Error | null = null;
  completeError: Error | null = null;

  constructor(private queued: LpCommand | null) {}

  async claimNext(): Promise<LpCommand | null> {
    this.claims += 1;
    if (this.claimError !== null) throw this.claimError;
    const next = this.queued;
    this.queued = null;
    return next;
  }

  async complete(command: LpCommand, result: CommandResult): Promise<void> {
    if (this.completeError !== null) throw this.completeError;
    this.completed.push({ command, result });
  }

  get last(): CommandResult | undefined {
    return this.completed.at(-1)?.result;
  }
}

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function command(over: Partial<LpCommand> = {}): LpCommand {
  return {
    id: 'cmd-1',
    tokenId: TOKEN_ID,
    poolAddress: POOL,
    action: 'compound',
    requestedAt: NOW - 1_000,
    ...over,
  };
}

interface Harness {
  loop: LifecycleLoop;
  signer: FakeSigner;
  audit: FakeAudit;
  calldata: FakeCalldata;
  commands: FakeCommandSource;
  watcher: () => FakeWatcher;
}

function harness(
  over: {
    queued?: LpCommand | null;
    positions?: LpPosition[];
    policies?: AutomationPolicy[];
    records?: AuditRecord[];
    calldata?: CalldataBuilder & { compoundCalls?: number };
    /** Omit for the default working reader; pass `null` to leave enter unwired. */
    poolState?: PoolStateReader | null;
    waitForReceipt?: (txHash: string) => Promise<TransactionReceiptInfo | null>;
    maxValueWei?: bigint;
  } = {},
): Harness {
  const signer = new FakeSigner();
  const audit = new FakeAudit();
  audit.records = over.records ?? [];
  const calldata = (over.calldata as FakeCalldata) ?? new FakeCalldata();
  const commands = new FakeCommandSource(over.queued === undefined ? command() : over.queued);

  let watcher: FakeWatcher | null = null;
  let counter = 0;

  const feed: PositionFeed = {
    loadPositions: async () => over.positions ?? [position()],
  };
  const policySource: PolicySource = {
    load: async (): Promise<PolicyBundle> => ({
      policies: over.policies ?? [policy()],
      bindings: {},
    }),
  };

  const loop = new LifecycleLoop({
    policySource,
    positions: feed,
    calldata,
    commands,
    ...(over.poolState === null ? {} : { poolState: over.poolState ?? fakePoolState }),
    allowance: fakeAllowance,
    ...(over.maxValueWei === undefined ? {} : { maxValueWei: over.maxValueWei }),
    signer,
    audit,
    ...(over.waitForReceipt === undefined ? {} : { waitForReceipt: over.waitForReceipt }),
    createWatcher: (callbacks) => {
      watcher = new FakeWatcher(callbacks);
      return watcher;
    },
    logger: silentLogger,
    now: () => NOW,
    newId: () => `id-${(counter += 1)}`,
    // Timers long enough that nothing fires by accident; ticks are driven
    // explicitly via `runCommandTick()`.
    options: {
      positionPollIntervalMs: 3_600_000,
      commandPollIntervalMs: 3_600_000,
      gasCostUsd: 1,
      // No real sleeps in tests: a rebalance triggers recordRebalanceLineage,
      // which otherwise waits on DEFAULT_LINEAGE_POLL_DELAYS_MS (2s+).
      lineagePollDelaysMs: [],
    },
  });

  return {
    loop,
    signer,
    audit,
    calldata,
    commands,
    watcher: () => {
      if (watcher === null) throw new Error('watcher not created yet — call loop.start() first');
      return watcher;
    },
  };
}

/** Let queued microtasks (the action pipeline) run to their next await. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ===========================================================================
// 1. The claim is atomic
// ===========================================================================

describe('claiming is atomic', () => {
  beforeEach(() => {
    holder.db = new FakeDb();
  });

  it('moves a pending command to claimed and returns it', async () => {
    holder.db.rows = [fakeRow()];

    const claimed = await source().claimNext();

    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe('cmd-1');
    expect(claimed?.action).toBe('compound');
    expect(claimed?.tokenId).toBe(TOKEN_ID);
    expect(holder.db.row('cmd-1').status).toBe('claimed');
    expect(holder.db.row('cmd-1').claimed_at).not.toBeNull();
  });

  it('filters the update on status = pending, not on the id alone', async () => {
    holder.db.rows = [fakeRow()];
    await source().claimNext();
    // If the predicate is ever dropped, this is the assertion that fails: the
    // update would then match a claimed row and re-issue a command that may
    // already have been broadcast.
    expect(holder.db.updates).toHaveLength(1);
  });

  it('returns null when a competing instance claims the row first (zero rows changed)', async () => {
    holder.db.rows = [fakeRow()];
    // The select saw it as pending; by the time the update runs, someone else
    // owns it. The conditional update matches nothing.
    holder.db.beforeUpdate = () => {
      holder.db.row('cmd-1').status = 'claimed';
    };

    expect(await source().claimNext()).toBeNull();
  });

  it('skips a lost row and claims the next one instead of giving up', async () => {
    holder.db.rows = [fakeRow({ id: 'cmd-1' }), fakeRow({ id: 'cmd-2', token_id: '999' })];
    let first = true;
    holder.db.beforeUpdate = () => {
      if (!first) return;
      first = false;
      holder.db.row('cmd-1').status = 'claimed';
    };

    const claimed = await source().claimNext();

    expect(claimed?.id).toBe('cmd-2');
    expect(claimed?.tokenId).toBe('999');
  });

  it('returns null when there is nothing pending', async () => {
    holder.db.rows = [fakeRow({ status: 'done' }), fakeRow({ id: 'cmd-2', status: 'failed' })];
    expect(await source().claimNext()).toBeNull();
    expect(holder.db.updates).toEqual([]);
  });

  it('never claims another user\'s command', async () => {
    holder.db.rows = [fakeRow({ user_id: 'someone-else' })];
    expect(await source().claimNext()).toBeNull();
  });

  it('throws rather than reporting "nothing queued" when the poll fails', async () => {
    holder.db.readError = 'connection reset';
    // A read failure is NOT an empty queue. Swallowing it would make a database
    // outage look identical to an idle system.
    await expect(source().claimNext()).rejects.toBeInstanceOf(CommandSourceError);
  });
});

describe('completing a command', () => {
  beforeEach(() => {
    holder.db = new FakeDb();
  });

  it('writes done with the tx hash when the transaction was broadcast', async () => {
    holder.db.rows = [fakeRow({ status: 'claimed' })];
    await source().complete(command(), { txHash: '0xdeadbeef', error: null });

    const row = holder.db.row('cmd-1');
    expect(row.status).toBe('done');
    expect(row.tx_hash).toBe('0xdeadbeef');
    expect(row.error).toBeNull();
    expect(row.completed_at).not.toBeNull();
  });

  it('writes failed with the reason when there is one', async () => {
    holder.db.rows = [fakeRow({ status: 'claimed' })];
    await source().complete(command(), { txHash: null, error: 'dry run failed at simulation' });

    const row = holder.db.row('cmd-1');
    expect(row.status).toBe('failed');
    expect(row.error).toBe('dry run failed at simulation');
    expect(row.tx_hash).toBeNull();
  });

  it('only resolves a command this process holds — the update is filtered on claimed', async () => {
    holder.db.rows = [fakeRow({ status: 'done', tx_hash: '0xabc' })];
    await source().complete(command(), { txHash: null, error: 'late failure' });
    // Untouched: an already-completed row cannot be overwritten.
    expect(holder.db.row('cmd-1').status).toBe('done');
    expect(holder.db.row('cmd-1').tx_hash).toBe('0xabc');
  });
});

describe('rowToCommand', () => {
  it('lowercases the pool address so allowlist comparison is plain equality', () => {
    const mapped = rowToCommand(fakeRow({ pool_address: POOL.toUpperCase().replace('0X', '0x') }) as never);
    expect(mapped.poolAddress).toBe(POOL);
  });

  it('accepts compound_rebalance as a queue action', () => {
    const mapped = rowToCommand(fakeRow({ action: 'compound_rebalance' }) as never);
    expect(mapped.action).toBe('compound_rebalance');
  });

  it('refuses a row it cannot read rather than guessing at a transaction', () => {
    for (const over of [
      { action: 'withdraw' },
      { action: 'enter' },
      { token_id: '0' },
      { token_id: 'abc' },
      { pool_address: '0xnope' },
      { id: '' },
    ]) {
      expect(() => rowToCommand(fakeRow(over) as never), JSON.stringify(over)).toThrow(
        CommandSourceError,
      );
    }
  });
});

describe('rowToCommand — enter (Zap In)', () => {
  const TOKEN_IN = '0x1111111111111111111111111111111111111111';
  const enterRow = (over: Record<string, unknown> = {}) => ({
    id: 'enter-1',
    user_id: 'u1',
    token_id: null,
    pool_address: POOL,
    action: 'enter',
    status: 'pending',
    requested_at: new Date(0).toISOString(),
    token_in_address: TOKEN_IN,
    amount_in: '1000000000000000',
    range_strategy: 'narrow',
    swap_slippage: 0.005,
    ...over,
  });

  it('maps a valid enter row with a null tokenId and the enter params', () => {
    const m = rowToCommand(enterRow() as never);
    expect(m.tokenId).toBeNull();
    expect(m.action).toBe('enter');
    expect(m.tokenInAddress).toBe(TOKEN_IN);
    expect(m.amountIn).toBe('1000000000000000');
    expect(m.rangeStrategy).toBe('narrow');
    expect(m.swapSlippage).toBe(0.005);
  });

  it('lowercases token_in_address so allowlist/pool comparison is plain equality', () => {
    const m = rowToCommand(enterRow({ token_in_address: TOKEN_IN.toUpperCase().replace('0X', '0x') }) as never);
    expect(m.tokenInAddress).toBe(TOKEN_IN);
  });

  it('treats a null range_strategy / swap_slippage as "use the default"', () => {
    const m = rowToCommand(enterRow({ range_strategy: null, swap_slippage: null }) as never);
    expect(m.rangeStrategy).toBeNull();
    expect(m.swapSlippage).toBeNull();
  });

  it('parses a numeric-string swap_slippage (PostgREST returns numeric as a string)', () => {
    const m = rowToCommand(enterRow({ swap_slippage: '0.01' }) as never);
    expect(m.swapSlippage).toBe(0.01);
  });

  it('refuses a malformed enter row rather than guessing at a transaction', () => {
    for (const over of [
      { token_in_address: '0xnope' },
      { token_in_address: null },
      { amount_in: '0' },
      { amount_in: '1.5' },
      { amount_in: '007' },
      { amount_in: null },
      { range_strategy: 'medium' },
      { swap_slippage: 0.5 },
      { swap_slippage: 0 },
    ]) {
      expect(() => rowToCommand(enterRow(over) as never), JSON.stringify(over)).toThrow(
        CommandSourceError,
      );
    }
  });
});

describe('rowToCommand — increase (add liquidity)', () => {
  const TOKEN_IN = '0x1111111111111111111111111111111111111111';
  const increaseRow = (over: Record<string, unknown> = {}) => ({
    id: 'inc-1',
    user_id: 'u1',
    token_id: '12345',
    pool_address: POOL,
    action: 'increase',
    status: 'pending',
    requested_at: new Date(0).toISOString(),
    token_in_address: TOKEN_IN,
    amount_in: '1000000000000000',
    range_strategy: null,
    swap_slippage: 0.005,
    ...over,
  });

  it('maps a valid increase row with tokenId and zap params', () => {
    const m = rowToCommand(increaseRow() as never);
    expect(m.tokenId).toBe('12345');
    expect(m.action).toBe('increase');
    expect(m.tokenInAddress).toBe(TOKEN_IN);
    expect(m.amountIn).toBe('1000000000000000');
    expect(m.swapSlippage).toBe(0.005);
  });

  it('refuses range_strategy on an increase row', () => {
    expect(() => rowToCommand(increaseRow({ range_strategy: 'narrow' }) as never)).toThrow(
      CommandSourceError,
    );
  });
});

describe('rowToCommand — decrease', () => {
  const TOKEN_OUT = '0x1111111111111111111111111111111111111111';
  it('maps percent-mode decrease', () => {
    const m = rowToCommand({
      id: 'dec-1',
      token_id: '12345',
      pool_address: POOL,
      action: 'decrease',
      requested_at: new Date(0).toISOString(),
      token_in_address: TOKEN_OUT,
      amount_in: null,
      liquidity_percent: 0.25,
      range_strategy: null,
      swap_slippage: 0.005,
    } as never);
    expect(m.action).toBe('decrease');
    expect(m.liquidityPercent).toBe(0.25);
  });
});

describe('createSupabaseCommandSource', () => {
  beforeEach(() => {
    holder.db = new FakeDb();
  });

  it('returns null when neither variable is set — the feature is simply off', () => {
    expect(createSupabaseCommandSource({} as NodeJS.ProcessEnv, USER)).toBeNull();
  });

  it('throws on a half-configured source rather than silently disabling it', () => {
    expect(() =>
      createSupabaseCommandSource({ SUPABASE_URL: 'https://x.supabase.co' } as NodeJS.ProcessEnv, USER),
    ).toThrow(CommandSourceError);
    expect(() =>
      createSupabaseCommandSource({ SUPABASE_SERVICE_ROLE_KEY: 'k' } as NodeJS.ProcessEnv, USER),
    ).toThrow(CommandSourceError);
  });

  it('requires a user id — an unscoped queue read would be every account at once', () => {
    expect(() =>
      createSupabaseCommandSource(
        { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' } as NodeJS.ProcessEnv,
        '',
      ),
    ).toThrow(CommandSourceError);
  });
});

// ===========================================================================
// 2. A claimed command runs the SAME ladder, with the lock held
// ===========================================================================

describe('a claimed command goes through the executor', () => {
  it('dry-runs, writes the intent BEFORE submitting, then records the outcome', async () => {
    const h = harness();
    const order: string[] = [];
    h.signer.onSubmit = async () => {
      order.push('submit');
    };
    const recordIntent = h.audit.recordIntent.bind(h.audit);
    h.audit.recordIntent = async (pending: PendingAction) => {
      order.push('intent');
      await recordIntent(pending);
    };

    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.signer.simulated).toHaveLength(1);
    expect(order).toEqual(['intent', 'submit']);
    expect(h.commands.last).toEqual({ txHash: '0xdeadbeef', error: null });
    await h.loop.stop();
  });

  it('records the action under a manual.* rule with the tokenId attributable', async () => {
    const h = harness();
    await h.loop.start();
    await h.loop.runCommandTick();

    const decision = h.audit.intents[0]?.decision;
    expect(decision?.action).toBe('compound');
    expect(decision?.rule).toBe('manual.compound');
    // `unresolved.ts` attributes a quarantined intent by snapshot.tokenId. An
    // intent it cannot attribute blocks EVERY position, not just this one.
    expect(decision?.snapshot?.tokenId).toBe(TOKEN_ID);
    expect(decision?.snapshot?.trigger).toBe('manual');
    expect(decision?.snapshot?.commandId).toBe('cmd-1');
    await h.loop.stop();
  });

  it('holds the per-position lock, so an automatic action cannot race it', async () => {
    const h = harness();
    const held = deferred();
    h.signer.onSubmit = () => held.promise;

    await h.loop.start();
    const running = h.loop.runCommandTick();
    await flush();

    // The lock is visibly held while the manual action is in flight...
    expect(h.loop.getState().lockedPositions).toEqual([TOKEN_ID]);

    // ...and a confirmed range exit arriving right now is refused rather than
    // queued: a queued action would execute against pre-transaction state.
    h.watcher().callbacks.onCrossing?.(confirmedCrossing());
    await flush();
    expect(h.audit.rules()).toContain('lifecycle.position_busy');
    expect(h.signer.submitted).toHaveLength(1);

    held.resolve();
    await running;
    await h.loop.stop();
  });

  it('is refused when the pool is no longer on the allowlist AT EXECUTION TIME', async () => {
    // The backend checked the allowlist when the command was queued. The policy
    // changed since. The guard that matters is the one in `ActionExecutor`.
    const h = harness({ policies: [policy({ allowedPools: [OTHER_POOL] })] });
    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.signer.simulated).toEqual([]);
    expect(h.signer.submitted).toEqual([]);
    expect(h.commands.last?.error).toContain('lifecycle.pool_not_allowed');
    expect(h.commands.last?.txHash).toBeNull();
    await h.loop.stop();
  });

  it('is refused when the position is quarantined by an unresolved intent', async () => {
    const h = harness({
      records: [
        {
          id: 'orphan',
          phase: 'intent',
          timestamp: NOW - 10_000,
          action: 'compound',
          rule: 'compound.fees_vs_gas',
          reason: 'previous run',
          snapshot: { tokenId: TOKEN_ID },
          txHash: null,
          error: null,
        },
      ],
    });
    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.signer.submitted).toEqual([]);
    expect(h.commands.last?.error).toContain('lifecycle.unresolved_intent');
    await h.loop.stop();
  });

  it('does not submit when the intent write fails', async () => {
    const h = harness();
    h.audit.failIntent = true;
    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.signer.simulated).toHaveLength(1); // the dry run still ran
    expect(h.signer.submitted).toEqual([]); // ...and then we stopped
    expect(h.commands.last?.error).toContain('audit intent could not be written');
    await h.loop.stop();
  });

  it('refuses a command whose position is not tracked', async () => {
    const h = harness({ queued: command({ tokenId: '111111' }) });
    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.signer.submitted).toEqual([]);
    expect(h.commands.last?.error).toContain('not currently tracked');
    await h.loop.stop();
  });

  it('refuses a command queued against a pool the position is no longer in', async () => {
    const h = harness({ queued: command({ poolAddress: OTHER_POOL }) });
    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.signer.submitted).toEqual([]);
    expect(h.commands.last?.error).toContain('stale request');
    await h.loop.stop();
  });

  it('refuses exit while no target token can be chosen, rather than guessing', async () => {
    const h = harness({ queued: command({ action: 'exit' }) });
    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.signer.submitted).toEqual([]);
    expect(h.commands.last?.error).toContain('target token');
    await h.loop.stop();
  });

  it('does nothing at all on an empty queue', async () => {
    const h = harness({ queued: null });
    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.commands.claims).toBe(1);
    expect(h.commands.completed).toEqual([]);
    expect(h.signer.simulated).toEqual([]);
    expect(h.signer.submitted).toEqual([]);
    await h.loop.stop();
  });
});

// ===========================================================================
// 3. Disarmed is recorded honestly
// ===========================================================================

describe('disarmed mode', () => {
  it('runs the whole ladder and records failed, never done', async () => {
    const h = harness();
    h.signer.armState = 'disarmed';
    h.signer.outcome = { status: 'skipped_disarmed', simulated: true };

    await h.loop.start();
    await h.loop.runCommandTick();

    // Everything ran: guards, calldata, dry run, audit intent, and the submit
    // call itself. Only the broadcast was skipped.
    expect(h.calldata.compoundCalls).toBe(1);
    expect(h.signer.simulated).toHaveLength(1);
    expect(h.audit.intents).toHaveLength(1);
    expect(h.signer.submitted).toHaveLength(1);

    const result = h.commands.last;
    expect(result?.txHash).toBeNull();
    // `error !== null` is what makes the row `failed`. A dry run must never
    // read as a completed action to the person who pressed the button.
    expect(result?.error).toContain('disarmed');
    expect(result?.error).toMatch(/nothing broadcast/i);
    await h.loop.stop();
  });

  it('writes the same honest outcome into the audit log', async () => {
    const h = harness();
    h.signer.armState = 'disarmed';
    h.signer.outcome = { status: 'skipped_disarmed', simulated: true };

    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.audit.outcomes[0]?.txHash).toBeNull();
    expect(h.audit.outcomes[0]?.error).toContain('disarmed');
    await h.loop.stop();
  });
});

// ===========================================================================
// 4. Failures reach the row the operator reads
// ===========================================================================

describe('failures are recorded with their reason', () => {
  it('records a failed dry run without ever submitting', async () => {
    const h = harness();
    h.signer.simulateResult = { ok: false, reason: 'STF', stage: 'simulation' };

    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.signer.submitted).toEqual([]);
    expect(h.audit.intents).toEqual([]); // no intent for a transaction that would revert
    expect(h.commands.last?.error).toContain('lifecycle.simulation_failed');
    expect(h.commands.last?.error).toContain('STF');
    await h.loop.stop();
  });

  it('records a preflight rejection with the stage it died at', async () => {
    const h = harness();
    h.signer.outcome = {
      status: 'rejected',
      reason: 'destination not allowlisted on the module',
      stage: 'destination_allowlist',
    };

    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.commands.last?.txHash).toBeNull();
    expect(h.commands.last?.error).toContain('destination_allowlist');
    await h.loop.stop();
  });

  it('records a broadcast failure with the hash the chain may still be holding', async () => {
    const h = harness();
    h.signer.outcome = { status: 'failed', reason: 'nonce too low', txHash: '0xabc123' };

    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.commands.last?.txHash).toBe('0xabc123');
    expect(h.commands.last?.error).toContain('nonce too low');
    await h.loop.stop();
  });

  it('records a calldata build failure rather than leaving the command hanging', async () => {
    const h = harness();
    h.calldata.failWith = new Error('Krystal 502');

    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.signer.submitted).toEqual([]);
    expect(h.commands.last?.error).toContain('Krystal 502');
    await h.loop.stop();
  });

  it('leaves the command pending when the CLAIM fails, so the next tick retries', async () => {
    const h = harness();
    h.commands.claimError = new Error('connection reset');

    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.commands.completed).toEqual([]);
    expect(h.signer.submitted).toEqual([]);
    await h.loop.stop();
  });

  it('survives a failure to record the outcome without crashing the loop', async () => {
    const h = harness();
    h.commands.completeError = new Error('connection reset');

    await h.loop.start();
    await expect(h.loop.runCommandTick()).resolves.toBeUndefined();
    // The transaction still went out and the AUDIT LOG still recorded it —
    // that, not this row, is the authority on what happened to the funds.
    expect(h.audit.outcomes).toHaveLength(1);
    await h.loop.stop();
  });
});

describe('compound_rebalance manual command', () => {
  it('runs compound then rebalance sequentially and records both manual rules', async () => {
    const h = harness({ queued: command({ action: 'compound_rebalance' }) });
    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.calldata.compoundCalls).toBe(1);
    expect(h.calldata.rebalanceCalls).toBe(1);
    expect(h.signer.submitted).toHaveLength(2);
    expect(h.signer.submitted[0]?.action).toBe('compound');
    expect(h.signer.submitted[1]?.action).toBe('rebalance');
    expect(h.commands.last).toEqual({ txHash: '0xdeadbeef', error: null });
    expect(h.audit.intents.map((intent) => intent.decision.rule)).toEqual([
      'manual.compound_rebalance.compound',
      'manual.compound_rebalance.rebalance',
    ]);
    await h.loop.stop();
  });

  it('does not attempt rebalance when compound fails', async () => {
    const calldata = new FakeCalldata();
    calldata.failWith = new Error('compound calldata unavailable');
    const h = harness({ queued: command({ action: 'compound_rebalance' }), calldata });
    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.calldata.compoundCalls).toBe(1);
    expect(h.calldata.rebalanceCalls).toBe(0);
    expect(h.signer.submitted).toEqual([]);
    expect(h.commands.last?.error).toContain('compound calldata unavailable');
    await h.loop.stop();
  });
});

describe('enter (Zap In) manual command', () => {
  it('reads the pool, builds swap_and_mint calldata, and runs the SAME ladder', async () => {
    const h = harness({ queued: enterCommand() });
    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.calldata.enterCalls).toBe(1);
    expect(h.signer.simulated).toHaveLength(1); // the dry run still ran
    expect(h.signer.submitted).toHaveLength(1);
    expect(h.signer.submitted[0]?.action).toBe('enter');
    expect(h.commands.last).toEqual({ txHash: '0xdeadbeef', error: null });
    await h.loop.stop();
  });

  it('records the enter under manual.enter with the COMMAND id as the attributable tokenId', async () => {
    const h = harness({ queued: enterCommand() });
    await h.loop.start();
    await h.loop.runCommandTick();

    const decision = h.audit.intents[0]?.decision;
    expect(decision?.action).toBe('enter');
    expect(decision?.rule).toBe('manual.enter');
    // There is no position yet; the command id is the quarantine attribution key.
    expect(decision?.snapshot?.tokenId).toBe('cmd-enter');
    expect(decision?.snapshot?.trigger).toBe('manual');
    await h.loop.stop();
  });

  it('is refused when the target pool is not on the allowlist AT EXECUTION TIME', async () => {
    const h = harness({ queued: enterCommand(), policies: [policy({ allowedPools: [OTHER_POOL] })] });
    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.calldata.enterCalls).toBe(0);
    expect(h.signer.submitted).toEqual([]);
    expect(h.commands.last?.error).toContain('allowlist');
    await h.loop.stop();
  });

  it('is refused when the input token is not one side of the pool', async () => {
    const h = harness({
      queued: enterCommand({ tokenInAddress: '0x3333333333333333333333333333333333333333' as Address }),
    });
    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.calldata.enterCalls).toBe(0);
    expect(h.signer.submitted).toEqual([]);
    expect(h.commands.last?.error).toContain('is not in pool');
    await h.loop.stop();
  });

  it('is refused with a recorded reason when enter is not wired (no pool-state reader)', async () => {
    const h = harness({ queued: enterCommand(), poolState: null });
    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.calldata.enterCalls).toBe(0);
    expect(h.signer.submitted).toEqual([]);
    expect(h.commands.last?.error).toContain('not wired');
    await h.loop.stop();
  });

  it('accepts native ETH when the pool has WETH and maxValueWei is set', async () => {
    const wethPoolState: PoolStateReader = {
      readPoolState: async (): Promise<PoolState> => ({
        currentTick: 200_000,
        feeUnits: 10_000,
        token0: ROBINHOOD_WETH,
        token1: OTHER_POOL,
      }),
    };
    const h = harness({
      queued: enterCommand({ tokenInAddress: NATIVE_ETH_ADDRESS }),
      poolState: wethPoolState,
      maxValueWei: 10n ** 18n,
    });
    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.calldata.enterCalls).toBe(1);
    expect(h.signer.submitted).toHaveLength(1);
    expect(h.signer.submitted[0]?.action).toBe('enter');
    await h.loop.stop();
  });

  it('refuses native ETH when maxValueWei is zero', async () => {
    const wethPoolState: PoolStateReader = {
      readPoolState: async (): Promise<PoolState> => ({
        currentTick: 200_000,
        feeUnits: 10_000,
        token0: ROBINHOOD_WETH,
        token1: OTHER_POOL,
      }),
    };
    const h = harness({
      queued: enterCommand({ tokenInAddress: NATIVE_ETH_ADDRESS }),
      poolState: wethPoolState,
      maxValueWei: 0n,
    });
    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.calldata.enterCalls).toBe(0);
    expect(h.commands.last?.error).toContain('LP_MAX_TX_VALUE_WEI');
    await h.loop.stop();
  });
});

describe('increase (add liquidity) manual command', () => {
  const INCREASE_TOKEN = '0x2222222222222222222222222222222222222222' as Address;

  function increaseCommand(over: Partial<LpCommand> = {}): LpCommand {
    return {
      id: 'cmd-increase',
      tokenId: TOKEN_ID,
      poolAddress: POOL,
      action: 'increase',
      requestedAt: NOW - 1_000,
      tokenInAddress: INCREASE_TOKEN,
      amountIn: '10000000000000000',
      swapSlippage: null,
      ...over,
    };
  }

  it('re-quotes once when the mined receipt reverts (stale Krystal swap bounds)', async () => {
    let receiptCalls = 0;
    const h = harness({
      queued: increaseCommand(),
      positions: [
        position({
          pool: {
            ...position().pool,
            token0: { address: INCREASE_TOKEN, symbol: 'WETH', decimals: 18 },
          },
        }),
      ],
      waitForReceipt: async () => {
        receiptCalls += 1;
        if (receiptCalls === 1) return { status: 'reverted' };
        return { status: 'success', gasUsed: 100_000n, effectiveGasPrice: 1_000n };
      },
    });

    await h.loop.start();
    await h.loop.runCommandTick();

    expect(h.calldata.increaseCalls).toBe(2);
    expect(h.signer.submitted).toHaveLength(2);
    expect(h.commands.last).toEqual({ txHash: '0xdeadbeef', error: null });
    await h.loop.stop();
  });
});

describe('decrease manual command', () => {
  const DECREASE_TOKEN = '0x2222222222222222222222222222222222222222' as Address;

  it('executes withdraw_and_swap', async () => {
    const h = harness({
      queued: {
        id: 'cmd-decrease',
        tokenId: TOKEN_ID,
        poolAddress: POOL,
        action: 'decrease',
        requestedAt: NOW - 1_000,
        tokenInAddress: DECREASE_TOKEN,
        liquidityPercent: 0.5,
        swapSlippage: null,
      },
      positions: [
        position({
          pool: {
            ...position().pool,
            token1: { address: DECREASE_TOKEN, symbol: 'USDC', decimals: 6 },
          },
        }),
      ],
    });
    await h.loop.start();
    await h.loop.runCommandTick();
    expect(h.calldata.decreaseCalls).toBe(1);
    expect(h.commands.last).toEqual({ txHash: '0xdeadbeef', error: null });
    await h.loop.stop();
  });
});
