// Unit tests for the low-latency RPC watch layer (`src/ingest/rpc/`).
//
// No network, no chain, no timers. Everything exercised here is pure by
// construction — that is the whole reason the watcher's arithmetic was factored
// out of the class. The parts that genuinely need a node (subscription
// lifecycle, reconnect against a real socket) are not fakeable honestly and are
// deliberately left to live verification rather than mocked into a green tick.

import { describe, expect, it } from 'vitest';

import {
  assertValidRange,
  assertValidTick,
  evaluateRange,
  isOutsideRange,
  MAX_TICK,
  MIN_TICK,
  priceToNearestTick,
  priceToTick,
  tickToPrice,
  TickRangeError,
} from '../src/ingest/rpc/tickMath.js';
import {
  backoffDelayMs,
  DEFAULT_BACKOFF,
  evaluateStaleness,
  isStale,
} from '../src/ingest/rpc/health.js';
import {
  compareLogOrder,
  confirmationDepth,
  isConfirmed,
  pickLatestLog,
} from '../src/ingest/rpc/observations.js';
import { parseRpcConfig, RpcConfigError, RPC_CONFIG_DEFAULTS } from '../src/ingest/rpc/config.js';
import { defineRobinhoodChain } from '../src/ingest/rpc/chain.js';
import { PoolWatcher } from '../src/ingest/rpc/poolWatcher.js';
import { ROBINHOOD_CHAIN_ID, type Address } from '../src/types.js';

// ---------------------------------------------------------------------------
// tick <-> price
// ---------------------------------------------------------------------------

describe('tickToPrice', () => {
  it('anchors at 1 for tick 0 and steps by 1bp per tick', () => {
    expect(tickToPrice(0)).toBe(1);
    expect(tickToPrice(1)).toBeCloseTo(1.0001, 12);
    expect(tickToPrice(-1)).toBeCloseTo(1 / 1.0001, 12);
  });

  it('matches 1.0001^tick across the ordinary range', () => {
    for (const tick of [2, 10, 500, -500, 12_345, -12_345, 100_000, -100_000]) {
      expect(tickToPrice(tick)).toBeCloseTo(Math.pow(1.0001, tick), Math.abs(tick) > 1000 ? 0 : 8);
      // Relative agreement is the meaningful check at large magnitudes.
      const rel = Math.abs(tickToPrice(tick) - Math.pow(1.0001, tick)) / Math.pow(1.0001, tick);
      expect(rel).toBeLessThan(1e-9);
    }
  });

  it('stays finite and non-zero at Uniswap’s extremes', () => {
    const max = tickToPrice(MAX_TICK);
    const min = tickToPrice(MIN_TICK);
    expect(Number.isFinite(max)).toBe(true);
    expect(max).toBeGreaterThan(3.4e38);
    expect(max).toBeLessThan(3.41e38);
    expect(min).toBeGreaterThan(0);
    expect(min).toBeLessThan(3e-39);
    // Reciprocal symmetry: 1.0001^-t === 1 / 1.0001^t.
    expect(Math.abs(min * max - 1)).toBeLessThan(1e-9);
  });

  it('is strictly monotonic', () => {
    let previous = tickToPrice(-1000);
    for (let tick = -999; tick <= 1000; tick += 1) {
      const price = tickToPrice(tick);
      expect(price).toBeGreaterThan(previous);
      previous = price;
    }
  });

  it('rejects non-integer and out-of-bounds ticks', () => {
    expect(() => tickToPrice(1.5)).toThrow(TickRangeError);
    expect(() => tickToPrice(Number.NaN)).toThrow(TickRangeError);
    expect(() => tickToPrice(MAX_TICK + 1)).toThrow(TickRangeError);
    expect(() => tickToPrice(MIN_TICK - 1)).toThrow(TickRangeError);
    // The bounds themselves are valid.
    expect(() => tickToPrice(MAX_TICK)).not.toThrow();
    expect(() => tickToPrice(MIN_TICK)).not.toThrow();
  });
});

describe('priceToTick', () => {
  it('inverts tickToPrice to within floating-point noise', () => {
    for (const tick of [0, 1, -1, 887, -887, 123_456, -123_456, MAX_TICK, MIN_TICK]) {
      expect(priceToTick(tickToPrice(tick))).toBeCloseTo(tick, 6);
      expect(priceToNearestTick(tickToPrice(tick))).toBe(tick);
    }
  });

  it('returns an un-rounded real tick, leaving rounding to the caller', () => {
    const exact = priceToTick(Math.sqrt(1.0001));
    expect(exact).toBeCloseTo(0.5, 9);
    expect(Number.isInteger(exact)).toBe(false);
  });

  it('rejects non-positive and non-finite prices', () => {
    for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => priceToTick(price)).toThrow(TickRangeError);
    }
  });

  it('throws rather than clamping when a price implies an impossible tick', () => {
    // Twice the max price is ~6931 ticks past MAX_TICK. Clamping here would
    // silently hand back a tick that does not mean what was asked.
    expect(() => priceToNearestTick(tickToPrice(MAX_TICK) * 2)).toThrow(TickRangeError);
    expect(() => priceToNearestTick(tickToPrice(MIN_TICK) / 2)).toThrow(TickRangeError);
  });
});

// ---------------------------------------------------------------------------
// range evaluation
// ---------------------------------------------------------------------------

describe('evaluateRange', () => {
  const lower = -200;
  const upper = 300;

  it('reports inside for a tick strictly within the range', () => {
    const result = evaluateRange(0, lower, upper);
    expect(result).toEqual({
      side: 'inside',
      inside: true,
      ticksOutside: 0,
      exitFraction: 0,
      exitPercent: 0,
    });
  });

  it('treats tickLower as inside (Uniswap lower bound is inclusive)', () => {
    const result = evaluateRange(lower, lower, upper);
    expect(result.side).toBe('inside');
    expect(result.ticksOutside).toBe(0);
    expect(result.exitPercent).toBe(0);
    expect(isOutsideRange(lower, lower, upper)).toBe(false);
  });

  it('treats tickUpper as OUT of range by default, with zero exit distance', () => {
    // Uniswap V3 activates liquidity for tickLower <= tick < tickUpper, so at
    // exactly tickUpper the position has stopped earning.
    const result = evaluateRange(upper, lower, upper);
    expect(result.side).toBe('above');
    expect(result.inside).toBe(false);
    expect(result.ticksOutside).toBe(0);
    expect(result.exitFraction).toBe(0);
    expect(isOutsideRange(upper, lower, upper)).toBe(true);
  });

  it('honours inclusiveUpper for callers that want a closed interval', () => {
    const result = evaluateRange(upper, lower, upper, { inclusiveUpper: true });
    expect(result.side).toBe('inside');
    // One past the upper bound is still out, either way.
    expect(evaluateRange(upper + 1, lower, upper, { inclusiveUpper: true }).side).toBe('above');
    expect(evaluateRange(upper - 1, lower, upper, { inclusiveUpper: true }).side).toBe('inside');
  });

  it('measures a one-tick breach as exactly one basis point', () => {
    const above = evaluateRange(upper + 1, lower, upper);
    expect(above.side).toBe('above');
    expect(above.ticksOutside).toBe(1);
    expect(Math.abs(above.exitFraction - 1e-4)).toBeLessThan(1e-15);
    expect(above.exitPercent).toBeCloseTo(0.01, 10);

    const below = evaluateRange(lower - 1, lower, upper);
    expect(below.side).toBe('below');
    expect(below.ticksOutside).toBe(1);
    // 1 - 1.0001^-1, marginally under 1bp.
    expect(below.exitFraction).toBeCloseTo(1 - 1 / 1.0001, 15);
    expect(below.exitFraction).toBeLessThan(1e-4);
  });

  it('matches the closed-form ratio for both directions', () => {
    for (const n of [1, 2, 17, 250, 5_000]) {
      const above = evaluateRange(upper + n, lower, upper);
      expect(above.exitFraction).toBeCloseTo(Math.pow(1.0001, n) - 1, 9);

      const below = evaluateRange(lower - n, lower, upper);
      expect(below.exitFraction).toBeCloseTo(1 - Math.pow(1.0001, -n), 12);
    }
  });

  it('handles wholly negative ranges', () => {
    const negLower = -5_000;
    const negUpper = -1_000;
    expect(evaluateRange(-3_000, negLower, negUpper).side).toBe('inside');

    const below = evaluateRange(-5_100, negLower, negUpper);
    expect(below.side).toBe('below');
    expect(below.ticksOutside).toBe(100);

    const above = evaluateRange(-900, negLower, negUpper);
    expect(above.side).toBe('above');
    expect(above.ticksOutside).toBe(100);
    // Distance depends only on the tick delta, not on the sign of the ticks.
    expect(above.exitFraction).toBeCloseTo(Math.pow(1.0001, 100) - 1, 12);
  });

  it('stays finite for a maximal breach above the range', () => {
    const result = evaluateRange(MAX_TICK, MIN_TICK, MIN_TICK + 10);
    expect(result.side).toBe('above');
    expect(result.ticksOutside).toBe(MAX_TICK - (MIN_TICK + 10));
    expect(Number.isFinite(result.exitFraction)).toBe(true);
    expect(result.exitFraction).toBeGreaterThan(1e70);
  });

  it('saturates at 1 (not beyond) for a maximal breach below the range', () => {
    const result = evaluateRange(MIN_TICK, MAX_TICK - 1, MAX_TICK);
    expect(result.side).toBe('below');
    expect(result.ticksOutside).toBe(MAX_TICK - 1 - MIN_TICK);
    // Price can only fall to zero, so the fraction is bounded by 1.
    expect(result.exitFraction).toBeLessThanOrEqual(1);
    expect(result.exitFraction).toBeCloseTo(1, 12);
    expect(result.exitPercent).toBeLessThanOrEqual(100);
  });

  it('keeps full precision for a tiny breach at an extreme tick', () => {
    // The naive price-ratio formulation would be computing 1e38 / 1e38 here.
    const result = evaluateRange(MAX_TICK, MAX_TICK - 2, MAX_TICK - 1);
    expect(result.side).toBe('above');
    expect(result.ticksOutside).toBe(1);
    expect(Math.abs(result.exitFraction - 1e-4)).toBeLessThan(1e-15);
  });

  it('spans the full tick domain without losing the inside verdict', () => {
    expect(evaluateRange(0, MIN_TICK, MAX_TICK).side).toBe('inside');
    expect(evaluateRange(MIN_TICK, MIN_TICK, MAX_TICK).side).toBe('inside');
    expect(evaluateRange(MAX_TICK, MIN_TICK, MAX_TICK).side).toBe('above');
  });

  it('rejects malformed ranges and ticks', () => {
    expect(() => evaluateRange(0, 100, 100)).toThrow(TickRangeError);
    expect(() => evaluateRange(0, 200, 100)).toThrow(TickRangeError);
    expect(() => evaluateRange(0, -100, 100.5)).toThrow(TickRangeError);
    expect(() => evaluateRange(0, MIN_TICK - 1, 100)).toThrow(TickRangeError);
    expect(() => evaluateRange(MAX_TICK + 1, -100, 100)).toThrow(TickRangeError);
    expect(() => assertValidRange(-1, 1)).not.toThrow();
    expect(() => assertValidTick(MIN_TICK)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// backoff
// ---------------------------------------------------------------------------

describe('backoffDelayMs', () => {
  const deterministic = { jitterRatio: 0 };

  it('grows exponentially from the base delay', () => {
    const options = { ...deterministic, baseDelayMs: 250, factor: 2, maxDelayMs: 30_000 };
    expect(backoffDelayMs(0, options)).toBe(250);
    expect(backoffDelayMs(1, options)).toBe(500);
    expect(backoffDelayMs(2, options)).toBe(1_000);
    expect(backoffDelayMs(3, options)).toBe(2_000);
  });

  it('caps at maxDelayMs and stays capped forever after', () => {
    const options = { ...deterministic, baseDelayMs: 250, factor: 2, maxDelayMs: 4_000 };
    expect(backoffDelayMs(4, options)).toBe(4_000);
    expect(backoffDelayMs(5, options)).toBe(4_000);
    expect(backoffDelayMs(500, options)).toBe(4_000);
    // factor ** attempt overflows to Infinity long before this; the cap must
    // still win rather than producing NaN or Infinity.
    expect(backoffDelayMs(100_000, options)).toBe(4_000);
    expect(Number.isFinite(backoffDelayMs(100_000, options))).toBe(true);
  });

  it('caps exactly at the boundary attempt', () => {
    const options = { ...deterministic, baseDelayMs: 100, factor: 10, maxDelayMs: 1_000 };
    expect(backoffDelayMs(0, options)).toBe(100);
    expect(backoffDelayMs(1, options)).toBe(1_000); // exactly the cap
    expect(backoffDelayMs(2, options)).toBe(1_000); // would be 10_000
  });

  it('applies jitter below the cap, never above it', () => {
    const options = { baseDelayMs: 1_000, factor: 2, maxDelayMs: 1_000, jitterRatio: 0.2 };
    expect(backoffDelayMs(0, options, () => 0)).toBeCloseTo(800, 9);
    expect(backoffDelayMs(0, options, () => 1)).toBeCloseTo(1_000, 9);
    expect(backoffDelayMs(0, options, () => 0.5)).toBeCloseTo(900, 9);
  });

  it('never exceeds maxDelayMs for any attempt or jitter draw', () => {
    const options = { baseDelayMs: 37, factor: 3, maxDelayMs: 5_000, jitterRatio: 1 };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      for (const r of [0, 0.25, 0.5, 0.75, 1]) {
        const delay = backoffDelayMs(attempt, options, () => r);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(5_000);
      }
    }
  });

  it('treats a nonsense attempt as the first retry instead of throwing', () => {
    const options = { ...deterministic, baseDelayMs: 250, factor: 2, maxDelayMs: 30_000 };
    expect(backoffDelayMs(-5, options)).toBe(250);
    expect(backoffDelayMs(Number.NaN, options)).toBe(250);
    expect(backoffDelayMs(1.9, options)).toBe(500); // floored to attempt 1
  });

  it('supports a constant (non-exponential) schedule', () => {
    const options = { ...deterministic, baseDelayMs: 750, factor: 1, maxDelayMs: 30_000 };
    expect(backoffDelayMs(0, options)).toBe(750);
    expect(backoffDelayMs(9, options)).toBe(750);
  });

  it('falls back to the shipped defaults', () => {
    expect(backoffDelayMs(0, { jitterRatio: 0 })).toBe(DEFAULT_BACKOFF.baseDelayMs);
  });

  it('rejects invalid option values', () => {
    expect(() => backoffDelayMs(0, { baseDelayMs: -1 })).toThrow(RangeError);
    expect(() => backoffDelayMs(0, { maxDelayMs: Number.NaN })).toThrow(RangeError);
    expect(() => backoffDelayMs(0, { factor: 0.5 })).toThrow(RangeError);
    expect(() => backoffDelayMs(0, { jitterRatio: 1.5 })).toThrow(RangeError);
    expect(() => backoffDelayMs(0, { jitterRatio: -0.1 })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// staleness
// ---------------------------------------------------------------------------

describe('evaluateStaleness', () => {
  it('is healthy below the threshold', () => {
    const result = evaluateStaleness(1_000, 1_000 + 9_999, 10_000);
    expect(result.stale).toBe(false);
    expect(result.sinceMs).toBe(9_999);
    expect(result.thresholdMs).toBe(10_000);
  });

  it('is stale at EXACTLY the threshold', () => {
    // Documented bias: this detector fails loud. One millisecond early costs
    // nothing; one policy tick late costs a position.
    const result = evaluateStaleness(1_000, 11_000, 10_000);
    expect(result.stale).toBe(true);
    expect(result.sinceMs).toBe(10_000);
    expect(isStale(1_000, 11_000, 10_000)).toBe(true);
    // ...and healthy one millisecond earlier.
    expect(isStale(1_000, 10_999, 10_000)).toBe(false);
  });

  it('is stale beyond the threshold', () => {
    expect(evaluateStaleness(0, 60_000, 10_000).stale).toBe(true);
  });

  it('treats "never seen a block" as stale with infinite age', () => {
    const result = evaluateStaleness(null, 5_000, 10_000);
    expect(result.stale).toBe(true);
    expect(result.sinceMs).toBe(Number.POSITIVE_INFINITY);
  });

  it('clamps clock skew instead of reporting a negative age', () => {
    const result = evaluateStaleness(50_000, 1_000, 10_000);
    expect(result.sinceMs).toBe(0);
    expect(result.stale).toBe(false);
  });

  it('handles a zero-length elapsed window', () => {
    expect(evaluateStaleness(1_000, 1_000, 10_000)).toEqual({
      stale: false,
      sinceMs: 0,
      thresholdMs: 10_000,
    });
  });

  it('treats a threshold of 1ms as immediately stale after 1ms', () => {
    expect(isStale(0, 1, 1)).toBe(true);
    expect(isStale(0, 0, 1)).toBe(false);
  });

  it('rejects a nonsensical threshold or clock', () => {
    expect(() => evaluateStaleness(0, 1, 0)).toThrow(RangeError);
    expect(() => evaluateStaleness(0, 1, -5)).toThrow(RangeError);
    expect(() => evaluateStaleness(0, 1, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => evaluateStaleness(0, Number.NaN, 10)).toThrow(RangeError);
    expect(() => evaluateStaleness(Number.NaN, 1, 10)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// observation ordering & confirmation depth
// ---------------------------------------------------------------------------

describe('log ordering', () => {
  const log = (blockNumber: bigint | null, logIndex: number | null, removed = false) => ({
    blockNumber,
    logIndex,
    removed,
  });

  it('orders by block, then by log index', () => {
    expect(compareLogOrder(log(1n, 0), log(2n, 0))).toBeLessThan(0);
    expect(compareLogOrder(log(2n, 0), log(1n, 9))).toBeGreaterThan(0);
    expect(compareLogOrder(log(5n, 1), log(5n, 4))).toBeLessThan(0);
    expect(compareLogOrder(log(5n, 4), log(5n, 4))).toBe(0);
  });

  it('sorts pending (block-less) logs first', () => {
    expect(compareLogOrder(log(null, 0), log(1n, 0))).toBeLessThan(0);
    expect(compareLogOrder(log(1n, 0), log(null, 0))).toBeGreaterThan(0);
  });

  it('picks the latest swap in a batch', () => {
    const logs = [log(10n, 3), log(11n, 0), log(10n, 7), log(9n, 99)];
    expect(pickLatestLog(logs)).toEqual(log(11n, 0));
  });

  it('picks the highest log index within the same block', () => {
    expect(pickLatestLog([log(10n, 1), log(10n, 8), log(10n, 4)])).toEqual(log(10n, 8));
  });

  it('ignores reorged-out and pending logs', () => {
    expect(pickLatestLog([log(10n, 0), log(12n, 0, true)])).toEqual(log(10n, 0));
    expect(pickLatestLog([log(10n, 0), log(null, 5)])).toEqual(log(10n, 0));
    expect(pickLatestLog([log(12n, 0, true)])).toBeNull();
    expect(pickLatestLog([])).toBeNull();
  });

  it('does not mutate the input batch', () => {
    const logs = [log(10n, 3), log(11n, 0), log(9n, 1)];
    const snapshot = [...logs];
    pickLatestLog(logs);
    expect(logs).toEqual(snapshot);
  });
});

describe('confirmation depth', () => {
  it('counts blocks between the observation and the head', () => {
    expect(confirmationDepth(100n, 100n)).toBe(0);
    expect(confirmationDepth(100n, 103n)).toBe(3);
  });

  it('clamps when the observation is ahead of the last known head', () => {
    // Routine over a socket: a log can beat its own newHeads notification.
    expect(confirmationDepth(105n, 100n)).toBe(0);
  });

  it('does not overflow for absurd block gaps', () => {
    const depth = confirmationDepth(0n, 10n ** 30n);
    expect(depth).toBe(Number.MAX_SAFE_INTEGER);
    expect(Number.isFinite(depth)).toBe(true);
  });

  it('gates on the required depth, inclusively', () => {
    expect(isConfirmed(100n, 102n, 3)).toBe(false);
    expect(isConfirmed(100n, 103n, 3)).toBe(true);
    expect(isConfirmed(100n, 104n, 3)).toBe(true);
  });

  it('treats zero required confirmations as always confirmed', () => {
    expect(isConfirmed(100n, 100n, 0)).toBe(true);
    expect(isConfirmed(100n, 99n, 0)).toBe(true);
  });

  it('rejects a negative confirmation requirement', () => {
    expect(() => isConfirmed(1n, 2n, -1)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

describe('parseRpcConfig', () => {
  const base = { LP_RPC_URL: 'https://rpc.example/abc', LP_RPC_WS_URL: 'wss://rpc.example/abc' };

  it('applies documented defaults', () => {
    const config = parseRpcConfig(base);
    expect(config.httpUrl).toBe(base.LP_RPC_URL);
    expect(config.wsUrl).toBe(base.LP_RPC_WS_URL);
    expect(config.preferredMode).toBe(RPC_CONFIG_DEFAULTS.preferredMode);
    expect(config.confirmations).toBe(RPC_CONFIG_DEFAULTS.confirmations);
    expect(config.stalenessMs).toBe(RPC_CONFIG_DEFAULTS.stalenessMs);
    expect(config.pollIntervalMs).toBe(RPC_CONFIG_DEFAULTS.pollIntervalMs);
  });

  it('requires an HTTP endpoint even when a socket is configured', () => {
    expect(() => parseRpcConfig({ LP_RPC_WS_URL: base.LP_RPC_WS_URL })).toThrow(RpcConfigError);
    expect(() => parseRpcConfig({})).toThrow(RpcConfigError);
    expect(() => parseRpcConfig({ LP_RPC_URL: '   ' })).toThrow(RpcConfigError);
  });

  it('treats a missing socket URL as polling-only rather than an error', () => {
    const config = parseRpcConfig({ LP_RPC_URL: base.LP_RPC_URL });
    expect(config.wsUrl).toBeNull();
  });

  it('validates URL schemes', () => {
    expect(() => parseRpcConfig({ LP_RPC_URL: 'wss://rpc.example' })).toThrow(RpcConfigError);
    expect(() => parseRpcConfig({ ...base, LP_RPC_WS_URL: 'https://rpc.example' })).toThrow(
      RpcConfigError,
    );
    expect(() => parseRpcConfig({ LP_RPC_URL: 'not-a-url' })).toThrow(RpcConfigError);
  });

  it('rejects an unknown mode and a websocket mode with no socket URL', () => {
    expect(() => parseRpcConfig({ ...base, LP_RPC_MODE: 'turbo' })).toThrow(RpcConfigError);
    expect(() =>
      parseRpcConfig({ LP_RPC_URL: base.LP_RPC_URL, LP_RPC_MODE: 'websocket' }),
    ).toThrow(RpcConfigError);
    expect(parseRpcConfig({ ...base, LP_RPC_MODE: 'WebSocket' }).preferredMode).toBe('websocket');
    expect(parseRpcConfig({ LP_RPC_URL: base.LP_RPC_URL, LP_RPC_MODE: 'polling' }).preferredMode).toBe(
      'polling',
    );
  });

  it('parses numeric overrides and rejects out-of-range ones', () => {
    const config = parseRpcConfig({
      ...base,
      LP_RPC_CONFIRMATIONS: '0',
      LP_RPC_STALENESS_MS: '2500',
      LP_RPC_POLL_INTERVAL_MS: '250',
      LP_RPC_MAX_WS_ATTEMPTS: '3',
    });
    expect(config.confirmations).toBe(0);
    expect(config.stalenessMs).toBe(2_500);
    expect(config.pollIntervalMs).toBe(250);
    expect(config.maxWebsocketAttempts).toBe(3);

    expect(() => parseRpcConfig({ ...base, LP_RPC_CONFIRMATIONS: '-1' })).toThrow(RpcConfigError);
    // Below one block time the detector would flap permanently.
    expect(() => parseRpcConfig({ ...base, LP_RPC_STALENESS_MS: '10' })).toThrow(RpcConfigError);
    expect(() => parseRpcConfig({ ...base, LP_RPC_POLL_INTERVAL_MS: 'fast' })).toThrow(
      RpcConfigError,
    );
    expect(() => parseRpcConfig({ ...base, LP_RPC_MAX_WS_ATTEMPTS: '0' })).toThrow(RpcConfigError);
  });
});

// ---------------------------------------------------------------------------
// chain definition
// ---------------------------------------------------------------------------

describe('defineRobinhoodChain', () => {
  it('uses the shared chain id and the caller-supplied endpoints', () => {
    const chain = defineRobinhoodChain({
      httpUrl: 'https://rpc.example/key',
      wsUrl: 'wss://rpc.example/key',
    });
    expect(chain.id).toBe(ROBINHOOD_CHAIN_ID);
    expect(chain.id).toBe(4663);
    expect(chain.rpcUrls.default.http).toEqual(['https://rpc.example/key']);
    expect(chain.rpcUrls.default.webSocket).toEqual(['wss://rpc.example/key']);
  });

  it('omits the socket entry when none is configured', () => {
    const chain = defineRobinhoodChain({ httpUrl: 'https://rpc.example/key' });
    expect(chain.rpcUrls.default.webSocket).toBeUndefined();
  });

  it('refuses to build a chain with no endpoint rather than defaulting to a public one', () => {
    expect(() => defineRobinhoodChain({ httpUrl: '' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// watcher surface (constructed only — start() is never called, so no network)
// ---------------------------------------------------------------------------

describe('PoolWatcher (offline surface)', () => {
  const config = parseRpcConfig({
    LP_RPC_URL: 'https://rpc.example/key',
    LP_RPC_WS_URL: 'wss://rpc.example/key',
  });

  const range = (tokenId: string, pool: string) => ({
    tokenId,
    pool: pool as Address,
    tickLower: -1_000,
    tickUpper: 1_000,
  });

  it('starts stopped, not low-latency, and normalizes pool addresses', () => {
    const watcher = new PoolWatcher({
      config,
      ranges: [range('1', '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')],
    });
    const status = watcher.getStatus();
    expect(status.health).toBe('stopped');
    expect(status.lowLatency).toBe(false);
    expect(status.watchedRanges).toBe(1);
    expect(status.watchedPools).toEqual(['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
    expect(watcher.isLowLatency()).toBe(false);
  });

  it('deduplicates pools shared by several positions', () => {
    const pool = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const watcher = new PoolWatcher({ config, ranges: [range('1', pool), range('2', pool)] });
    expect(watcher.getStatus().watchedPools).toHaveLength(1);
    expect(watcher.getStatus().watchedRanges).toBe(2);

    watcher.unwatch('1');
    expect(watcher.getStatus().watchedRanges).toBe(1);
    watcher.unwatch('1'); // idempotent
    expect(watcher.getStatus().watchedRanges).toBe(1);
  });

  it('replaces the whole watch set with setWatched', () => {
    const watcher = new PoolWatcher({
      config,
      ranges: [range('1', '0x1111111111111111111111111111111111111111')],
    });
    watcher.setWatched([range('2', '0x2222222222222222222222222222222222222222')]);
    const status = watcher.getStatus();
    expect(status.watchedRanges).toBe(1);
    expect(status.watchedPools).toEqual(['0x2222222222222222222222222222222222222222']);
  });

  it('rejects a malformed range at registration, not at the first observation', () => {
    expect(
      () =>
        new PoolWatcher({
          config,
          ranges: [
            {
              tokenId: '1',
              pool: '0x1111111111111111111111111111111111111111' as Address,
              tickLower: 1_000,
              tickUpper: -1_000,
            },
          ],
        }),
    ).toThrow(TickRangeError);
  });

  it('reports polling mode when no socket URL is configured', () => {
    const pollOnly = parseRpcConfig({ LP_RPC_URL: 'https://rpc.example/key' });
    const watcher = new PoolWatcher({ config: pollOnly });
    // Mode is only decided at start(); the honest pre-start default is the
    // conservative one, and lowLatency is false either way.
    expect(watcher.getMode()).toBe('polling');
    expect(watcher.isLowLatency()).toBe(false);
  });

  it('stop() is safe before start()', () => {
    const watcher = new PoolWatcher({ config });
    expect(() => watcher.stop()).not.toThrow();
    expect(watcher.getStatus().health).toBe('stopped');
  });
});
