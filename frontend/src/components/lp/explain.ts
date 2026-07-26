// Plain-language readouts of what a policy actually does.
//
// The brief for this page is that a setting's consequence should be legible at
// a glance — "3.0" means nothing, "compound once fees are worth 3× the gas it
// costs to claim them" means something. These render live under each group as
// the operator types, so a bad edit reads wrong in English before it is saved.

import { describeDailyCapacity, formatHours, formatMinutes, formatRatio, formatUsdExact } from './format';
import { toNumber, type PolicyDraft } from './policyDraft';
import type { RangeStrategy } from './types';

const UNSET = 'Set a value to see what this does.';

function ok(...values: number[]): boolean {
  return values.every((value) => Number.isFinite(value));
}

export function describeCapital(draft: PolicyDraft): string {
  const size = toNumber(draft.maxPositionSizeUsd);
  const cap = toNumber(draft.dailySpendCapUsd);
  if (!ok(size, cap)) return UNSET;
  return `At most ${formatUsdExact(size)} in any single position, and ${formatUsdExact(
    cap,
  )} deployed across a rolling 24 hours — ${describeDailyCapacity(size, cap)}.`;
}

export function describeSurfacing(draft: PolicyDraft): string {
  const tvl = toNumber(draft.poolSelectionCriteria.minTvlUsd);
  const volume = toNumber(draft.poolSelectionCriteria.min24hVolumeUsd);
  if (!ok(tvl, volume)) return UNSET;
  return `Show pools holding at least ${formatUsdExact(tvl)} with ${formatUsdExact(
    volume,
  )} of volume in the last 24 hours. Showing is all this does — a pool still has to be ticked below before anything can enter it.`;
}

export function describeCompound(draft: PolicyDraft): string {
  const ratio = toNumber(draft.compoundTrigger.minFeesVsGasRatio);
  const interval = toNumber(draft.compoundTrigger.maxIntervalHours);
  if (!ok(ratio, interval)) return UNSET;
  return `Compound once claimable fees are worth ${formatRatio(
    ratio,
  )} the gas it costs to claim them — or after ${formatHours(interval)}, whichever comes first.`;
}

export function describeRebalance(draft: PolicyDraft): string {
  const exit = toNumber(draft.rebalanceTrigger.rangeExitPercent);
  if (!ok(exit)) return UNSET;
  return `Move the range once price has left it by ${exit}%. Below that, price drifting out of range is left alone.`;
}

/**
 * What each range strategy means in practice. Widths track the worker's
 * band mapping (narrow = ±5%, wide = ±20%, full = the pool's whole range); keep
 * these in step if that mapping ever changes.
 */
export const RANGE_STRATEGY_COPY: Record<RangeStrategy, string> = {
  narrow:
    'Narrow — the tightest band, about ±5% around the current price. Earns the most fees per dollar of liquidity and, for exactly that reason, leaves range and rebalances the most.',
  wide:
    'Wide — a looser band, about ±20%. Earns less than narrow but drifts out of range less often, so it rebalances less.',
  full:
    'Full — the whole range, like a v2 position. Never leaves range and never rebalances, but earns the least.',
};

export function describeRangeStrategy(draft: PolicyDraft): string {
  return RANGE_STRATEGY_COPY[draft.rebalanceTrigger.rangeStrategy] ?? UNSET;
}

export function describeSwitching(draft: PolicyDraft): string {
  const delta = toNumber(draft.switchingBuffer.minEfficiencyDeltaPercent);
  const minutes = toNumber(draft.switchingBuffer.sustainedDurationMinutes);
  if (!ok(delta, minutes)) return UNSET;
  return `Leave a pool for a rival only when the rival is ahead by ${delta} percentage points of annualized net efficiency and has stayed ahead for ${formatMinutes(
    minutes,
  )} without interruption. Both conditions, every time — a momentary crossover never moves capital.`;
}
