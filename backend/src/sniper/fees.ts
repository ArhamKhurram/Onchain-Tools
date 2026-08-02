// Fee estimation, in native units. The reservation must debit the amount PLUS
// fees — Slotshark's 0.5%, plus any Solana tip/priority fee — or a daily cap is
// soft by an unbounded margin (docs/architecture/sniper-execution.md).
//
// M1 uses conservative flat estimates. When a venue returns real fee data on a
// fill, reconciliation trues up the reservation against it.

import type { SnipeRule, Venue } from './types.js';

/** Slotshark charges 0.5% per trade. Reconciliation trues this up on fill. */
const VENUE_FEE_RATE: Record<Venue, number> = {
  slotshark: 0.005,
  dryrun: 0.005, // dry run mirrors a real fee so caps are exercised realistically
};

export function estimateFees(rule: SnipeRule, legAmount: number): number {
  const rate = VENUE_FEE_RATE[rule.venue] ?? 0.005;
  let fee = legAmount * rate;
  if (rule.exec.kind === 'sol') {
    fee += rule.exec.tip ?? 0;
    fee += rule.exec.priorityFee ?? 0;
  }
  // EVM gas is denominated in wei on a different asset; for native-unit cap
  // accounting we treat it as covered by the rate buffer in v1 and reconcile on
  // fill. Modelled explicitly here so the omission is a decision, not an oversight.
  return fee;
}
