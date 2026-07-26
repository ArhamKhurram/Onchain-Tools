import { describe, it, expect } from 'vitest';
import {
  computeEfficiency,
  PROHIBITIVE_COST_DRAG,
  shouldCompound,
  shouldRebalance,
  tickToPrice,
  computeRangeExitPercent,
  evaluateSwitch,
  DEFAULT_MAX_OBSERVATION_GAP_MINUTES,
} from '../src/rules/index.js';
import type { CrossoverState, ScoredPool } from '../src/rules/index.js';
import { DEFAULT_POLICY } from '../src/policy/index.js';
import type {
  Address,
  AutomationPolicy,
  EfficiencyInputs,
  EfficiencyScore,
  LpPosition,
  PoolCandidate,
} from '../src/types.js';

// --- fixtures ---------------------------------------------------------------

const POOL_A = '0x1111111111111111111111111111111111111111' as Address;
const POOL_B = '0x2222222222222222222222222222222222222222' as Address;
const POOL_C = '0x3333333333333333333333333333333333333333' as Address;

const T0 = 1_700_000_000_000; // fixed epoch; every test is deterministic
const MIN = 60_000;
const HOUR = 3_600_000;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function makePolicy(overrides: Partial<AutomationPolicy> = {}): AutomationPolicy {
  return { ...clone(DEFAULT_POLICY), allowedPools: [POOL_A, POOL_B], ...overrides };
}

function makePool(address: Address): PoolCandidate {
  return {
    address,
    chainId: 4663,
    platform: 'uniswapv3',
    feeTierBps: 3000,
    token0: { address: POOL_C, symbol: 'AAA', decimals: 18 },
    token1: { address: POOL_C, symbol: 'BBB', decimals: 6 },
    tvlUsd: 1_000_000,
    volume24hUsd: 400_000,
    feeApr: 0.4,
  };
}

function makePosition(overrides: Partial<LpPosition> = {}): LpPosition {
  return {
    tokenId: '42',
    pool: makePool(POOL_A),
    status: 'in_range',
    tickLower: -1000,
    tickUpper: 1000,
    currentTick: 0,
    valueUsd: 1000,
    unclaimedFeesUsd: 0,
    openedAt: T0,
    lastCompoundedAt: null,
    ...overrides,
  };
}

function makeInputs(overrides: Partial<EfficiencyInputs> = {}): EfficiencyInputs {
  return {
    feeApr: 0.42,
    estimatedIlApr: 0.1,
    gasCostUsd: 10,
    slippageCostUsd: 0,
    positionValueUsd: 1000,
    expectedHoldingPeriodDays: 30,
    ...overrides,
  };
}

/** A score with an exact net efficiency, for driving the switching buffer. */
function scored(poolAddress: Address, netEfficiency: number): ScoredPool {
  const efficiency: EfficiencyScore = {
    netEfficiency,
    costDrag: 0,
    inputs: makeInputs(),
  };
  return { poolAddress, efficiency };
}

// ===========================================================================
// computeEfficiency
// ===========================================================================

describe('computeEfficiency', () => {
  it('matches a hand-computed case: $10 cost, $1k position, 30-day hold', () => {
    // costDrag = (10 / 1000) * (365 / 30) = 0.01 * 12.16666... = 0.1216666...
    // net      = 0.42 - 0.10 - 0.1216666... = 0.1983333...
    const score = computeEfficiency(makeInputs());
    expect(score.costDrag).toBeCloseTo(0.12166666666, 10);
    expect(score.netEfficiency).toBeCloseTo(0.19833333333, 10);
  });

  it('annualizes exactly when the holding period is one year', () => {
    // (5 + 5) / 1000 * (365 / 365) = 0.01 exactly.
    const score = computeEfficiency(
      makeInputs({
        feeApr: 0.2,
        estimatedIlApr: 0.05,
        gasCostUsd: 5,
        slippageCostUsd: 5,
        expectedHoldingPeriodDays: 365,
      }),
    );
    expect(score.costDrag).toBe(0.01);
    expect(score.netEfficiency).toBeCloseTo(0.14, 12);
  });

  it('lets cost drag dominate over a very short holding period', () => {
    // The same $10 over 1 day is a 365% annualized drag.
    const score = computeEfficiency(makeInputs({ expectedHoldingPeriodDays: 1 }));
    expect(score.costDrag).toBeCloseTo(3.65, 12);
    expect(score.netEfficiency).toBeCloseTo(0.42 - 0.1 - 3.65, 12);
    expect(score.netEfficiency).toBeLessThan(0);
  });

  it('is normalized against position value, not absolute cost', () => {
    // Same $10 cost on a 10x larger position must be a 10x smaller drag.
    const small = computeEfficiency(makeInputs({ positionValueUsd: 1_000 }));
    const large = computeEfficiency(makeInputs({ positionValueUsd: 10_000 }));
    expect(large.costDrag).toBeCloseTo(small.costDrag / 10, 12);
    expect(large.netEfficiency).toBeGreaterThan(small.netEfficiency);
  });

  it('returns a negative net efficiency when IL swamps fees', () => {
    const score = computeEfficiency(
      makeInputs({ feeApr: 0.05, estimatedIlApr: 0.4, gasCostUsd: 0, slippageCostUsd: 0 }),
    );
    expect(score.costDrag).toBe(0);
    expect(score.netEfficiency).toBeCloseTo(-0.35, 12);
  });

  it('treats a zero holding period as prohibitive, not as division by zero', () => {
    const score = computeEfficiency(makeInputs({ expectedHoldingPeriodDays: 0 }));
    expect(score.costDrag).toBe(PROHIBITIVE_COST_DRAG);
    expect(score.netEfficiency).toBe(-PROHIBITIVE_COST_DRAG);
    expect(Number.isFinite(score.netEfficiency)).toBe(true);
  });

  it('treats a negative holding period as prohibitive', () => {
    expect(computeEfficiency(makeInputs({ expectedHoldingPeriodDays: -5 })).costDrag).toBe(
      PROHIBITIVE_COST_DRAG,
    );
  });

  it('treats a zero position value as prohibitive even when costs are zero', () => {
    const score = computeEfficiency(
      makeInputs({ positionValueUsd: 0, gasCostUsd: 0, slippageCostUsd: 0 }),
    );
    expect(score.costDrag).toBe(PROHIBITIVE_COST_DRAG);
  });

  it('treats a negative position value as prohibitive', () => {
    expect(computeEfficiency(makeInputs({ positionValueUsd: -1000 })).costDrag).toBe(
      PROHIBITIVE_COST_DRAG,
    );
  });

  it('rejects negative costs rather than letting them inflate the score', () => {
    // A negative gas cost is the one bad input that could talk us INTO a trade.
    expect(computeEfficiency(makeInputs({ gasCostUsd: -100 })).costDrag).toBe(
      PROHIBITIVE_COST_DRAG,
    );
    expect(computeEfficiency(makeInputs({ slippageCostUsd: -100 })).costDrag).toBe(
      PROHIBITIVE_COST_DRAG,
    );
  });

  it.each([
    ['feeApr', { feeApr: NaN }],
    ['estimatedIlApr', { estimatedIlApr: NaN }],
    ['gasCostUsd', { gasCostUsd: NaN }],
    ['slippageCostUsd', { slippageCostUsd: Infinity }],
    ['positionValueUsd', { positionValueUsd: NaN }],
    ['expectedHoldingPeriodDays', { expectedHoldingPeriodDays: NaN }],
  ])('poisons the whole score when %s is not finite', (_field, override) => {
    const score = computeEfficiency(makeInputs(override as Partial<EfficiencyInputs>));
    expect(score.netEfficiency).toBe(-PROHIBITIVE_COST_DRAG);
    expect(Number.isNaN(score.netEfficiency)).toBe(false);
  });

  it('always survives JSON serialization (the audit log depends on it)', () => {
    const degenerate = computeEfficiency(makeInputs({ positionValueUsd: 0 }));
    const round = JSON.parse(JSON.stringify(degenerate)) as EfficiencyScore;
    expect(round.netEfficiency).toBe(degenerate.netEfficiency);
    expect(round.netEfficiency).not.toBeNull();
  });

  it('echoes the full input set back for the audit log', () => {
    const inputs = makeInputs();
    expect(computeEfficiency(inputs).inputs).toEqual(inputs);
  });
});

// ===========================================================================
// tickToPrice / computeRangeExitPercent
// ===========================================================================

describe('tickToPrice', () => {
  it('anchors at 1 for tick 0 and 1.0001 for tick 1', () => {
    expect(tickToPrice(0)).toBe(1);
    expect(tickToPrice(1)).toBe(1.0001);
  });

  it('is logarithmic, not linear — 10,000 ticks is +171.8%, not +100%', () => {
    // 1.0001^10000 = 2.7181459268249255 (hand-checked). A linear reading would
    // say "10000 ticks x 0.01% = 100%", which is wrong by 71.8 points.
    expect(tickToPrice(10_000)).toBeCloseTo(2.7181459268, 9);
    expect(tickToPrice(100)).toBeCloseTo(1.0100496620928754, 12);
    expect(tickToPrice(-1)).toBeCloseTo(0.9999000099990001, 12);
  });

  it('composes multiplicatively', () => {
    const a = tickToPrice(500)!;
    const b = tickToPrice(300)!;
    expect(tickToPrice(800)!).toBeCloseTo(a * b, 9);
  });

  it('returns null for unusable ticks', () => {
    expect(tickToPrice(NaN)).toBeNull();
    expect(tickToPrice(Infinity)).toBeNull();
    expect(tickToPrice(1e9)).toBeNull(); // overflows to Infinity
  });
});

describe('computeRangeExitPercent', () => {
  it('is zero anywhere inside the range, including on the bounds', () => {
    expect(computeRangeExitPercent(-1000, 1000, 0)).toBe(0);
    expect(computeRangeExitPercent(-1000, 1000, 999)).toBe(0);
    expect(computeRangeExitPercent(-1000, 1000, 1000)).toBe(0);
    expect(computeRangeExitPercent(-1000, 1000, -1000)).toBe(0);
  });

  it('matches hand-computed values above the range', () => {
    // 100 ticks above the upper bound: (1.0001^100 - 1) * 100 = 1.0049662092875389%
    expect(computeRangeExitPercent(-1000, 0, 100)).toBeCloseTo(1.0049662092875389, 12);
    // 1000 ticks above: (1.0001^1000 - 1) * 100 = 10.516539260322055%
    expect(computeRangeExitPercent(-5000, 0, 1000)).toBeCloseTo(10.516539260322055, 10);
  });

  it('matches hand-computed values below the range, which are NOT symmetric', () => {
    // 100 ticks below: (1 - 1.0001^-100) * 100 = 0.9949671258789428%
    // Note it is smaller than the 1.00497% for 100 ticks above — a direct
    // consequence of ticks being logarithmic. A linear model would give the
    // same number both ways.
    expect(computeRangeExitPercent(0, 1000, -100)).toBeCloseTo(0.9949671258789428, 12);
  });

  it('depends only on the distance past the breached bound', () => {
    const a = computeRangeExitPercent(-1000, 0, 100)!;
    const b = computeRangeExitPercent(-1000, 5000, 5100)!;
    expect(b).toBeCloseTo(a, 10);
  });

  it('returns null for a malformed range', () => {
    expect(computeRangeExitPercent(1000, 1000, 0)).toBeNull(); // zero-width
    expect(computeRangeExitPercent(1000, -1000, 0)).toBeNull(); // inverted
    expect(computeRangeExitPercent(NaN, 1000, 0)).toBeNull();
    expect(computeRangeExitPercent(-1000, 1000, NaN)).toBeNull();
  });
});

// ===========================================================================
// shouldCompound
// ===========================================================================

describe('shouldCompound', () => {
  const policy = makePolicy({
    compoundTrigger: { minFeesVsGasRatio: 3, maxIntervalHours: 24 },
  });

  it('fires exactly AT the fees-vs-gas ratio boundary', () => {
    // 30 / 10 = 3.0, the threshold. `>=` so this fires.
    const decision = shouldCompound(makePosition({ unclaimedFeesUsd: 30 }), policy, 10, T0 + HOUR);
    expect(decision.action).toBe('compound');
    expect(decision.rule).toBe('compound.fees_vs_gas');
  });

  it('does not fire just under the ratio', () => {
    const decision = shouldCompound(
      makePosition({ unclaimedFeesUsd: 29.999 }),
      policy,
      10,
      T0 + HOUR,
    );
    expect(decision.action).toBe('none');
    expect(decision.rule).toBe('compound.hold');
  });

  it('fires just over the ratio', () => {
    const decision = shouldCompound(
      makePosition({ unclaimedFeesUsd: 30.001 }),
      policy,
      10,
      T0 + HOUR,
    );
    expect(decision.action).toBe('compound');
  });

  it('fires on the interval backstop when the ratio is nowhere near met', () => {
    // 1 / 10 = 0.1x gas — far below 3x — but 24h have elapsed.
    const decision = shouldCompound(
      makePosition({ unclaimedFeesUsd: 1 }),
      policy,
      10,
      T0 + 24 * HOUR,
    );
    expect(decision.action).toBe('compound');
    expect(decision.rule).toBe('compound.max_interval');
  });

  it('does not fire one millisecond before the interval elapses', () => {
    const decision = shouldCompound(
      makePosition({ unclaimedFeesUsd: 1 }),
      policy,
      10,
      T0 + 24 * HOUR - 1,
    );
    expect(decision.action).toBe('none');
  });

  it('reports the ratio rule, not the interval rule, when both hold', () => {
    const decision = shouldCompound(
      makePosition({ unclaimedFeesUsd: 100 }),
      policy,
      10,
      T0 + 48 * HOUR,
    );
    expect(decision.rule).toBe('compound.fees_vs_gas');
  });

  it('fires on the ratio while the interval is nowhere near elapsed', () => {
    const decision = shouldCompound(makePosition({ unclaimedFeesUsd: 100 }), policy, 10, T0 + 1000);
    expect(decision.action).toBe('compound');
    expect(decision.rule).toBe('compound.fees_vs_gas');
  });

  it('measures the interval from openedAt when never compounded', () => {
    const never = makePosition({ unclaimedFeesUsd: 1, lastCompoundedAt: null, openedAt: T0 });
    expect(shouldCompound(never, policy, 10, T0 + 24 * HOUR).action).toBe('compound');
    expect(shouldCompound(never, policy, 10, T0 + 23 * HOUR).action).toBe('none');
  });

  it('measures the interval from lastCompoundedAt once it is set', () => {
    // Opened long ago, but compounded an hour ago: the backstop must not fire.
    const position = makePosition({
      unclaimedFeesUsd: 1,
      openedAt: T0 - 100 * HOUR,
      lastCompoundedAt: T0 - HOUR,
    });
    expect(shouldCompound(position, policy, 10, T0).action).toBe('none');
    expect(shouldCompound(position, policy, 10, T0 + 23 * HOUR).action).toBe('compound');
  });

  it('never compounds zero fees, even after the backstop interval', () => {
    // Compounding nothing is pure gas burn; the backstop must not schedule it.
    const decision = shouldCompound(
      makePosition({ unclaimedFeesUsd: 0 }),
      policy,
      10,
      T0 + 100 * HOUR,
    );
    expect(decision.action).toBe('none');
    expect(decision.rule).toBe('compound.no_fees');
  });

  it('does not treat a zero or unknown gas cost as "free, therefore compound"', () => {
    const position = makePosition({ unclaimedFeesUsd: 500 });
    for (const gas of [0, -1, NaN]) {
      const decision = shouldCompound(position, policy, gas, T0 + HOUR);
      expect(decision.action).toBe('none');
      expect(decision.snapshot.feesVsGasRatio).toBeNull();
    }
  });

  it('still allows the interval backstop when gas is unknown', () => {
    const decision = shouldCompound(
      makePosition({ unclaimedFeesUsd: 500 }),
      policy,
      NaN,
      T0 + 25 * HOUR,
    );
    expect(decision.action).toBe('compound');
    expect(decision.rule).toBe('compound.max_interval');
  });

  it('never compounds a closed position', () => {
    const decision = shouldCompound(
      makePosition({ status: 'closed', unclaimedFeesUsd: 1000 }),
      policy,
      1,
      T0 + 100 * HOUR,
    );
    expect(decision.action).toBe('none');
    expect(decision.rule).toBe('compound.position_closed');
  });

  it('does not fire on a backwards clock', () => {
    const decision = shouldCompound(makePosition({ unclaimedFeesUsd: 1 }), policy, 10, T0 - HOUR);
    expect(decision.action).toBe('none');
  });

  it('records a full snapshot even when nothing fires', () => {
    const decision = shouldCompound(makePosition({ unclaimedFeesUsd: 1 }), policy, 10, T0 + HOUR);
    expect(decision.action).toBe('none');
    expect(decision.snapshot).toMatchObject({
      tokenId: '42',
      unclaimedFeesUsd: 1,
      gasCostUsd: 10,
      minFeesVsGasRatio: 3,
      maxIntervalHours: 24,
      now: T0 + HOUR,
    });
    expect(decision.snapshot.elapsedHours).toBeCloseTo(1, 12);
    expect(decision.reason.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// shouldRebalance
// ===========================================================================

describe('shouldRebalance', () => {
  const policy = makePolicy({ rebalanceTrigger: { rangeExitPercent: 5 } });

  it('holds while the price is inside the range', () => {
    const decision = shouldRebalance(makePosition({ currentTick: 0 }), policy);
    expect(decision.action).toBe('none');
    expect(decision.rule).toBe('rebalance.in_range');
  });

  it('holds when just barely outside the range', () => {
    // 100 ticks past the upper bound is only ~1.005% — well within a 5% tolerance.
    const decision = shouldRebalance(
      makePosition({ tickLower: -1000, tickUpper: 1000, currentTick: 1100 }),
      policy,
    );
    expect(decision.action).toBe('none');
    expect(decision.rule).toBe('rebalance.within_tolerance');
    expect(decision.snapshot.rangeExitPercent).toBeCloseTo(1.0049662092875389, 10);
  });

  it('fires when far outside the range', () => {
    // 1000 ticks past the upper bound = 10.5165%, beyond 5%.
    const decision = shouldRebalance(
      makePosition({ tickLower: -1000, tickUpper: 1000, currentTick: 2000 }),
      policy,
    );
    expect(decision.action).toBe('rebalance');
    expect(decision.rule).toBe('rebalance.range_exit');
    expect(decision.snapshot.rangeExitPercent).toBeCloseTo(10.516539260322055, 10);
  });

  it('fires below the range too', () => {
    const decision = shouldRebalance(
      makePosition({ tickLower: -1000, tickUpper: 1000, currentTick: -2000 }),
      policy,
    );
    expect(decision.action).toBe('rebalance');
    // (1 - 1.0001^-1000) * 100 = 9.51580580672211 — again smaller than the
    // 10.5165% for the same 1000 ticks above.
    expect(decision.snapshot.rangeExitPercent).toBeCloseTo(9.51580580672211, 10);
  });

  it('does not fire exactly AT the threshold, only strictly beyond it', () => {
    // tickUpper 0 makes priceUpper exactly 1, so the computed exit percent is
    // bit-for-bit the constant below and the boundary can be probed exactly.
    const exact = 1.0049662092875389;
    const position = makePosition({ tickLower: -1000, tickUpper: 0, currentTick: 100 });

    const atThreshold = shouldRebalance(
      position,
      makePolicy({ rebalanceTrigger: { rangeExitPercent: exact } }),
    );
    expect(atThreshold.action).toBe('none');
    expect(atThreshold.rule).toBe('rebalance.within_tolerance');

    const justBelowThreshold = shouldRebalance(
      position,
      makePolicy({ rebalanceTrigger: { rangeExitPercent: exact - 1e-12 } }),
    );
    expect(justBelowThreshold.action).toBe('rebalance');
  });

  it('refuses to act on a malformed tick range', () => {
    for (const ticks of [
      { tickLower: 1000, tickUpper: 1000 },
      { tickLower: 1000, tickUpper: -1000 },
      { tickLower: NaN, tickUpper: 1000 },
    ]) {
      const decision = shouldRebalance(makePosition({ ...ticks, currentTick: 99_999 }), policy);
      expect(decision.action).toBe('none');
      expect(decision.rule).toBe('rebalance.invalid_range');
    }
  });

  it('never rebalances a closed position', () => {
    const decision = shouldRebalance(
      makePosition({ status: 'closed', currentTick: 100_000 }),
      policy,
    );
    expect(decision.action).toBe('none');
    expect(decision.rule).toBe('rebalance.position_closed');
  });

  it('refuses when the policy threshold itself is unusable', () => {
    for (const rangeExitPercent of [0, -5, NaN]) {
      const decision = shouldRebalance(
        makePosition({ currentTick: 100_000 }),
        makePolicy({ rebalanceTrigger: { rangeExitPercent } }),
      );
      expect(decision.action).toBe('none');
      expect(decision.rule).toBe('rebalance.invalid_policy');
    }
  });

  it('records prices and ticks in the snapshot on every tick', () => {
    const decision = shouldRebalance(makePosition({ currentTick: 0 }), policy);
    expect(decision.snapshot).toMatchObject({
      tickLower: -1000,
      tickUpper: 1000,
      currentTick: 0,
      priceCurrent: 1,
      thresholdPercent: 5,
    });
  });
});

// ===========================================================================
// evaluateSwitch — the switching buffer
// ===========================================================================

describe('evaluateSwitch', () => {
  const policy = makePolicy({
    switchingBuffer: { minEfficiencyDeltaPercent: 5, sustainedDurationMinutes: 60 },
  });

  const current = scored(POOL_A, 0.1);
  const better = scored(POOL_B, 0.2); // +10 percentage points
  const notBetter = scored(POOL_B, 0.1); // 0 pp

  it('ACCEPTANCE CRITERION: a transient one-tick advantage does NOT trigger a move', () => {
    // Tick 1 — candidate momentarily looks better. Streak opens, nothing moves.
    const t1 = evaluateSwitch(current, better, policy, null, T0);
    expect(t1.decision.action).toBe('none');
    expect(t1.decision.rule).toBe('switch.streak_started');
    expect(t1.state).toEqual({ candidatePool: POOL_B, since: T0, lastSeen: T0 });

    // Tick 2, one minute later — the advantage is gone. Streak is destroyed,
    // not paused.
    const t2 = evaluateSwitch(current, notBetter, policy, t1.state, T0 + 1 * MIN);
    expect(t2.decision.action).toBe('none');
    expect(t2.decision.rule).toBe('switch.below_threshold');
    expect(t2.state).toBeNull();

    // Tick 3, well past the point where the ORIGINAL window would have closed.
    // Because the streak was destroyed, this is a brand new window — not a move.
    const t3 = evaluateSwitch(current, better, policy, t2.state, T0 + 61 * MIN);
    expect(t3.decision.action).toBe('none');
    expect(t3.decision.rule).toBe('switch.streak_started');
    expect(t3.state?.since).toBe(T0 + 61 * MIN);
  });

  it('DOES move once the advantage is sustained for the full window', () => {
    let state: CrossoverState | null = null;
    const fired: number[] = [];

    // Tick every 5 minutes (inside the default observation-gap limit).
    for (let m = 0; m <= 60; m += 5) {
      const result = evaluateSwitch(current, better, policy, state, T0 + m * MIN);
      state = result.state;
      if (result.decision.action !== 'none') fired.push(m);
    }

    expect(fired).toEqual([60]);
  });

  it('fires with action "exit" and a machine-readable rule id', () => {
    const opened: CrossoverState = { candidatePool: POOL_B, since: T0, lastSeen: T0 + 55 * MIN };
    const result = evaluateSwitch(current, better, policy, opened, T0 + 60 * MIN);
    expect(result.decision.action).toBe('exit');
    expect(result.decision.rule).toBe('switch.sustained_advantage');
    expect(result.decision.snapshot.sustainedMinutes).toBe(60);
  });

  it('fires exactly AT the sustained-duration boundary but not a millisecond before', () => {
    const opened: CrossoverState = { candidatePool: POOL_B, since: T0, lastSeen: T0 + 55 * MIN };
    expect(evaluateSwitch(current, better, policy, opened, T0 + 60 * MIN).decision.action).toBe(
      'exit',
    );
    expect(evaluateSwitch(current, better, policy, opened, T0 + 60 * MIN - 1).decision.action).toBe(
      'none',
    );
  });

  it('resets the timer when the delta lapses mid-window rather than accumulating', () => {
    let state: CrossoverState | null = null;

    // 0-30min: advantage holds.
    for (let m = 0; m <= 30; m += 5) {
      state = evaluateSwitch(current, better, policy, state, T0 + m * MIN).state;
    }
    expect(state?.since).toBe(T0);

    // 35min: advantage lapses for a single tick.
    const lapse = evaluateSwitch(current, notBetter, policy, state, T0 + 35 * MIN);
    expect(lapse.state).toBeNull();
    state = lapse.state;

    // 40min onwards: advantage returns. The window restarts at 40min, so at
    // 60min (when the naive accumulator would have fired) nothing happens.
    for (let m = 40; m <= 60; m += 5) {
      const result = evaluateSwitch(current, better, policy, state, T0 + m * MIN);
      expect(result.decision.action).toBe('none');
      state = result.state;
    }
    expect(state?.since).toBe(T0 + 40 * MIN);

    // It only fires a full 60 minutes after the RESTART, at 100min.
    for (let m = 65; m < 100; m += 5) {
      const result = evaluateSwitch(current, better, policy, state, T0 + m * MIN);
      expect(result.decision.action).toBe('none');
      state = result.state;
    }
    expect(evaluateSwitch(current, better, policy, state, T0 + 100 * MIN).decision.action).toBe(
      'exit',
    );
  });

  it('does not fire when the delta only equals the threshold', () => {
    // 0.15 - 0.10 = 0.05 = exactly 5 percentage points. `>` so it does not count.
    const equal = scored(POOL_B, 0.15);
    const opened: CrossoverState = { candidatePool: POOL_B, since: T0, lastSeen: T0 + 55 * MIN };
    const result = evaluateSwitch(current, equal, policy, opened, T0 + 60 * MIN);
    expect(result.decision.action).toBe('none');
    expect(result.decision.rule).toBe('switch.below_threshold');
    expect(result.state).toBeNull();
  });

  it('measures the delta in percentage points of annualized efficiency', () => {
    const opened: CrossoverState = { candidatePool: POOL_B, since: T0, lastSeen: T0 + 55 * MIN };
    // +6pp clears the 5pp bar...
    expect(
      evaluateSwitch(current, scored(POOL_B, 0.16), policy, opened, T0 + 60 * MIN).decision.action,
    ).toBe('exit');
    // ...+4pp does not, even though it is a 40% *relative* improvement.
    expect(
      evaluateSwitch(current, scored(POOL_B, 0.14), policy, opened, T0 + 60 * MIN).decision.action,
    ).toBe('none');
  });

  it('works when both efficiencies are negative', () => {
    // -0.30 -> -0.20 is a +10pp improvement. A relative comparison would flip
    // sign here; the absolute one does not.
    const losing = scored(POOL_A, -0.3);
    const lessLosing = scored(POOL_B, -0.2);
    const opened: CrossoverState = { candidatePool: POOL_B, since: T0, lastSeen: T0 + 55 * MIN };
    expect(evaluateSwitch(losing, lessLosing, policy, opened, T0 + 60 * MIN).decision.action).toBe(
      'exit',
    );
  });

  it('starts a fresh streak when the candidate changes', () => {
    const forB: CrossoverState = { candidatePool: POOL_B, since: T0, lastSeen: T0 + 55 * MIN };
    // POOL_C is on the allowlist for this policy so the allowlist gate is not
    // what is being tested here.
    const allowsC = makePolicy({
      allowedPools: [POOL_A, POOL_B, POOL_C],
      switchingBuffer: { minEfficiencyDeltaPercent: 5, sustainedDurationMinutes: 60 },
    });
    const result = evaluateSwitch(current, scored(POOL_C, 0.2), allowsC, forB, T0 + 60 * MIN);
    expect(result.decision.action).toBe('none');
    expect(result.decision.rule).toBe('switch.streak_started');
    expect(result.state).toEqual({
      candidatePool: POOL_C,
      since: T0 + 60 * MIN,
      lastSeen: T0 + 60 * MIN,
    });
  });

  it('restarts the window after an unobserved gap in the tick series', () => {
    // A ready-to-fire streak whose last observation is stale: we cannot claim
    // the advantage held continuously through minutes we never looked at.
    const stale: CrossoverState = {
      candidatePool: POOL_B,
      since: T0,
      lastSeen: T0 + (60 - DEFAULT_MAX_OBSERVATION_GAP_MINUTES - 1) * MIN,
    };
    const result = evaluateSwitch(current, better, policy, stale, T0 + 60 * MIN);
    expect(result.decision.action).toBe('none');
    expect(result.decision.rule).toBe('switch.observation_gap');
    expect(result.state?.since).toBe(T0 + 60 * MIN);
  });

  it('honours a caller-supplied observation-gap limit', () => {
    const stale: CrossoverState = { candidatePool: POOL_B, since: T0, lastSeen: T0 + 20 * MIN };
    // Default 10min limit -> gap of 40min restarts the window.
    expect(
      evaluateSwitch(current, better, policy, stale, T0 + 60 * MIN).decision.rule,
    ).toBe('switch.observation_gap');
    // A caller that genuinely ticks hourly can widen it.
    expect(
      evaluateSwitch(current, better, policy, stale, T0 + 60 * MIN, {
        maxObservationGapMinutes: 90,
      }).decision.action,
    ).toBe('exit');
  });

  it('restarts the window when the clock goes backwards', () => {
    const state: CrossoverState = { candidatePool: POOL_B, since: T0, lastSeen: T0 + 90 * MIN };
    const result = evaluateSwitch(current, better, policy, state, T0 + 60 * MIN);
    expect(result.decision.action).toBe('none');
    expect(result.decision.rule).toBe('switch.observation_gap');
  });

  it('NEVER switches into a pool that is not on the allowlist', () => {
    // Every other condition is satisfied: huge delta, fully sustained streak.
    // Absence from the allowlist alone must block the move.
    const restrictive = makePolicy({
      allowedPools: [POOL_A],
      switchingBuffer: { minEfficiencyDeltaPercent: 5, sustainedDurationMinutes: 60 },
    });
    const ready: CrossoverState = { candidatePool: POOL_B, since: T0, lastSeen: T0 + 55 * MIN };
    const result = evaluateSwitch(current, scored(POOL_B, 99), restrictive, ready, T0 + 60 * MIN);
    expect(result.decision.action).toBe('none');
    expect(result.decision.rule).toBe('switch.pool_not_allowed');
    expect(result.state).toBeNull();
  });

  it('never switches into the pool already held', () => {
    const result = evaluateSwitch(current, scored(POOL_A, 99), policy, null, T0);
    expect(result.decision.action).toBe('none');
    expect(result.decision.rule).toBe('switch.same_pool');
  });

  it('is case-insensitive about pool identity', () => {
    // Same pool, one side EIP-55 checksummed as the dashboard might supply it.
    const checksummed = scored('0xAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAb' as Address, 0.1);
    const lowercase = scored('0xabababababababababababababababababababab' as Address, 99);
    const result = evaluateSwitch(checksummed, lowercase, policy, null, T0);
    expect(result.decision.rule).toBe('switch.same_pool');
  });

  it('matches an allowlist entry regardless of address casing', () => {
    const checksummedAllowlist = makePolicy({
      allowedPools: [POOL_A, '0xAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAb' as Address],
      switchingBuffer: { minEfficiencyDeltaPercent: 5, sustainedDurationMinutes: 60 },
    });
    const candidate = scored('0xabababababababababababababababababababab' as Address, 0.2);
    const result = evaluateSwitch(current, candidate, checksummedAllowlist, null, T0);
    expect(result.decision.rule).toBe('switch.streak_started');
  });

  it('refuses when a policy with a zero sustained duration slips past validation', () => {
    // Without this guard a bypassed validator would make the buffer fire on the
    // very first tick of an advantage — exactly what it exists to prevent.
    const broken = makePolicy({
      switchingBuffer: { minEfficiencyDeltaPercent: 5, sustainedDurationMinutes: 0 },
    });
    const result = evaluateSwitch(current, better, broken, null, T0);
    expect(result.decision.action).toBe('none');
    expect(result.decision.rule).toBe('switch.invalid_policy');
  });

  it('refuses on a negative minimum delta', () => {
    const broken = makePolicy({
      switchingBuffer: { minEfficiencyDeltaPercent: -10, sustainedDurationMinutes: 60 },
    });
    expect(evaluateSwitch(current, better, broken, null, T0).decision.rule).toBe(
      'switch.invalid_policy',
    );
  });

  it('refuses on a non-finite efficiency score', () => {
    const broken: ScoredPool = {
      poolAddress: POOL_B,
      efficiency: { netEfficiency: NaN, costDrag: 0, inputs: makeInputs() },
    };
    const result = evaluateSwitch(current, broken, policy, null, T0);
    expect(result.decision.action).toBe('none');
    expect(result.decision.rule).toBe('switch.invalid_score');
  });

  it('logs both sides\' full inputs on every tick, including quiet ones', () => {
    const result = evaluateSwitch(current, notBetter, policy, null, T0);
    expect(result.decision.action).toBe('none');
    expect(result.decision.snapshot).toMatchObject({
      currentPool: POOL_A,
      candidatePool: POOL_B,
      currentNetEfficiency: 0.1,
      candidateNetEfficiency: 0.1,
      deltaPercent: 0,
      minEfficiencyDeltaPercent: 5,
      requiredSustainedMinutes: 60,
      now: T0,
    });
    expect(result.decision.snapshot.currentInputs).toEqual(makeInputs());
    expect(result.decision.snapshot.candidateInputs).toEqual(makeInputs());
  });
});
