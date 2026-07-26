// Net efficiency scoring (plan §6).
//
// ---------------------------------------------------------------------------
// The arithmetic, and why it is not literally what the plan writes
// ---------------------------------------------------------------------------
//
// The plan states the rule as:
//
//     net_efficiency = fee_apr − estimated_IL − (gas_cost + slippage_cost) / expected_holding_period
//
// As written that is dimensionally incoherent. `fee_apr` and `estimated_IL` are
// annualized fractions (0.42 = 42%/yr). `(gas + slippage) / holding_period` is
// dollars-per-day. Subtracting dollars-per-day from a fraction-per-year has no
// meaning, and worse, its numeric value depends on position size in the wrong
// direction — a $10 gas bill would score identically against a $200 position and
// a $200,000 one.
//
// The cost term has to be made commensurable with the two APR terms before it
// can be subtracted. Two steps, in this order:
//
//   1. NORMALIZE against position value → the dimensionless fraction of capital
//      one round of costs consumes:
//              (gasCostUsd + slippageCostUsd) / positionValueUsd
//
//   2. ANNUALIZE over the holding period → the same fraction expressed per year,
//      which is the unit `feeApr` and `estimatedIlApr` are already in:
//              × (DAYS_PER_YEAR / expectedHoldingPeriodDays)
//
//   costDrag = (gasCostUsd + slippageCostUsd) / positionValueUsd
//              × (DAYS_PER_YEAR / expectedHoldingPeriodDays)
//
//   netEfficiency = feeApr − estimatedIlApr − costDrag
//
// Worked example: $10 of gas + slippage on a $1,000 position expected to be held
// 30 days → (10 / 1000) × (365 / 30) = 0.1217, a 12.17%/yr drag. Paying 1% of the
// position every 30 days does cost ≈12.2% a year. Simple, not compounded: this
// number exists to be compared against other pools' numbers, and simple
// annualization keeps that comparison linear and legible in the audit log.
//
// The annualization is what makes short holding periods self-punishing. The same
// $10 over 1 day is a 365% drag, so a pool we would have to abandon tomorrow can
// never out-score one we can sit in for a quarter. That is intended: it is the
// arithmetic half of the switching buffer's job, and it is why `evaluateSwitch`
// can compare two scores directly without re-deriving cost.
//
// ---------------------------------------------------------------------------
// Degenerate inputs
// ---------------------------------------------------------------------------
//
// Zero position value or zero holding period makes the drag term infinite. We do
// NOT return `Infinity`: `JSON.stringify(Infinity)` is `null`, which would put a
// silent hole in the audit log at exactly the moment something went wrong. A
// large finite sentinel keeps the record honest and keeps downstream arithmetic
// total. Any degenerate input produces a score so negative that no rule which
// consumes it can ever fire — refusing to act is the correct response to
// nonsense data.

import type { EfficiencyInputs, EfficiencyScore } from '../types.js';

export const DAYS_PER_YEAR = 365;

/**
 * Stand-in for "infinite cost drag". Far beyond any real APR (1e9 = 100,000,000%)
 * yet finite, JSON-serializable, and exactly representable as a double.
 */
export const PROHIBITIVE_COST_DRAG = 1e9;

function isUsableNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Compute the net efficiency of a position or candidate pool, annualized.
 *
 * Pure and total: every input combination yields a score. The full input set is
 * echoed back in the result because the plan requires logging the score AND its
 * inputs at every evaluation tick, not only when a trigger fires (§6).
 */
export function computeEfficiency(inputs: EfficiencyInputs): EfficiencyScore {
  const {
    feeApr,
    estimatedIlApr,
    gasCostUsd,
    slippageCostUsd,
    positionValueUsd,
    expectedHoldingPeriodDays,
  } = inputs;

  const prohibitive = (): EfficiencyScore => ({
    netEfficiency: -PROHIBITIVE_COST_DRAG,
    costDrag: PROHIBITIVE_COST_DRAG,
    inputs,
  });

  // Any non-finite input poisons the whole score. Note that NaN would otherwise
  // propagate silently through every comparison as `false`, which reads as
  // "no trigger fired" — indistinguishable from a healthy quiet tick.
  if (
    !isUsableNumber(feeApr) ||
    !isUsableNumber(estimatedIlApr) ||
    !isUsableNumber(gasCostUsd) ||
    !isUsableNumber(slippageCostUsd) ||
    !isUsableNumber(positionValueUsd) ||
    !isUsableNumber(expectedHoldingPeriodDays)
  ) {
    return prohibitive();
  }

  // A negative cost would *raise* the score — the one direction of bad data that
  // could talk us into a trade. Reject rather than clamp.
  if (gasCostUsd < 0 || slippageCostUsd < 0) return prohibitive();

  // Division guards. Zero position value means there is nothing to amortize the
  // cost over; zero holding period means no time to amortize it in. Both are
  // data errors, and both are treated as infinitely expensive rather than free.
  if (positionValueUsd <= 0 || expectedHoldingPeriodDays <= 0) return prohibitive();

  const costFraction = (gasCostUsd + slippageCostUsd) / positionValueUsd;
  const costDrag = costFraction * (DAYS_PER_YEAR / expectedHoldingPeriodDays);

  return {
    netEfficiency: feeApr - estimatedIlApr - costDrag,
    costDrag,
    inputs,
  };
}
