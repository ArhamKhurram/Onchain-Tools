// Startup recovery from the audit log (plan §10 step 6).
//
// ---------------------------------------------------------------------------
// WHY AN UNRESOLVED INTENT BLOCKS A POSITION
// ---------------------------------------------------------------------------
// `AuditLog` writes the intent BEFORE broadcasting and the outcome after. An
// intent with no matching outcome therefore means the process died somewhere
// between those two writes, and there are three possibilities:
//
//   1. It died before the transaction was sent      — nothing happened.
//   2. It died after the transaction was sent       — a transaction is, or was,
//      but before the outcome was written             in flight.
//   3. It died while the transaction was pending    — it may still land, later.
//
// The log cannot distinguish them. That is not a defect in the log; the chain
// is the only source of truth for what actually executed, and this process is
// deliberately not allowed to reason its way to "probably nothing happened".
//
// Re-issuing the action would, in case (2) and (3), rebalance or compound the
// same position twice. Skipping it costs nothing but a delay. So we skip, and
// we say so loudly, and we keep saying so on every tick for that position.
//
// ---------------------------------------------------------------------------
// WHY AN UNATTRIBUTABLE INTENT BLOCKS EVERYTHING
// ---------------------------------------------------------------------------
// The position an intent belongs to is read from `snapshot.tokenId`, which
// every rule in `src/rules/` populates. If a record somehow lacks it, we cannot
// tell WHICH position may have a transaction in flight — so the only safe
// reading is "any of them". `blockAll` is that state. It is loud and total on
// purpose: a log we cannot interpret is not a log we may act around.
//
// ---------------------------------------------------------------------------
// CLEARING IT
// ---------------------------------------------------------------------------
// There is deliberately no automatic clearing and no timeout. A human checks
// the chain for the position in question, appends a resolving outcome entry
// with the SAME id (the log is append-only — a correction is a new line, never
// an edit), and restarts the process. `findUnresolved` then sees the id as
// resolved and the quarantine is empty. Any mechanism that let the process
// clear its own quarantine would defeat the entire point of having one.

import { findUnresolved, type AuditRecord } from '../audit/log.js';

export interface UnresolvedIntent {
  /** Audit id, i.e. what a human appends an outcome for to clear it. */
  auditId: string;
  /** Position the intent belongs to; null when the record did not say. */
  tokenId: string | null;
  action: AuditRecord['action'];
  timestamp: number;
}

export class Quarantine {
  private readonly positions: Set<string>;
  private readonly blockedAll: boolean;
  readonly intents: readonly UnresolvedIntent[];

  private constructor(intents: UnresolvedIntent[]) {
    this.intents = intents;
    this.positions = new Set(
      intents.map((intent) => intent.tokenId).filter((id): id is string => id !== null),
    );
    this.blockedAll = intents.some((intent) => intent.tokenId === null);
  }

  /** Empty quarantine — nothing was left in flight. */
  static empty(): Quarantine {
    return new Quarantine([]);
  }

  /** Build from a full audit-log read. */
  static fromRecords(records: readonly AuditRecord[]): Quarantine {
    return new Quarantine(findUnresolved([...records]).map(toIntent));
  }

  get isEmpty(): boolean {
    return this.intents.length === 0;
  }

  /** True when an intent could not be attributed to a position — blocks all. */
  get blocksEverything(): boolean {
    return this.blockedAll;
  }

  blocks(tokenId: string): boolean {
    return this.blockedAll || this.positions.has(tokenId);
  }

  /** Human-readable reason, recorded verbatim in the audit log on every skip. */
  describe(tokenId: string): string {
    if (this.blockedAll) {
      return (
        `the audit log contains ${this.intents.length} unresolved intent(s), at least one of which ` +
        'could not be attributed to a position, so EVERY position is blocked. A transaction may be ' +
        'in flight from a previous run — check the chain, append a resolving outcome entry, restart.'
      );
    }
    const mine = this.intents.filter((intent) => intent.tokenId === tokenId);
    const ids = mine.map((intent) => intent.auditId).join(', ');
    return (
      `position ${tokenId} has ${mine.length} unresolved intent(s) [${ids}] from a previous run. ` +
      'A transaction may be in flight; re-issuing this action could execute it twice. ' +
      'Check the chain, append a resolving outcome entry with the same id, then restart.'
    );
  }
}

function toIntent(record: AuditRecord): UnresolvedIntent {
  const tokenId = record.snapshot?.['tokenId'];
  return {
    auditId: record.id,
    tokenId: typeof tokenId === 'string' && tokenId.length > 0 ? tokenId : null,
    action: record.action,
    timestamp: record.timestamp,
  };
}

/**
 * Reconstruct "when did we last compound this position?" from the audit log.
 *
 * Krystal exposes no last-compound timestamp on any endpoint sampled (plan §11
 * item 9), so `LpPosition.lastCompoundedAt` arrives as null and the compound
 * trigger's `maxIntervalHours` backstop would fire against `openedAt` forever.
 * Our own log is the record.
 *
 * Only SUCCESSFUL, BROADCAST compounds count: a `skipped_disarmed` outcome or a
 * rejected preflight is recorded as a failure with a null txHash, and treating
 * either as "we compounded" would suppress the backstop on a position that was
 * never actually touched.
 */
export function deriveLastCompounded(records: readonly AuditRecord[]): Map<string, number> {
  const byToken = new Map<string, number>();
  for (const record of records) {
    if (record.phase !== 'success') continue;
    if (record.action !== 'compound') continue;
    if (record.txHash === null) continue;
    const tokenId = record.snapshot?.['tokenId'];
    if (typeof tokenId !== 'string' || tokenId.length === 0) continue;
    const previous = byToken.get(tokenId);
    if (previous === undefined || record.timestamp > previous) byToken.set(tokenId, record.timestamp);
  }
  return byToken;
}
