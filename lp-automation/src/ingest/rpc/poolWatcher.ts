// PoolWatcher — the low-latency chain-watch layer (LP_AUTOMATION_PLAN.md §3,
// §10 step 4).
//
// WHY THIS EXISTS
// Krystal's API is REST/poll-based (plan §1, final paragraph). It is the right
// tool for fee accrual, TVL and pool discovery, and the wrong tool for "price
// just left the range". This module watches the specific pools we hold
// positions in, directly over RPC, and reports range crossings.
//
// WHAT IT DOES NOT DO
// It does not decide anything. It reports "the tick left [tickLower, tickUpper)
// by X%" and stops there. Whether that warrants a rebalance is `src/rules/`'s
// job, governed by the policy's rebalanceTrigger and switchingBuffer. Nothing
// in this file imports from, or reimplements, that logic.
//
// ---------------------------------------------------------------------------
// CONFIRMATION / REORG POLICY  (the decision the brief asks to be documented)
// ---------------------------------------------------------------------------
// Every crossing is emitted TWICE, in phases:
//
//   phase: 'observed'   — the head block says the tick left the range. Emitted
//                         immediately, with zero added latency. Safe for
//                         speculative work (fetch calldata, dry-run) but NOT
//                         for broadcasting, because a reorg can take it back.
//   phase: 'confirmed'  — the crossing still holds `confirmations` blocks
//                         deeper. This is the actionable one.
//   phase: 'reverted'   — it did not hold (reorged out, or price came back).
//
// Confirmation is not "we waited N blocks and re-trusted the original log". At
// depth, the watcher RE-READS `slot0()` at block `observedBlock + confirmations`
// and re-evaluates the side from that state. A log that was reorged out simply
// is not reflected in the canonical state at that block, so the crossing turns
// into a `reverted` instead of a `confirmed`. That makes the check reorg-proof
// rather than reorg-hopeful. If the historical read fails (node pruning, RPC
// error) we fall back to the log-derived tick and say so explicitly via
// `verifiedBy: 'log'` — a weaker guarantee, reported rather than hidden.
//
// Why 3 confirmations by default: Robinhood Chain advertises ~100ms blocks, so
// three blocks is ~300ms — comfortably inside the source spec's sub-second
// reaction goal (G1) while surviving the shallow reorgs a fast-block chain
// produces routinely. Setting `LP_RPC_CONFIRMATIONS=0` collapses both phases
// into one and disables reorg protection entirely; that is a deliberate choice
// an operator can make, not a default.
//
// ---------------------------------------------------------------------------
// DEGRADED MODE AND STALENESS
// ---------------------------------------------------------------------------
// A watcher that has silently stopped watching is worse than no watcher: the
// rest of the system keeps believing the position is covered. Two mechanisms:
//
//  • Mode is always explicit. `getStatus().mode` is 'websocket' or 'polling',
//    and `lowLatency` is true ONLY for a live WebSocket. Polling mode always
//    reports health 'degraded' with a reason, even when an operator configured
//    it deliberately — because reaction time is then bounded by the poll
//    interval, and claiming otherwise would be a lie the rest of the system
//    would act on.
//  • Staleness. A heartbeat watches block arrivals (not pool events — a pool
//    can be legitimately quiet, the chain cannot). No block within
//    `stalenessMs` fires `onStale`, flips health to 'stale', and forces a full
//    reconnect.
//
// viem's WebSocket transport auto-reconnects the *socket* but does not re-issue
// `eth_subscribe` afterwards — leaving a healthy-looking socket carrying zero
// subscriptions. That is precisely the silent-death case above, so we disable
// viem's reconnect (`reconnect: false`) and own the whole cycle: teardown,
// exponential backoff, fresh client, fresh subscriptions, re-seed from slot0.

import {
  createPublicClient,
  http,
  webSocket,
  type Chain,
  type Log,
  type PublicClient,
  type Transport,
} from 'viem';
import type { Address } from '../../types.js';
import { LIQUIDITY_EVENTS, SWAP_EVENT, UNISWAP_V3_POOL_ABI } from './abi.js';
import { defineRobinhoodChain } from './chain.js';
import type { RpcConfig } from './config.js';
import { DEFAULT_BACKOFF, backoffDelayMs, evaluateStaleness, type BackoffOptions } from './health.js';
import { confirmationDepth, isConfirmed, pickLatestLog } from './observations.js';
import { evaluateRange, type RangeSide } from './tickMath.js';
import type {
  CrossingEvent,
  LiquidityChange,
  PoolWatcherCallbacks,
  TickObservation,
  WatchMode,
  WatchedRange,
  WatcherError,
  WatcherHealth,
  WatcherLogger,
  WatcherStatus,
} from './types.js';

type RpcClient = PublicClient<Transport, Chain>;
type SwapLog = Log<bigint, number, false, typeof SWAP_EVENT, true>;

interface PendingCrossing {
  watched: WatchedRange;
  observation: TickObservation;
  side: RangeSide;
  previousSide: RangeSide | null;
  exitPercent: number;
  ticksOutside: number;
  /** Block the crossing was first seen in; null until a head is known. */
  blockNumber: bigint | null;
}

export interface PoolWatcherOptions {
  config: RpcConfig;
  /** Ranges to watch from the start; more can be added with `watch()`. */
  ranges?: WatchedRange[];
  callbacks?: PoolWatcherCallbacks;
  backoff?: Partial<BackoffOptions>;
  /**
   * After falling back to polling, how often to retry the WebSocket.
   * Default 60s — we want back on the fast path, but not at the cost of a
   * reconnect storm against a provider that is genuinely down.
   */
  websocketRetryMs?: number;
  logger?: WatcherLogger;
  /** Injectable clock/RNG, for tests. */
  now?: () => number;
  random?: () => number;
}

export class PoolWatcher {
  private readonly config: RpcConfig;
  private readonly callbacks: PoolWatcherCallbacks;
  private readonly backoff: Partial<BackoffOptions>;
  private readonly websocketRetryMs: number;
  private readonly logger: WatcherLogger;
  private readonly now: () => number;
  private readonly random: () => number;

  private readonly ranges = new Map<string, WatchedRange>();
  private readonly lastTickByPool = new Map<Address, number>();
  /** Last CONFIRMED side per tokenId. Pending crossings never write here. */
  private readonly sideByRange = new Map<string, RangeSide>();
  private readonly pending = new Map<string, PendingCrossing>();

  private client: RpcClient | null = null;
  private running = false;
  private mode: WatchMode = 'polling';
  private health: WatcherHealth = 'stopped';
  private reason: string | null = null;

  private lastBlockAt: number | null = null;
  private lastBlockNumber: bigint | null = null;
  private attempt = 0;

  private staleSince: number | null = null;
  private lastStaleAlertAt = 0;
  private staleRepeat = 0;

  private unwatchSwaps: (() => void) | null = null;
  private unwatchLiquidity: (() => void) | null = null;
  private unwatchBlocks: (() => void) | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private websocketRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private resolving = false;
  /** Set while a bulk watch-set update is in flight, to resubscribe only once. */
  private batching = false;

  constructor(options: PoolWatcherOptions) {
    this.config = options.config;
    this.callbacks = options.callbacks ?? {};
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.websocketRetryMs = options.websocketRetryMs ?? 60_000;
    this.logger = options.logger ?? {};
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;

    for (const range of options.ranges ?? []) this.registerRange(range);
  }

  // --- lifecycle -----------------------------------------------------------

  /** Connects and begins watching. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.mode = this.chooseInitialMode();
    this.attempt = 0;
    this.setHealth('starting', null);
    void this.connect();
  }

  /** Stops watching and releases every timer and subscription. Idempotent. */
  stop(): void {
    if (!this.running && this.health === 'stopped') return;
    this.running = false;
    this.clearTimer('reconnectTimer');
    this.clearTimer('websocketRetryTimer');
    this.stopHeartbeat();
    this.teardownConnection();
    this.pending.clear();
    this.setHealth('stopped', null);
  }

  // --- watched ranges ------------------------------------------------------

  /**
   * Registers a range. If the pool's tick is already known the range is
   * evaluated immediately, so a position that is *already* out of range when it
   * is added is reported rather than waiting for the next swap.
   */
  watch(range: WatchedRange): void {
    const normalized = this.registerRange(range);
    const knownTick = this.lastTickByPool.get(normalized.pool);
    if (knownTick !== undefined) {
      this.reconcileRange(normalized, {
        pool: normalized.pool,
        tick: knownTick,
        source: 'slot0',
        blockNumber: this.lastBlockNumber,
        observedAt: this.now(),
        mode: this.mode,
      });
    }
    if (this.batching) return;
    if (this.running) this.refreshLogSubscriptions();
    this.emitStatus();
  }

  /** Stops watching a range. Any pending crossing for it is dropped. */
  unwatch(tokenId: string): void {
    if (!this.ranges.delete(tokenId)) return;
    this.pending.delete(tokenId);
    this.sideByRange.delete(tokenId);
    if (this.running) this.refreshLogSubscriptions();
    this.emitStatus();
  }

  /** Replaces the whole watch set (e.g. after re-syncing positions Krystal-side). */
  setWatched(ranges: readonly WatchedRange[]): void {
    const keep = new Set(ranges.map((r) => r.tokenId));
    for (const tokenId of [...this.ranges.keys()]) {
      if (!keep.has(tokenId)) {
        this.ranges.delete(tokenId);
        this.pending.delete(tokenId);
        this.sideByRange.delete(tokenId);
      }
    }
    // One teardown/resubscribe cycle for the whole set, not one per range —
    // churning subscriptions against the provider is exactly the kind of thing
    // that gets a connection dropped.
    this.batching = true;
    try {
      for (const range of ranges) this.watch(range);
    } finally {
      this.batching = false;
    }
    if (this.running) this.refreshLogSubscriptions();
    this.emitStatus();
  }

  // --- introspection -------------------------------------------------------

  getStatus(): WatcherStatus {
    return {
      mode: this.mode,
      health: this.health,
      lowLatency: this.isLowLatency(),
      reason: this.reason,
      lastBlockAt: this.lastBlockAt,
      lastBlockNumber: this.lastBlockNumber,
      reconnectAttempts: this.attempt,
      watchedPools: this.poolAddresses(),
      watchedRanges: this.ranges.size,
    };
  }

  getMode(): WatchMode {
    return this.mode;
  }

  /**
   * True only when observations are arriving over a live WebSocket. Callers
   * that promise sub-second reaction downstream must gate on this, not on
   * "the watcher is running".
   */
  isLowLatency(): boolean {
    return this.mode === 'websocket' && this.health === 'live';
  }

  // --- connection ----------------------------------------------------------

  private chooseInitialMode(): WatchMode {
    if (this.config.preferredMode === 'polling') return 'polling';
    if (!this.config.wsUrl) return 'polling';
    return 'websocket';
  }

  private createClient(mode: WatchMode): RpcClient {
    const chain = defineRobinhoodChain({ httpUrl: this.config.httpUrl, wsUrl: this.config.wsUrl });

    if (mode === 'websocket') {
      const wsUrl = this.config.wsUrl;
      if (!wsUrl) throw new Error('websocket mode requires LP_RPC_WS_URL');
      return createPublicClient({
        chain,
        // reconnect:false is load-bearing — see the module header. viem would
        // otherwise silently restore the socket without our subscriptions.
        transport: webSocket(wsUrl, { keepAlive: { interval: 5_000 }, reconnect: false }),
        batch: { multicall: true },
      }) as RpcClient;
    }

    return createPublicClient({
      chain,
      transport: http(this.config.httpUrl),
      batch: { multicall: true },
      pollingInterval: this.config.pollIntervalMs,
    }) as RpcClient;
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    this.clearTimer('reconnectTimer');
    this.teardownConnection();

    // Seed the heartbeat at connect time so a fresh connection gets a full
    // staleness threshold of grace instead of being born stale.
    this.lastBlockAt = this.now();
    this.staleSince = null;
    this.staleRepeat = 0;

    try {
      this.client = this.createClient(this.mode);
      this.subscribeBlocks();
      if (this.mode === 'websocket') this.refreshLogSubscriptions();
      else this.startPollLoop();
      this.startHeartbeat();
      await this.seed();
    } catch (error) {
      this.emitError('connect', error);
      this.scheduleReconnect(error instanceof Error ? error.message : String(error));
    }
  }

  private subscribeBlocks(): void {
    const client = this.client;
    if (!client) return;
    this.unwatchBlocks = client.watchBlockNumber({
      emitOnBegin: true,
      pollingInterval: this.config.pollIntervalMs,
      onBlockNumber: (blockNumber) => this.handleBlockNumber(blockNumber),
      onError: (error) => {
        this.emitError('subscription', error);
        this.scheduleReconnect(`block subscription error: ${error.message}`);
      },
    });
  }

  /**
   * (Re)creates the log subscriptions. Called on connect and whenever the set
   * of watched pools changes, because `watchEvent`'s address filter is fixed at
   * subscription time.
   */
  private refreshLogSubscriptions(): void {
    if (this.mode !== 'websocket') return;
    const client = this.client;
    if (!client) return;

    this.unwatchSwaps?.();
    this.unwatchSwaps = null;
    this.unwatchLiquidity?.();
    this.unwatchLiquidity = null;

    const pools = this.poolAddresses();
    if (pools.length === 0) return;

    this.unwatchSwaps = client.watchEvent({
      address: pools,
      event: SWAP_EVENT,
      strict: true,
      onLogs: (logs) => this.handleSwapLogs(logs),
      onError: (error) => {
        this.emitError('subscription', error);
        this.scheduleReconnect(`swap subscription error: ${error.message}`);
      },
    });

    // Mint/Burn are opt-in: they cannot move the tick, so they are never a
    // crossing signal. Only subscribe when someone actually wants them.
    if (!this.callbacks.onLiquidityChange) return;
    this.unwatchLiquidity = client.watchEvent({
      address: pools,
      events: LIQUIDITY_EVENTS,
      strict: true,
      onLogs: (logs) => {
        const observedAt = this.now();
        for (const log of logs) {
          if (log.removed === true) continue;
          const change: LiquidityChange = {
            pool: log.address.toLowerCase() as Address,
            kind: log.eventName === 'Mint' ? 'mint' : 'burn',
            tickLower: log.args.tickLower,
            tickUpper: log.args.tickUpper,
            amount: log.args.amount,
            blockNumber: log.blockNumber,
            observedAt,
          };
          this.invoke(this.callbacks.onLiquidityChange, change);
        }
      },
      onError: (error) => this.emitError('subscription', error),
    });
  }

  private startPollLoop(): void {
    this.clearTimer('pollTimer');
    this.pollTimer = setInterval(() => void this.pollTicks(), this.config.pollIntervalMs);
  }

  private teardownConnection(): void {
    this.unwatchSwaps?.();
    this.unwatchSwaps = null;
    this.unwatchLiquidity?.();
    this.unwatchLiquidity = null;
    this.unwatchBlocks?.();
    this.unwatchBlocks = null;
    this.clearTimer('pollTimer');
    this.client = null;
  }

  private scheduleReconnect(reason: string): void {
    if (!this.running) return;
    // A reconnect already queued: let it run rather than restarting its backoff.
    if (this.reconnectTimer !== null) return;

    this.teardownConnection();

    const nextAttempt = this.attempt + 1;
    const canFallBack =
      this.mode === 'websocket' &&
      this.config.preferredMode === 'auto' &&
      nextAttempt >= this.config.maxWebsocketAttempts;

    if (canFallBack) {
      // Degrade — loudly. Health becomes 'degraded' with a reason the moment
      // the polling connection comes up, and lowLatency goes false.
      this.mode = 'polling';
      this.attempt = 0;
      const fallbackReason = `WebSocket unavailable after ${this.config.maxWebsocketAttempts} attempts (${reason}); polling every ${this.config.pollIntervalMs}ms — reaction is no longer sub-second`;
      this.logger.warn?.('lp-rpc: falling back to polling', { reason });
      this.setHealth('starting', fallbackReason);
      this.scheduleWebsocketRetry();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.connect();
      }, 0);
      return;
    }

    const delay = backoffDelayMs(this.attempt, this.backoff, this.random);
    this.attempt = nextAttempt;
    this.setHealth('starting', `reconnecting in ${Math.round(delay)}ms: ${reason}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /** While degraded to polling, periodically try to get back on the socket. */
  private scheduleWebsocketRetry(): void {
    this.clearTimer('websocketRetryTimer');
    if (this.config.preferredMode !== 'auto' || !this.config.wsUrl) return;
    this.websocketRetryTimer = setTimeout(() => {
      this.websocketRetryTimer = null;
      if (!this.running || this.mode !== 'polling') return;
      this.logger.info?.('lp-rpc: retrying websocket transport');
      this.mode = 'websocket';
      this.attempt = 0;
      void this.connect();
    }, this.websocketRetryMs);
  }

  // --- heartbeat -----------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = Math.max(250, Math.floor(this.config.stalenessMs / 3));
    this.heartbeatTimer = setInterval(() => this.checkStaleness(), interval);
  }

  private stopHeartbeat(): void {
    this.clearTimer('heartbeatTimer');
  }

  private checkStaleness(): void {
    if (!this.running) return;
    const now = this.now();
    const result = evaluateStaleness(this.lastBlockAt, now, this.config.stalenessMs);
    if (!result.stale) return;

    const first = this.staleSince === null;
    if (first) {
      this.staleSince = now;
      this.staleRepeat = 0;
    } else {
      // Stay loud, but not spammy: at most one alert per threshold window.
      if (now - this.lastStaleAlertAt < this.config.stalenessMs) return;
      this.staleRepeat += 1;
    }
    this.lastStaleAlertAt = now;

    this.setHealth(
      'stale',
      `no block seen for ${Math.round(result.sinceMs)}ms (threshold ${result.thresholdMs}ms) — positions are NOT being watched`,
    );
    this.invoke(this.callbacks.onStale, {
      mode: this.mode,
      sinceMs: result.sinceMs,
      thresholdMs: result.thresholdMs,
      lastBlockAt: this.lastBlockAt,
      lastBlockNumber: this.lastBlockNumber,
      repeat: this.staleRepeat,
    });

    // A subscription that has stopped delivering blocks is dead until proven
    // otherwise; rebuild it rather than waiting for an error that may never come.
    this.scheduleReconnect('staleness threshold exceeded');
  }

  // --- chain events --------------------------------------------------------

  private handleBlockNumber(blockNumber: bigint): void {
    this.lastBlockNumber = blockNumber;
    this.lastBlockAt = this.now();
    this.attempt = 0;
    this.staleSince = null;
    this.staleRepeat = 0;

    if (this.mode === 'websocket') {
      this.setHealth('live', null);
    } else {
      this.setHealth(
        'degraded',
        `polling every ${this.config.pollIntervalMs}ms — reaction is bounded by the poll interval, not sub-second`,
      );
    }

    void this.resolvePending(blockNumber);
  }

  private handleSwapLogs(logs: readonly SwapLog[]): void {
    const observedAt = this.now();

    // Reorged-out logs invalidate anything pending from that block.
    for (const log of logs) {
      if (log.removed === true) this.handleRemovedLog(log);
    }

    const byPool = new Map<Address, SwapLog[]>();
    for (const log of logs) {
      if (log.removed === true) continue;
      const pool = log.address.toLowerCase() as Address;
      const bucket = byPool.get(pool);
      if (bucket) bucket.push(log);
      else byPool.set(pool, [log]);
    }

    for (const [pool, poolLogs] of byPool) {
      // Only the last swap in the batch describes the pool's current tick;
      // acting on an earlier one means reacting to a price already superseded.
      const latest = pickLatestLog(poolLogs);
      if (!latest) continue;
      this.applyTick({
        pool,
        tick: latest.args.tick,
        source: 'swap',
        blockNumber: latest.blockNumber,
        observedAt,
        mode: this.mode,
      });
    }
  }

  private handleRemovedLog(log: SwapLog): void {
    const pool = log.address.toLowerCase() as Address;
    for (const [tokenId, pending] of [...this.pending]) {
      if (pending.watched.pool !== pool) continue;
      if (pending.blockNumber === null || pending.blockNumber !== log.blockNumber) continue;
      this.pending.delete(tokenId);
      this.emitCrossing({
        phase: 'reverted',
        reason: 'reorg',
        watched: pending.watched,
        observation: pending.observation,
        previousSide: pending.previousSide,
        side: pending.side,
        exitPercent: pending.exitPercent,
        ticksOutside: pending.ticksOutside,
      });
    }
  }

  private async pollTicks(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const pools = this.poolAddresses();
    if (pools.length === 0) return;

    await Promise.all(
      pools.map(async (pool) => {
        try {
          const tick = await this.readTick(pool);
          this.applyTick({
            pool,
            tick,
            source: 'slot0',
            blockNumber: this.lastBlockNumber,
            observedAt: this.now(),
            mode: this.mode,
          });
        } catch (error) {
          this.emitError('poll', error);
        }
      }),
    );
  }

  /** Reads the pool's current tick from slot0, optionally at a historical block. */
  private async readTick(pool: Address, blockNumber?: bigint): Promise<number> {
    const client = this.client;
    if (!client) throw new Error('PoolWatcher: no RPC client');
    const slot0 = await client.readContract({
      address: pool,
      abi: UNISWAP_V3_POOL_ABI,
      functionName: 'slot0',
      ...(blockNumber === undefined ? {} : { blockNumber }),
    });
    return slot0[1];
  }

  /**
   * Reads slot0 for every watched pool and reconciles state against it.
   *
   * Run on every (re)connect: while we were disconnected the tick may have left
   * a range entirely, and nothing will replay that swap for us. Re-deriving
   * from canonical state is the only way that crossing is not lost.
   */
  private async seed(): Promise<void> {
    const pools = this.poolAddresses();
    if (pools.length === 0) return;

    await Promise.all(
      pools.map(async (pool) => {
        try {
          const tick = await this.readTick(pool);
          this.applyTick(
            {
              pool,
              tick,
              source: 'slot0',
              blockNumber: this.lastBlockNumber,
              observedAt: this.now(),
              mode: this.mode,
            },
            { seeding: true },
          );
        } catch (error) {
          this.emitError('connect', error);
        }
      }),
    );
  }

  // --- crossing state machine ---------------------------------------------

  private applyTick(observation: TickObservation, options: { seeding?: boolean } = {}): void {
    this.lastTickByPool.set(observation.pool, observation.tick);
    this.invoke(this.callbacks.onObservation, observation);

    for (const range of this.ranges.values()) {
      if (range.pool !== observation.pool) continue;
      if (options.seeding) this.seedRange(range, observation);
      else this.reconcileRange(range, observation);
    }
  }

  /**
   * Live path: compare the observation against the last CONFIRMED side and open,
   * update, or revert a pending crossing.
   */
  private reconcileRange(range: WatchedRange, observation: TickObservation): void {
    const evaluation = evaluateRange(observation.tick, range.tickLower, range.tickUpper);
    const confirmedSide = this.sideByRange.get(range.tokenId) ?? null;
    const pending = this.pending.get(range.tokenId);

    if (evaluation.side === confirmedSide) {
      // Back where we started before the pending crossing could confirm.
      if (pending) {
        this.pending.delete(range.tokenId);
        this.emitCrossing({
          phase: 'reverted',
          reason: 'price_returned',
          watched: range,
          observation,
          previousSide: pending.previousSide,
          side: pending.side,
          exitPercent: pending.exitPercent,
          ticksOutside: pending.ticksOutside,
        });
      }
      return;
    }

    if (pending && pending.side === evaluation.side) {
      // Same crossing, fresher numbers. Keep the ORIGINAL block so confirmation
      // depth is measured from first sighting, and do not re-emit 'observed'.
      pending.observation = observation;
      pending.exitPercent = evaluation.exitPercent;
      pending.ticksOutside = evaluation.ticksOutside;
      return;
    }

    if (pending) {
      // Flipped to a different out-of-range side before confirming.
      this.pending.delete(range.tokenId);
      this.emitCrossing({
        phase: 'reverted',
        reason: 'price_returned',
        watched: range,
        observation,
        previousSide: pending.previousSide,
        side: pending.side,
        exitPercent: pending.exitPercent,
        ticksOutside: pending.ticksOutside,
      });
    }

    const next: PendingCrossing = {
      watched: range,
      observation,
      side: evaluation.side,
      previousSide: confirmedSide,
      exitPercent: evaluation.exitPercent,
      ticksOutside: evaluation.ticksOutside,
      blockNumber: observation.blockNumber ?? this.lastBlockNumber,
    };
    this.pending.set(range.tokenId, next);

    this.emitCrossing({
      phase: 'observed',
      watched: range,
      observation,
      previousSide: confirmedSide,
      side: evaluation.side,
      exitPercent: evaluation.exitPercent,
      ticksOutside: evaluation.ticksOutside,
    });

    if (this.config.confirmations === 0 && this.lastBlockNumber !== null) {
      void this.resolvePending(this.lastBlockNumber);
    }
  }

  /**
   * Reconnect/startup path: slot0 is canonical, so it settles the side directly
   * without waiting for confirmations (it is already canonical state).
   *
   * `previousSide: null` on the emitted crossing is meaningful — it tells rules
   * "this position was already out of range when the watcher came up", which is
   * not the same thing as "it just crossed".
   */
  private seedRange(range: WatchedRange, observation: TickObservation): void {
    const evaluation = evaluateRange(observation.tick, range.tickLower, range.tickUpper);
    const previousSide = this.sideByRange.get(range.tokenId) ?? null;
    const pending = this.pending.get(range.tokenId);

    if (pending) {
      this.pending.delete(range.tokenId);
      if (pending.side !== evaluation.side) {
        this.emitCrossing({
          phase: 'reverted',
          reason: 'price_returned',
          watched: range,
          observation,
          previousSide: pending.previousSide,
          side: pending.side,
          exitPercent: pending.exitPercent,
          ticksOutside: pending.ticksOutside,
        });
      }
    }

    this.sideByRange.set(range.tokenId, evaluation.side);
    if (evaluation.side === previousSide) return;
    if (previousSide === null && evaluation.side === 'inside') return;

    const base = {
      watched: range,
      observation,
      previousSide,
      side: evaluation.side,
      exitPercent: evaluation.exitPercent,
      ticksOutside: evaluation.ticksOutside,
    };
    this.emitCrossing({ phase: 'observed', ...base });
    this.emitCrossing({ phase: 'confirmed', verifiedBy: 'slot0', depth: 0, ...base });
  }

  private async resolvePending(head: bigint): Promise<void> {
    if (this.pending.size === 0 || this.resolving) return;
    this.resolving = true;
    try {
      for (const [tokenId, pending] of [...this.pending]) {
        if (pending.blockNumber === null) {
          // First head we have seen since the crossing: anchor it here.
          pending.blockNumber = head;
          continue;
        }
        if (!isConfirmed(pending.blockNumber, head, this.config.confirmations)) continue;
        this.pending.delete(tokenId);
        await this.confirmCrossing(pending, head);
      }
    } finally {
      this.resolving = false;
    }
  }

  private async confirmCrossing(pending: PendingCrossing, head: bigint): Promise<void> {
    const observedBlock = pending.blockNumber ?? head;
    const depth = confirmationDepth(observedBlock, head);

    let tick = pending.observation.tick;
    let verifiedBy: 'slot0' | 'log' = 'log';

    if (this.config.confirmations > 0 && this.client) {
      const confirmBlock = observedBlock + BigInt(this.config.confirmations);
      try {
        tick = await this.readTick(pending.watched.pool, confirmBlock);
        verifiedBy = 'slot0';
      } catch (error) {
        // Weaker evidence, reported rather than hidden (see verifiedBy).
        this.emitError('confirm', error);
      }
    }

    const verified = evaluateRange(tick, pending.watched.tickLower, pending.watched.tickUpper);

    // The verified side at confirmation depth is the truth — not the pending
    // side. If it matches the last confirmed side, the crossing did not hold.
    if (verified.side === pending.previousSide) {
      this.emitCrossing({
        phase: 'reverted',
        reason: verifiedBy === 'slot0' ? 'reorg' : 'price_returned',
        watched: pending.watched,
        observation: pending.observation,
        previousSide: pending.previousSide,
        side: pending.side,
        exitPercent: pending.exitPercent,
        ticksOutside: pending.ticksOutside,
      });
      return;
    }

    this.sideByRange.set(pending.watched.tokenId, verified.side);
    this.emitCrossing({
      phase: 'confirmed',
      verifiedBy,
      depth,
      watched: pending.watched,
      observation: pending.observation,
      previousSide: pending.previousSide,
      side: verified.side,
      exitPercent: verified.exitPercent,
      ticksOutside: verified.ticksOutside,
    });
  }

  // --- plumbing ------------------------------------------------------------

  private registerRange(range: WatchedRange): WatchedRange {
    const normalized: WatchedRange = {
      ...range,
      pool: range.pool.toLowerCase() as Address,
    };
    // Fail fast on a malformed range rather than at the first observation.
    evaluateRange(normalized.tickLower, normalized.tickLower, normalized.tickUpper);
    this.ranges.set(normalized.tokenId, normalized);
    return normalized;
  }

  private poolAddresses(): Address[] {
    return [...new Set([...this.ranges.values()].map((r) => r.pool))].sort();
  }

  private setHealth(health: WatcherHealth, reason: string | null): void {
    if (this.health === health && this.reason === reason) return;
    this.health = health;
    this.reason = reason;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.invoke(this.callbacks.onStatus, this.getStatus());
  }

  private emitCrossing(event: CrossingEvent): void {
    this.invoke(this.callbacks.onCrossing, event);
  }

  private emitError(scope: WatcherError['scope'], cause: unknown): void {
    const message = cause instanceof Error ? cause.message : String(cause);
    this.logger.error?.(`lp-rpc: ${scope} error`, { message });
    const handler = this.callbacks.onError;
    if (!handler) return;
    try {
      handler({ scope, message, cause });
    } catch {
      // A throwing error handler must not take the watcher down with it.
    }
  }

  /** Calls a consumer callback without letting it kill the watcher. */
  private invoke<T>(handler: ((arg: T) => void) | undefined, arg: T): void {
    if (!handler) return;
    try {
      handler(arg);
    } catch (error) {
      this.emitError('callback', error);
    }
  }

  private clearTimer(
    key: 'heartbeatTimer' | 'pollTimer' | 'reconnectTimer' | 'websocketRetryTimer',
  ): void {
    const timer = this[key];
    if (timer === null) return;
    if (key === 'heartbeatTimer' || key === 'pollTimer') clearInterval(timer);
    else clearTimeout(timer);
    this[key] = null;
  }
}
