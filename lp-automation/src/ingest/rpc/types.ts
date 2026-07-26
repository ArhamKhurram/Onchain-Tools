// Public surface of the RPC watch layer: what it observes and what it reports.
//
// This module OBSERVES. It never decides whether to act. Nothing here encodes a
// threshold, a buffer, or a policy comparison — `exitPercent` is reported as a
// measurement so `src/rules/` can compare it against the policy's
// `rebalanceTrigger.rangeExitPercent`. Keeping that seam clean is why this file
// has no notion of "should rebalance".

import type { Address } from '../../types.js';
import type { RangeSide } from './tickMath.js';

/** Which transport is actually carrying observations right now. */
export type WatchMode = 'websocket' | 'polling';

/**
 * - `starting`  — connecting or reconnecting; no observations flowing yet.
 * - `live`      — WebSocket push, blocks arriving, sub-second reaction available.
 * - `degraded`  — still observing, but slower than promised (polling fallback).
 * - `stale`     — no block seen within the staleness threshold. Treat the
 *                 watcher as NOT watching until this clears.
 * - `stopped`   — deliberately stopped.
 */
export type WatcherHealth = 'starting' | 'live' | 'degraded' | 'stale' | 'stopped';

/** A position's range, registered for watching. */
export interface WatchedRange {
  /** Correlation id — the Uniswap V3 NonfungiblePositionManager token id. */
  tokenId: string;
  /** Pool contract address (lowercased on registration). */
  pool: Address;
  tickLower: number;
  tickUpper: number;
}

/** A single reading of a pool's current tick. */
export interface TickObservation {
  pool: Address;
  tick: number;
  /** `swap` = pushed by a Swap log; `slot0` = read via eth_call. */
  source: 'swap' | 'slot0';
  /** Block the reading came from; null only if the node omitted it. */
  blockNumber: bigint | null;
  /** Local wall clock at the moment we processed it. */
  observedAt: number;
  /** Transport in use when this reading was taken. */
  mode: WatchMode;
}

interface CrossingBase {
  watched: WatchedRange;
  observation: TickObservation;
  /** Last *confirmed* side, or null when the watcher had no prior state. */
  previousSide: RangeSide | null;
  side: RangeSide;
  /** How far past the breached bound, as a percentage. 0 when back inside. */
  exitPercent: number;
  ticksOutside: number;
}

/**
 * A side change seen at the chain head, not yet confirmed. Safe to use for
 * pre-warming work (fetching calldata, dry-running) but NOT to broadcast on —
 * a reorg can still take it back.
 */
export interface ObservedCrossing extends CrossingBase {
  phase: 'observed';
}

/** The crossing survived the confirmation policy. This is the actionable one. */
export interface ConfirmedCrossing extends CrossingBase {
  phase: 'confirmed';
  /**
   * How the crossing was verified at confirmation depth:
   * - `slot0` — state was re-read at the confirmation block (reorg-proof).
   * - `log`   — that read failed and we fell back to the log-derived tick.
   *             Reported rather than hidden, so a consumer can choose to treat
   *             it as weaker evidence.
   */
  verifiedBy: 'slot0' | 'log';
  /** Confirmation depth actually achieved when we emitted. */
  depth: number;
}

/** The crossing did not hold — reorged out, or price moved back before depth. */
export interface RevertedCrossing extends CrossingBase {
  phase: 'reverted';
  reason: 'reorg' | 'price_returned';
}

export type CrossingEvent = ObservedCrossing | ConfirmedCrossing | RevertedCrossing;

/** Mint/Burn — informational. These never move the tick, so never a crossing. */
export interface LiquidityChange {
  pool: Address;
  kind: 'mint' | 'burn';
  tickLower: number;
  tickUpper: number;
  amount: bigint;
  blockNumber: bigint | null;
  observedAt: number;
}

/** Fired when no block has been seen for longer than the staleness threshold. */
export interface StaleAlert {
  mode: WatchMode;
  /** ms since the last block; `Infinity` if none was ever seen. */
  sinceMs: number;
  thresholdMs: number;
  lastBlockAt: number | null;
  lastBlockNumber: bigint | null;
  /** How many times this alert has repeated within the current stale episode. */
  repeat: number;
}

export interface WatcherStatus {
  mode: WatchMode;
  health: WatcherHealth;
  /** True only for `websocket` + `live`. The honest sub-second-capable flag. */
  lowLatency: boolean;
  /** Populated whenever health is `degraded` or `stale`, else null. */
  reason: string | null;
  lastBlockAt: number | null;
  lastBlockNumber: bigint | null;
  reconnectAttempts: number;
  watchedPools: Address[];
  watchedRanges: number;
}

export interface WatcherError {
  scope: 'connect' | 'subscription' | 'poll' | 'confirm' | 'callback';
  message: string;
  cause: unknown;
}

export interface PoolWatcherCallbacks {
  /** Range side changes. The only crossing signal; rules decides what to do. */
  onCrossing?: (event: CrossingEvent) => void;
  /** Every tick reading, crossing or not. Useful for the audit log. */
  onObservation?: (observation: TickObservation) => void;
  /** Any transport/mode/health transition. Fires on every change. */
  onStatus?: (status: WatcherStatus) => void;
  /** Loud: the chain has gone quiet. Treat positions as unwatched. */
  onStale?: (alert: StaleAlert) => void;
  /** Non-fatal errors. The watcher keeps trying; this is for observability. */
  onError?: (error: WatcherError) => void;
  /** Opt-in: subscribing to Mint/Burn only happens if this is provided. */
  onLiquidityChange?: (change: LiquidityChange) => void;
}

export interface WatcherLogger {
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
}
