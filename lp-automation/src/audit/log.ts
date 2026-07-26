// Append-only action log (LP_AUTOMATION_PLAN.md §10 step 6).
//
// Every autonomous action over real funds must leave a record that can be read
// back later without trusting the process that wrote it. Two properties matter
// more than convenience here:
//
//   1. Append-only. Nothing in this module updates or deletes a prior entry. A
//      correction is a NEW entry, never an edit — an audit log you can rewrite
//      is not evidence of anything.
//   2. Write-before-broadcast. The intent is recorded BEFORE the transaction is
//      sent, then a second entry records the outcome. If the process dies mid-
//      broadcast, the log still shows a transaction may be in flight. The
//      reverse order (log after success) loses exactly the case you most need
//      to investigate.
//
// Storage is local JSONL. It is deliberately not Supabase: the signer process
// should keep working — and keep recording — when the network or the database
// is unavailable, which is precisely when things go wrong.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ActionKind, AuditEntry, Decision } from '../types.js';

/** A pending action: recorded before broadcast, resolved after. */
export interface PendingAction {
  /** Correlates the intent entry with its outcome entry. */
  id: string;
  decision: Decision;
  startedAt: number;
}

export type AuditPhase = 'intent' | 'success' | 'failure';

/**
 * The on-disk record. Wider than `AuditEntry` because a log line needs to say
 * which phase it represents and which action it belongs to — an outcome entry
 * is meaningless without a link back to the intent it resolves.
 */
export interface AuditRecord extends AuditEntry {
  id: string;
  phase: AuditPhase;
}

/** Serialize one record as a single JSONL line. Pure — this is what tests assert on. */
export function serializeRecord(record: AuditRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Parse a JSONL log body. Malformed lines are returned separately rather than
 * thrown on or silently dropped: a corrupt line is itself a finding, and losing
 * the surrounding good lines to one bad one would be the worst outcome.
 */
export function parseLog(body: string): { records: AuditRecord[]; malformed: string[] } {
  const records: AuditRecord[] = [];
  const malformed: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as AuditRecord);
    } catch {
      malformed.push(trimmed);
    }
  }
  return { records, malformed };
}

/** Build the "about to do this" record. Pure. */
export function buildIntentRecord(pending: PendingAction): AuditRecord {
  return {
    id: pending.id,
    phase: 'intent',
    timestamp: pending.startedAt,
    action: pending.decision.action,
    rule: pending.decision.rule,
    reason: pending.decision.reason,
    snapshot: pending.decision.snapshot,
    txHash: null,
    error: null,
  };
}

/** Build the "here is what happened" record. Pure. */
export function buildOutcomeRecord(
  pending: PendingAction,
  outcome: { txHash: string | null; error: string | null },
  now: number,
): AuditRecord {
  return {
    id: pending.id,
    phase: outcome.error ? 'failure' : 'success',
    timestamp: now,
    action: pending.decision.action,
    rule: pending.decision.rule,
    reason: pending.decision.reason,
    snapshot: pending.decision.snapshot,
    txHash: outcome.txHash,
    error: outcome.error,
  };
}

/**
 * Find actions that were logged as intent but never resolved. On startup this
 * is the first thing to check: an unresolved intent means a transaction may
 * have been broadcast without its outcome recorded, and the chain — not this
 * log — is the source of truth for what actually happened. Pure.
 */
export function findUnresolved(records: AuditRecord[]): AuditRecord[] {
  const resolved = new Set<string>();
  for (const r of records) {
    if (r.phase !== 'intent') resolved.add(r.id);
  }
  return records.filter((r) => r.phase === 'intent' && !resolved.has(r.id));
}

/** Counts per action kind, for the dashboard and the daily backstop sweep. Pure. */
export function summarize(records: AuditRecord[]): Record<ActionKind, number> {
  const counts: Record<ActionKind, number> = {
    enter: 0,
    compound: 0,
    rebalance: 0,
    exit: 0,
    none: 0,
  };
  for (const r of records) {
    if (r.phase === 'intent') continue; // count outcomes, not intents, to avoid double-counting
    counts[r.action] = (counts[r.action] ?? 0) + 1;
  }
  return counts;
}

/** Append-only JSONL audit log. The only I/O in this module. */
export class AuditLog {
  constructor(private readonly filePath: string) {}

  private async append(record: AuditRecord): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, serializeRecord(record), 'utf8');
  }

  /**
   * Record intent. Await this BEFORE broadcasting — if the write fails, do not
   * broadcast. An unlogged transaction over real funds is worse than a missed
   * opportunity, and this is the one place where failing closed is correct.
   */
  async recordIntent(pending: PendingAction): Promise<void> {
    await this.append(buildIntentRecord(pending));
  }

  /** Record the outcome of a previously-recorded intent. */
  async recordOutcome(
    pending: PendingAction,
    outcome: { txHash: string | null; error: string | null },
    now: number,
  ): Promise<void> {
    await this.append(buildOutcomeRecord(pending, outcome, now));
  }

  /**
   * Record an evaluation tick that produced no action. The plan requires
   * logging the score and its inputs at EVERY tick, not just at trigger time —
   * a rule that never fires is indistinguishable from a broken rule otherwise.
   */
  async recordEvaluation(decision: Decision, id: string, now: number): Promise<void> {
    await this.append({
      id,
      phase: 'success',
      timestamp: now,
      action: decision.action,
      rule: decision.rule,
      reason: decision.reason,
      snapshot: decision.snapshot,
      txHash: null,
      error: null,
    });
  }

  async read(): Promise<{ records: AuditRecord[]; malformed: string[] }> {
    try {
      return parseLog(await readFile(this.filePath, 'utf8'));
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { records: [], malformed: [] };
      throw err;
    }
  }
}
