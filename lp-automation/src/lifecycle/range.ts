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

import type { LpPosition } from '../types.js';

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
 * Re-centre a position's range on its current tick, preserving width.
 *
 * Pure. Returns a reason instead of throwing so the caller can record the
 * refusal in the audit log like any other non-action.
 */
export function recenterRange(position: LpPosition): RecenterResult {
  const { tickLower, tickUpper, currentTick } = position;

  if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper) || !Number.isInteger(currentTick)) {
    return { ok: false, reason: `ticks are not integers (${tickLower}, ${tickUpper}, ${currentTick})` };
  }
  const width = tickUpper - tickLower;
  if (width <= 0) {
    return { ok: false, reason: `range width ${width} is not positive` };
  }

  const spacing = TICK_SPACING_BY_FEE_BPS[position.pool.feeTierBps];
  if (spacing === undefined) {
    return {
      ok: false,
      reason:
        `fee tier ${position.pool.feeTierBps}bps has no known tick spacing; ` +
        'refusing to guess a range for a pool whose spacing we cannot derive',
    };
  }

  // Snap outwards from the centre in whole spacing units. `Math.round` on the
  // half-width keeps the new range as close to the original width as the
  // spacing allows; it can differ by at most one spacing unit.
  const halfWidth = Math.max(spacing, Math.round(width / 2 / spacing) * spacing);
  const centre = Math.round(currentTick / spacing) * spacing;
  const nextLower = centre - halfWidth;
  const nextUpper = centre + halfWidth;

  if (nextLower < MIN_TICK || nextUpper > MAX_TICK) {
    return {
      ok: false,
      reason: `re-centred range [${nextLower}, ${nextUpper}] falls outside the usable tick range`,
    };
  }
  if (nextUpper <= nextLower) {
    return { ok: false, reason: `re-centred range [${nextLower}, ${nextUpper}] is degenerate` };
  }
  if (nextLower === tickLower && nextUpper === tickUpper) {
    // The trigger fired but re-centring would produce the range we already
    // hold. Moving to the same place costs gas for nothing.
    return { ok: false, reason: 'the re-centred range is identical to the current range' };
  }

  return { ok: true, range: { tickLower: nextLower, tickUpper: nextUpper } };
}
