// Where to put the liquidity when rebalancing.
//
// THE PLAN DOES NOT SPECIFY THIS. §7 says "rebalance via Krystal's
// `adjust_range`", and `buildAdjustRange` requires `newTickLower` /
// `newTickUpper` — but nothing upstream produces them. `rules/` decides WHETHER
// to move; nothing decides WHERE to. This module is the smallest honest answer
// to that gap, and it is deliberately dumb:
//
//   Keep the range's existing WIDTH, re-centre it on the current tick.
//
// Width is the operator's expressed risk preference (it was chosen when the
// position was opened) and nothing in the policy schema authorizes changing it.
// Re-centring is the minimum action that satisfies the trigger that fired.
// Anything cleverer — widening on volatility, skewing with a trend — is a
// strategy decision that belongs in the dashboard-authored policy, not
// hard-coded here where nobody chose it.
//
// TICK SPACING. Uniswap V3 only accepts bounds that are multiples of the pool's
// tick spacing, and `PoolCandidate` carries `feeTierBps` rather than the spacing
// itself. The canonical fee->spacing map covers every tier deployed by the
// standard factory; a fee tier outside it means either a custom factory or a
// mapping bug, and we REFUSE rather than guess. A wrong spacing produces a
// transaction that reverts on-chain after paying gas, or worse, silently snaps
// to a range nobody intended.

import { RANGE_STRATEGY_HALF_WIDTH, type LpPosition, type RangeStrategy } from '../types.js';

/** ln(1.0001) — the per-tick log ratio. price = 1.0001^tick. */
const LN_TICK_BASE = Math.log(1.0001);

/** Uniswap V3 canonical fee tier (bps) -> tick spacing. */
export const TICK_SPACING_BY_FEE_BPS: Readonly<Record<number, number>> = {
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
};

/** Uniswap V3 usable tick bounds. */
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

export interface TickRange {
  tickLower: number;
  tickUpper: number;
}

export type RecenterResult =
  | { ok: true; range: TickRange }
  | { ok: false; reason: string };

/**
 * Compute a range centred on `currentTick`, per the {@link RangeStrategy}.
 *
 * The width comes from the strategy, NOT from any existing range:
 *
 *   - `narrow`/`wide` — a band symmetric in PRICE (`±5%` / `±20%`), because
 *     "±5%" is what the operator means. Price↔tick is logarithmic, so the two
 *     tick deltas are not equal in magnitude; each is derived from its own
 *     `ln(1±hw)` and the bounds are snapped OUTWARDS (floor the lower, ceil the
 *     upper) so the realised band is never tighter than requested.
 *   - `full` — the whole usable tick range, snapped inwards to valid multiples.
 *     A position that never leaves range and never rebalances.
 *
 * `feeUnits` is Uniswap's on-chain fee unit (10000 == 1%) — the key
 * `TICK_SPACING_BY_FEE_BPS` uses. Pure; returns a reason instead of throwing so
 * the caller records the refusal in the audit log like any other non-action.
 *
 * This is the shared core of both a rebalance ({@link recenterRange}) and an
 * enter (a brand-new position, which has no existing range to compare against).
 */
export function rangeFromCenter(
  currentTick: number,
  feeUnits: number,
  strategy: RangeStrategy,
): RecenterResult {
  if (!Number.isInteger(currentTick)) {
    return { ok: false, reason: `currentTick is not an integer (${currentTick})` };
  }

  const spacing = TICK_SPACING_BY_FEE_BPS[feeUnits];
  if (spacing === undefined) {
    return {
      ok: false,
      reason:
        `fee tier ${feeUnits}bps has no known tick spacing; ` +
        'refusing to guess a range for a pool whose spacing we cannot derive',
    };
  }

  let nextLower: number;
  let nextUpper: number;

  if (strategy === 'full') {
    // Snap the usable bounds INWARDS so both are valid multiples of spacing.
    nextLower = Math.ceil(MIN_TICK / spacing) * spacing;
    nextUpper = Math.floor(MAX_TICK / spacing) * spacing;
  } else {
    const halfWidth = RANGE_STRATEGY_HALF_WIDTH[strategy];
    if (!(halfWidth > 0 && halfWidth < 1)) {
      return { ok: false, reason: `range strategy "${strategy}" has an invalid half-width` };
    }
    // Price-symmetric band -> asymmetric tick deltas (log scale). Snap outwards
    // so the realised band is at least as wide as asked, never tighter.
    const lowerDelta = Math.log(1 - halfWidth) / LN_TICK_BASE; // negative
    const upperDelta = Math.log(1 + halfWidth) / LN_TICK_BASE; // positive
    nextLower = Math.floor((currentTick + lowerDelta) / spacing) * spacing;
    nextUpper = Math.ceil((currentTick + upperDelta) / spacing) * spacing;

    // With a very tight band and coarse spacing the two can land on the same
    // multiple; force at least one spacing unit either side of the centre.
    if (nextUpper - nextLower < 2 * spacing) {
      const centre = Math.round(currentTick / spacing) * spacing;
      nextLower = centre - spacing;
      nextUpper = centre + spacing;
    }
  }

  if (nextLower < MIN_TICK || nextUpper > MAX_TICK) {
    return {
      ok: false,
      reason: `range [${nextLower}, ${nextUpper}] falls outside the usable tick range`,
    };
  }
  if (nextUpper <= nextLower) {
    return { ok: false, reason: `range [${nextLower}, ${nextUpper}] is degenerate` };
  }

  return { ok: true, range: { tickLower: nextLower, tickUpper: nextUpper } };
}

/**
 * Compute the new range for a rebalance, per the policy's {@link RangeStrategy}.
 *
 * The band is centred on the CURRENT tick (that is the whole point of a
 * rebalance — the price left the old range). Delegates the geometry to
 * {@link rangeFromCenter} and adds the one rebalance-specific guard: a target
 * identical to the range we already hold is refused, because moving to the same
 * place costs gas for nothing.
 *
 * Pure. Returns a reason instead of throwing.
 */
export function recenterRange(position: LpPosition, strategy: RangeStrategy): RecenterResult {
  const result = rangeFromCenter(position.currentTick, position.pool.feeTierBps, strategy);
  if (!result.ok) return result;

  if (result.range.tickLower === position.tickLower && result.range.tickUpper === position.tickUpper) {
    return { ok: false, reason: 'the target range is identical to the current range' };
  }
  return result;
}
