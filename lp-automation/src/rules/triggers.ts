// Compound and rebalance triggers (plan §5 triggers, §6 evaluator).
//
// Both functions return a `Decision` on EVERY call, including the overwhelmingly
// common "nothing to do" case. That is deliberate: the plan requires the score
// and its inputs logged at every evaluation tick, not just at trigger time (§6),
// and the only way to guarantee that is to make the quiet path produce a record
// too. A function that returned `null` when nothing fired would make the audit
// log silent exactly where post-incident review needs it most.
//
// Both are pure — no clock read, no chain read. `now` is passed in.

import type { AutomationPolicy, Decision, LpPosition } from '../types.js';

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;

/** Uniswap V3's tick base. price = TICK_BASE^tick. */
export const TICK_BASE = 1.0001;

/**
 * Convert a Uniswap V3 tick to a price ratio.
 *
 * Ticks are LOGARITHMIC, not linear — each tick is a 0.01% multiplicative step,
 * so a tick delta is never a percentage. 10,000 ticks is not 100%: it is
 * 1.0001^10000 ≈ 2.7181, i.e. +171.8%. Treating a tick delta as a percentage is
 * the classic mistake here and it under-reports every wide range by a lot.
 *
 * Returns null for a tick that cannot produce a usable price (non-finite input,
 * or an overflow past Uniswap's ±887272 usable bounds).
 */
export function tickToPrice(tick: number): number | null {
  if (typeof tick !== 'number' || !Number.isFinite(tick)) return null;
  const price = Math.pow(TICK_BASE, tick);
  if (!Number.isFinite(price) || price <= 0) return null;
  return price;
}

/**
 * How far outside its range the price has travelled, as a percentage of the
 * breached bound. Zero while the price is inside the range.
 *
 * Measured against the bound that was breached, not the range width, so the
 * number means the same thing for a tight range as for a wide one: "price is X%
 * beyond the edge of where our liquidity is".
 *
 * Returns null when the range itself is malformed.
 */
export function computeRangeExitPercent(
  tickLower: number,
  tickUpper: number,
  currentTick: number,
): number | null {
  if (!Number.isFinite(tickLower) || !Number.isFinite(tickUpper)) return null;
  if (tickLower >= tickUpper) return null;

  const priceLower = tickToPrice(tickLower);
  const priceUpper = tickToPrice(tickUpper);
  const priceCurrent = tickToPrice(currentTick);
  if (priceLower === null || priceUpper === null || priceCurrent === null) return null;

  if (priceCurrent > priceUpper) return ((priceCurrent - priceUpper) / priceUpper) * 100;
  if (priceCurrent < priceLower) return ((priceLower - priceCurrent) / priceLower) * 100;
  return 0;
}

/**
 * Should this position's fees be compounded back in?
 *
 * Fires on either arm:
 *   `compound.fees_vs_gas`   unclaimedFeesUsd / gasCostUsd >= minFeesVsGasRatio
 *   `compound.max_interval`  maxIntervalHours elapsed since the last compound
 *                            (or since `openedAt` when never compounded)
 *
 * The ratio arm is evaluated first so that when both hold, the recorded rule is
 * the economic reason rather than the liveness backstop.
 *
 * Two guards the plan does not spell out (see the report for both):
 *   • Zero/negative/unknown gas cost makes the ratio undefined. We do not treat
 *     it as "free, therefore compound" — an unpriceable transaction is one we
 *     decline to justify, so the ratio arm simply cannot fire.
 *   • Zero unclaimed fees blocks BOTH arms. Compounding nothing is a pure gas
 *     burn, and letting the interval backstop do that on a schedule would bleed
 *     the position for as long as it stays idle.
 */
export function shouldCompound(
  position: LpPosition,
  policy: AutomationPolicy,
  gasCostUsd: number,
  now: number,
): Decision {
  const trigger = policy.compoundTrigger;
  const referenceAt = position.lastCompoundedAt ?? position.openedAt;
  const elapsedHours = (now - referenceAt) / MS_PER_HOUR;

  const gasUsable = Number.isFinite(gasCostUsd) && gasCostUsd > 0;
  const feesUsable = Number.isFinite(position.unclaimedFeesUsd) && position.unclaimedFeesUsd > 0;
  const feesVsGas = gasUsable && feesUsable ? position.unclaimedFeesUsd / gasCostUsd : null;

  const snapshot: Record<string, unknown> = {
    tokenId: position.tokenId,
    pool: position.pool.address,
    status: position.status,
    unclaimedFeesUsd: position.unclaimedFeesUsd,
    gasCostUsd,
    feesVsGasRatio: feesVsGas,
    minFeesVsGasRatio: trigger.minFeesVsGasRatio,
    elapsedHours,
    maxIntervalHours: trigger.maxIntervalHours,
    lastCompoundedAt: position.lastCompoundedAt,
    openedAt: position.openedAt,
    referenceAt,
    now,
    policyVersion: policy.version,
  };

  const decide = (action: Decision['action'], rule: string, reason: string): Decision => ({
    action,
    rule,
    reason,
    snapshot,
  });

  if (position.status === 'closed') {
    return decide('none', 'compound.position_closed', 'position is closed; nothing to compound');
  }

  if (!feesUsable) {
    return decide(
      'none',
      'compound.no_fees',
      'no unclaimed fees to compound; compounding nothing would spend gas for no gain',
    );
  }

  if (feesVsGas !== null && feesVsGas >= trigger.minFeesVsGasRatio) {
    return decide(
      'compound',
      'compound.fees_vs_gas',
      `unclaimed fees ${position.unclaimedFeesUsd} are ${feesVsGas.toFixed(2)}x gas cost ${gasCostUsd}, at or above the ${trigger.minFeesVsGasRatio}x threshold`,
    );
  }

  if (Number.isFinite(elapsedHours) && elapsedHours >= trigger.maxIntervalHours) {
    return decide(
      'compound',
      'compound.max_interval',
      `${elapsedHours.toFixed(2)}h since last compound, at or above the ${trigger.maxIntervalHours}h backstop interval`,
    );
  }

  return decide(
    'none',
    'compound.hold',
    feesVsGas === null
      ? 'gas cost unavailable, so the fees-vs-gas arm cannot be evaluated, and the interval backstop has not elapsed'
      : `fees are ${feesVsGas.toFixed(2)}x gas (need ${trigger.minFeesVsGasRatio}x) and only ${elapsedHours.toFixed(2)}h of ${trigger.maxIntervalHours}h elapsed`,
  );
}

/**
 * Should this position's range be moved?
 *
 * Fires when the price has left the range by MORE than `rangeExitPercent`.
 * Exactly at the threshold does not fire — the boundary belongs to the calmer
 * outcome, so a price hovering precisely on the line does not oscillate us in
 * and out of rebalances.
 */
export function shouldRebalance(position: LpPosition, policy: AutomationPolicy): Decision {
  const threshold = policy.rebalanceTrigger.rangeExitPercent;
  const exitPercent = computeRangeExitPercent(
    position.tickLower,
    position.tickUpper,
    position.currentTick,
  );

  const snapshot: Record<string, unknown> = {
    tokenId: position.tokenId,
    pool: position.pool.address,
    status: position.status,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    currentTick: position.currentTick,
    priceLower: tickToPrice(position.tickLower),
    priceUpper: tickToPrice(position.tickUpper),
    priceCurrent: tickToPrice(position.currentTick),
    rangeExitPercent: exitPercent,
    thresholdPercent: threshold,
    policyVersion: policy.version,
  };

  const decide = (action: Decision['action'], rule: string, reason: string): Decision => ({
    action,
    rule,
    reason,
    snapshot,
  });

  if (position.status === 'closed') {
    return decide('none', 'rebalance.position_closed', 'position is closed; nothing to rebalance');
  }

  if (exitPercent === null) {
    // Malformed ticks are a data error, not a signal. Refuse rather than guess —
    // a rebalance built from a bad range would place liquidity somewhere nobody
    // chose.
    return decide(
      'none',
      'rebalance.invalid_range',
      `tick range is unusable (lower=${position.tickLower}, upper=${position.tickUpper}, current=${position.currentTick})`,
    );
  }

  if (!Number.isFinite(threshold) || threshold <= 0) {
    return decide(
      'none',
      'rebalance.invalid_policy',
      `rangeExitPercent ${threshold} is not a usable threshold; refusing to rebalance`,
    );
  }

  if (exitPercent === 0) {
    return decide('none', 'rebalance.in_range', 'price is inside the position range');
  }

  if (exitPercent > threshold) {
    return decide(
      'rebalance',
      'rebalance.range_exit',
      `price is ${exitPercent.toFixed(4)}% outside the range, beyond the ${threshold}% threshold`,
    );
  }

  return decide(
    'none',
    'rebalance.within_tolerance',
    `price is ${exitPercent.toFixed(4)}% outside the range, within the ${threshold}% tolerance`,
  );
}
