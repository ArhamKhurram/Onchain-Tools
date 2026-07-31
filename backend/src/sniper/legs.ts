// Leg computation. One trigger fans out to one leg per (wallet x ladder-step).
//
// Semantics (docs/architecture/sniper-rules.md): sizeTotal is the spend per wallet
// per trigger. A single-entry rule is one leg of sizeTotal per wallet. A ladder
// splits sizeTotal across legs by ladderSplit weights, per wallet. So the whole
// trigger spends sizeTotal x walletIds.length, which is exactly what perTriggerCap
// bounds.

import type { FireLeg, SnipeRule } from './types.js';

/** Ladder weights are operator (and, in Phase 3, model) input — validate at arm time. */
export function validateLadderSplit(
  split: number[] | null,
): { ok: true } | { ok: false; reason: 'empty' | 'negative' | 'not_normalized' | 'too_many' } {
  if (!split || split.length === 0) return { ok: false, reason: 'empty' };
  if (split.length > MAX_LADDER_LEGS) return { ok: false, reason: 'too_many' };
  if (split.some((w) => !Number.isFinite(w) || w <= 0)) return { ok: false, reason: 'negative' };
  const sum = split.reduce((a, b) => a + b, 0);
  // Tolerance covers float representation of e.g. [0.2 x 5]; anything looser
  // would let weights summing to 1.5 through, spending 50% over sizeTotal.
  if (Math.abs(sum - 1) > 1e-9) return { ok: false, reason: 'not_normalized' };
  return { ok: true };
}

export const MAX_LADDER_LEGS = 10;

export function computeLegs(rule: SnipeRule): FireLeg[] {
  // An invalid split collapses to a single full-size leg rather than silently
  // scaling total spend. perTriggerCap in executeFire is the backstop, but a
  // rule should not arm with a bad split in the first place.
  const usable =
    rule.entryStyle === 'ladder' && validateLadderSplit(rule.ladderSplit).ok
      ? rule.ladderSplit
      : null;
  const weights = usable ?? [1];

  const legs: FireLeg[] = [];
  for (const walletId of rule.walletIds) {
    weights.forEach((w, i) => {
      legs.push({ walletId, legNo: i, amount: rule.sizeTotal * w });
    });
  }
  return legs;
}
