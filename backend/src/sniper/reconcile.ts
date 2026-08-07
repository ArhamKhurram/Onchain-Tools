// The reconciler seam — specified, and UNIMPLEMENTABLE against what this repo
// can verify.
//
// docs/architecture/sniper-execution.md:139-147 has `reconcile(wallet, mint,
// since)` landing WITH M3. It cannot: reconciling needs a venue fill-history
// query, and no Slotshark endpoint of that kind is known to this codebase (the
// only one that is, is POST /buy — executors/slotshark.ts:66).
//
// TODO(unverified): the venue fill-history endpoint — its path, its pagination,
// and whether Slotshark exposes fills per wallet at all. Do not invent one.
//
// CONSEQUENCE, which the Fires tab states in words: an `unknown` leg holds its
// reservation forever. executeFire deliberately never retries and never releases
// on `unknown` (executeFire.ts) because the send may have landed, and reconcile
// is what would have resolved that automatically. The alpha's substitute is a
// human: POST /sniper/v1/fires/:id/resolve, where an operator checks Slotshark's
// dashboard and records what they found. That is a stand-in for this file, not a
// replacement for it — it does not scale past a handful of manual fires, and M2
// makes it untenable.

import type { Chain } from './types.js';

export interface ReconciledFill {
  signature: string;
  mint: string;
  /** Native-unit amount actually spent, including whatever the venue charged. */
  amount: number;
  at: number;
}

export interface SniperReconciler {
  /**
   * Fills for `wallet` on `mint` since `since` (epoch ms), as the venue reports
   * them. The caller matches these against `unknown` rows in the fire log and
   * either confirms the debit or releases the reservation.
   */
  reconcile(wallet: string, mint: string, since: number, chain: Chain): Promise<ReconciledFill[]>;
}
