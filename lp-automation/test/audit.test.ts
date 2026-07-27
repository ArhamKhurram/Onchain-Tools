import { describe, it, expect } from 'vitest';
import {
  buildIntentRecord,
  buildOutcomeRecord,
  findUnresolved,
  parseLog,
  serializeRecord,
  summarize,
  type AuditRecord,
  type PendingAction,
} from '../src/audit/log.js';
import type { Decision } from '../src/types.js';

const decision = (over: Partial<Decision> = {}): Decision => ({
  action: 'compound',
  rule: 'compound.fees_vs_gas',
  reason: 'Unclaimed fees $42.10 exceed 2.0x gas cost $8.00',
  snapshot: { unclaimedFeesUsd: 42.1, gasCostUsd: 8 },
  ...over,
});

const pending = (over: Partial<PendingAction> = {}): PendingAction => ({
  id: 'act-1',
  decision: decision(),
  startedAt: 1_700_000_000_000,
  ...over,
});

describe('serializeRecord', () => {
  it('emits exactly one newline-terminated line so appends stay line-aligned', () => {
    const line = serializeRecord(buildIntentRecord(pending()));
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
  });

  it('round-trips through parseLog', () => {
    const record = buildIntentRecord(pending());
    const { records, malformed } = parseLog(serializeRecord(record));
    expect(malformed).toEqual([]);
    expect(records).toEqual([record]);
  });
});

describe('parseLog', () => {
  it('ignores blank lines', () => {
    const body = `${serializeRecord(buildIntentRecord(pending()))}\n   \n`;
    expect(parseLog(body).records).toHaveLength(1);
  });

  it('keeps good lines when one line is corrupt, and surfaces the corrupt one', () => {
    const good = serializeRecord(buildIntentRecord(pending()));
    const { records, malformed } = parseLog(`${good}{not json\n${good}`);
    expect(records).toHaveLength(2);
    expect(malformed).toEqual(['{not json']);
  });

  it('returns empty for an empty log rather than throwing', () => {
    expect(parseLog('')).toEqual({ records: [], malformed: [] });
  });
});

describe('buildIntentRecord / buildOutcomeRecord', () => {
  it('records intent with no tx hash and no error', () => {
    const record = buildIntentRecord(pending());
    expect(record.phase).toBe('intent');
    expect(record.txHash).toBeNull();
    expect(record.error).toBeNull();
    expect(record.timestamp).toBe(1_700_000_000_000);
  });

  it('preserves the decision snapshot verbatim — the log must explain the decision', () => {
    const record = buildIntentRecord(pending());
    expect(record.snapshot).toEqual({ unclaimedFeesUsd: 42.1, gasCostUsd: 8 });
    expect(record.rule).toBe('compound.fees_vs_gas');
  });

  it('merges outcome snapshot extras onto the decision snapshot', () => {
    const p = pending();
    const record = buildOutcomeRecord(
      p,
      { txHash: '0xabc', error: null },
      1_700_000_005_000,
      { gasSpentUsd: 0.05, valueUsd: 56 },
    );
    expect(record.snapshot).toMatchObject({
      unclaimedFeesUsd: 42.1,
      gasSpentUsd: 0.05,
      valueUsd: 56,
    });
  });

  it('marks a successful outcome and carries the tx hash', () => {
    const record = buildOutcomeRecord(pending(), { txHash: '0xabc', error: null }, 1_700_000_005_000);
    expect(record.phase).toBe('success');
    expect(record.txHash).toBe('0xabc');
    expect(record.timestamp).toBe(1_700_000_005_000);
  });

  it('marks failure whenever an error is present, even if a tx hash also is', () => {
    // A reverted transaction has both a hash and an error. It is a failure.
    const record = buildOutcomeRecord(pending(), { txHash: '0xabc', error: 'reverted' }, 1);
    expect(record.phase).toBe('failure');
    expect(record.txHash).toBe('0xabc');
  });

  it('ties the outcome to its intent by id', () => {
    const p = pending({ id: 'act-99' });
    expect(buildOutcomeRecord(p, { txHash: '0x1', error: null }, 1).id).toBe('act-99');
  });
});

describe('findUnresolved', () => {
  const intent = (id: string): AuditRecord => buildIntentRecord(pending({ id }));
  const outcome = (id: string): AuditRecord =>
    buildOutcomeRecord(pending({ id }), { txHash: '0x1', error: null }, 2);

  it('finds an intent that never got an outcome — a possible in-flight transaction', () => {
    const found = findUnresolved([intent('a'), outcome('a'), intent('b')]);
    expect(found.map((r) => r.id)).toEqual(['b']);
  });

  it('treats a failed outcome as resolving its intent', () => {
    const failed = buildOutcomeRecord(pending({ id: 'c' }), { txHash: null, error: 'boom' }, 2);
    expect(findUnresolved([intent('c'), failed])).toEqual([]);
  });

  it('resolves regardless of write order, since a crash can interleave appends', () => {
    expect(findUnresolved([outcome('d'), intent('d')])).toEqual([]);
  });

  it('returns empty for an empty log', () => {
    expect(findUnresolved([])).toEqual([]);
  });
});

describe('summarize', () => {
  it('counts outcomes, not intents, so one action is never counted twice', () => {
    const records = [
      buildIntentRecord(pending({ id: 'a' })),
      buildOutcomeRecord(pending({ id: 'a' }), { txHash: '0x1', error: null }, 2),
    ];
    expect(summarize(records).compound).toBe(1);
  });

  it('counts failures too — a failing rule must be visible, not hidden', () => {
    const records = [
      buildOutcomeRecord(pending({ id: 'a' }), { txHash: null, error: 'boom' }, 2),
      buildOutcomeRecord(pending({ id: 'b' }), { txHash: null, error: 'boom' }, 3),
    ];
    expect(summarize(records).compound).toBe(2);
  });

  it('reports zero for every action kind on an empty log', () => {
    expect(summarize([])).toEqual({
      enter: 0,
      increase: 0,
      decrease: 0,
      approve: 0,
      compound: 0,
      rebalance: 0,
      exit: 0,
      none: 0,
    });
  });

  it('separates action kinds', () => {
    const mk = (id: string, action: Decision['action']) =>
      buildOutcomeRecord(pending({ id, decision: decision({ action }) }), { txHash: '0x1', error: null }, 2);
    const counts = summarize([mk('a', 'compound'), mk('b', 'rebalance'), mk('c', 'rebalance')]);
    expect(counts.compound).toBe(1);
    expect(counts.rebalance).toBe(2);
    expect(counts.exit).toBe(0);
  });
});
