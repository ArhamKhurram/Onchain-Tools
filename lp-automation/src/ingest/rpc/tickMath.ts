// Pure tick <-> price math and range evaluation for Uniswap V3.
//
// Deliberately dependency-free and side-effect-free: this is the part of the
// low-latency watcher that can be tested exhaustively without a chain, and it
// is where every off-by-one around range boundaries would otherwise hide.
//
// Uniswap V3 prices ticks as `price = 1.0001^tick`, where `price` is the price
// of token0 denominated in token1 (before decimal adjustment). We never need
// the decimal-adjusted human price here — every consumer of this module cares
// about *ratios* (how far outside a range are we, as a fraction), and a ratio
// of two prices is invariant under the decimal scaling factor. Keeping the raw
// ratio avoids dragging token decimals into the hot path.

/** Uniswap V3's hard tick bounds (TickMath.MIN_TICK / MAX_TICK). */
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/** The tick base: each tick is a 1 basis point (0.01%) price step. */
export const TICK_BASE = 1.0001;

// ln(1.0001). Computed with log1p rather than Math.log(1.0001) because log1p is
// accurate for arguments near zero, where the naive form loses several digits.
// The difference shows up at |tick| in the hundreds of thousands.
const LN_TICK_BASE = Math.log1p(1e-4);

/** Thrown for inputs that cannot represent a real Uniswap V3 tick or range. */
export class TickRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TickRangeError';
  }
}

/** Throws unless `tick` is an integer within Uniswap V3's representable bounds. */
export function assertValidTick(tick: number, label = 'tick'): void {
  if (!Number.isInteger(tick)) {
    throw new TickRangeError(`${label} must be an integer, received ${tick}`);
  }
  if (tick < MIN_TICK || tick > MAX_TICK) {
    throw new TickRangeError(
      `${label} ${tick} is outside Uniswap V3 bounds [${MIN_TICK}, ${MAX_TICK}]`,
    );
  }
}

/** Throws unless `[tickLower, tickUpper]` is a well-formed, non-empty range. */
export function assertValidRange(tickLower: number, tickUpper: number): void {
  assertValidTick(tickLower, 'tickLower');
  assertValidTick(tickUpper, 'tickUpper');
  if (tickLower >= tickUpper) {
    throw new TickRangeError(`tickLower (${tickLower}) must be below tickUpper (${tickUpper})`);
  }
}

/**
 * price = 1.0001^tick.
 *
 * Evaluated as exp(tick * ln(1.0001)) rather than Math.pow so the base's
 * logarithm is computed once, at full precision. Both extremes stay well inside
 * double range: 1.0001^887272 ~= 3.4e38, 1.0001^-887272 ~= 2.9e-39.
 */
export function tickToPrice(tick: number): number {
  assertValidTick(tick);
  return Math.exp(tick * LN_TICK_BASE);
}

/**
 * The inverse: tick = ln(price) / ln(1.0001), returned as a real number rather
 * than rounded. Callers that need an on-chain tick want `priceToNearestTick`.
 *
 * Floating point means round-tripping is exact only to ~12 significant digits
 * (`priceToTick(tickToPrice(1))` is 0.99999999999989, not 1) — which is why
 * this returns the un-rounded value and makes rounding an explicit choice.
 */
export function priceToTick(price: number): number {
  if (!Number.isFinite(price) || price <= 0) {
    throw new TickRangeError(`price must be a positive finite number, received ${price}`);
  }
  return Math.log(price) / LN_TICK_BASE;
}

/**
 * `priceToTick` rounded to the nearest integer tick. Throws rather than clamps
 * when the price implies a tick outside Uniswap's bounds — silently clamping
 * would hand back a tick that does not mean what the caller asked for.
 */
export function priceToNearestTick(price: number): number {
  const exact = priceToTick(price);
  const rounded = Math.round(exact);
  assertValidTick(rounded, 'tick derived from price');
  return rounded;
}

/** Which side of a position's range the current tick sits on. */
export type RangeSide = 'below' | 'inside' | 'above';

export interface RangeEvaluation {
  side: RangeSide;
  /** Convenience mirror of `side === 'inside'`. */
  inside: boolean;
  /** Ticks past the breached bound; 0 when inside (and 0 exactly at a bound). */
  ticksOutside: number;
  /**
   * How far price has moved past the breached bound, as a fraction of that
   * bound's price. 0 when inside.
   *
   * Asymmetric by construction, and that is correct: below the range the
   * fraction is bounded by 1 (price can only fall to zero), above the range it
   * is unbounded (price can rise without limit).
   */
  exitFraction: number;
  /** `exitFraction * 100`, for comparison against policy percentages. */
  exitPercent: number;
}

export interface RangeEvaluationOptions {
  /**
   * Whether `tick === tickUpper` counts as inside the range.
   *
   * Default `false`, matching Uniswap V3 itself: a position's liquidity is
   * active for `tickLower <= tick < tickUpper`, so at exactly `tickUpper` the
   * position is fully converted and earning nothing. The plan's phrasing
   * ("outside [tickLower, tickUpper]") reads as a closed interval, so the
   * option exists — but the protocol-accurate half-open interval is the default
   * because it is the one that matches where fees actually stop accruing.
   */
  inclusiveUpper?: boolean;
}

/**
 * Where `tick` sits relative to `[tickLower, tickUpper)` and by how much.
 *
 * The distance is computed in tick space (`1.0001^(tick - bound)`) rather than
 * by dividing two prices. Algebraically identical, but numerically far better:
 * it never materializes the 1e38-scale prices at the extremes, and `expm1`
 * keeps full precision for the near-the-boundary case that matters most.
 */
export function evaluateRange(
  tick: number,
  tickLower: number,
  tickUpper: number,
  options: RangeEvaluationOptions = {},
): RangeEvaluation {
  assertValidTick(tick);
  assertValidRange(tickLower, tickUpper);

  const inclusiveUpper = options.inclusiveUpper ?? false;

  if (tick < tickLower) {
    // price / priceLower = 1.0001^(tick - tickLower), which is < 1.
    // exitFraction = 1 - ratio = -expm1((tick - tickLower) * ln(1.0001)).
    const exitFraction = -Math.expm1((tick - tickLower) * LN_TICK_BASE);
    return {
      side: 'below',
      inside: false,
      ticksOutside: tickLower - tick,
      exitFraction,
      exitPercent: exitFraction * 100,
    };
  }

  const aboveUpper = inclusiveUpper ? tick > tickUpper : tick >= tickUpper;
  if (aboveUpper) {
    // price / priceUpper = 1.0001^(tick - tickUpper), which is >= 1.
    const exitFraction = Math.expm1((tick - tickUpper) * LN_TICK_BASE);
    return {
      side: 'above',
      inside: false,
      ticksOutside: tick - tickUpper,
      exitFraction,
      exitPercent: exitFraction * 100,
    };
  }

  return { side: 'inside', inside: true, ticksOutside: 0, exitFraction: 0, exitPercent: 0 };
}

/** True when `tick` is not earning fees for `[tickLower, tickUpper)`. */
export function isOutsideRange(
  tick: number,
  tickLower: number,
  tickUpper: number,
  options: RangeEvaluationOptions = {},
): boolean {
  return !evaluateRange(tick, tickLower, tickUpper, options).inside;
}
