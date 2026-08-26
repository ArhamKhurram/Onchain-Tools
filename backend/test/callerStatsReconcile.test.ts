// The caller-stats reconcile pass — what it costs, and who it must not miss.
//
// The pass used to walk every REGISTERED user on a 5-minute timer, spending a
// getConfig and a getContracts on each one whether or not they had scanned
// anything. The lookback bounds the ROWS each query returns, not the NUMBER of
// queries, so the timer's cost tracked sign-ups rather than usage.
//
// The narrowing is only safe because the pass already does nothing for a user
// whose contract window is empty. These tests pin both halves of that claim:
// the queries really are skipped, and the OUTCOME for every user is byte-for-
// byte what the un-narrowed pass produced.

import { describe, it, expect } from 'vitest';
import type { ContractEntry } from '@oct/shared';
import {
  runReconcilePass,
  type ReconcilePassDeps,
} from '../src/callers/callerStatsRecorder.js';

const SINCE = '2026-08-25T00:00:00.000Z';

function contract(over: Partial<ContractEntry> = {}): ContractEntry {
  return {
    address: 'So11111111111111111111111111111111111111112',
    chain: 'sol',
    authorId: '1',
    authorName: 'haider',
    channelId: 'c1',
    channelName: 'prosp',
    guildId: 'g1',
    guildName: 'guild',
    roomIds: ['room-prosp'],
    messageId: 'm1',
    timestamp: '2026-08-25T12:00:00.000Z',
    source: 'discord',
    ...over,
  } as ContractEntry;
}

interface Harness {
  deps: ReconcilePassDeps;
  /** Every Supabase round-trip the pass made, in order. */
  queries: string[];
  written: { userId: string; callers: string[] }[];
}

/**
 * A fake backend holding `rows` per user.
 *
 * `narrow` models the two states the real roster resolver can be in: true is
 * the `caller_stats_active_users` RPC answering (one round-trip, already
 * filtered), false is the fallback the code takes when that RPC is missing or
 * failing — i.e. the old behaviour, which is what the "before" numbers below
 * are measured against.
 */
function harness(rows: Record<string, ContractEntry[]>, narrow: boolean): Harness {
  const registered = Object.keys(rows);
  const queries: string[] = [];
  const written: { userId: string; callers: string[] }[] = [];

  return {
    queries,
    written,
    deps: {
      async roster(since) {
        if (!narrow) {
          queries.push('user_configs');
          return registered;
        }
        queries.push('caller_stats_active_users');
        return registered.filter((id) =>
          (rows[id] ?? []).some((c) => c.timestamp > since),
        );
      },
      async getConfig(userId) {
        queries.push(`getConfig:${userId}`);
        return {};
      },
      async getContracts(userId, _limit, since) {
        queries.push(`getContracts:${userId}`);
        return (rows[userId] ?? []).filter((c) => c.timestamp > since);
      },
      async recordCalls(userId, calls) {
        queries.push(`recordCalls:${userId}`);
        written.push({ userId, callers: calls.map((c) => c.callerKey).sort() });
      },
    },
  };
}

/** 62 registered users, 13 of whom have scanned inside the lookback window. */
function alphaRoster(): Record<string, ContractEntry[]> {
  const rows: Record<string, ContractEntry[]> = {};
  for (let i = 0; i < 62; i++) {
    rows[`user-${i}`] = i < 13 ? [contract({ authorId: String(i), messageId: `m${i}` })] : [];
  }
  return rows;
}

describe('reconcile pass cost', () => {
  it('spent two round-trips per REGISTERED user before the narrowing', async () => {
    const h = harness(alphaRoster(), false);
    await runReconcilePass(SINCE, h.deps);

    // 1 roster + 62 getConfig + 62 getContracts + 13 recordCalls.
    expect(h.queries.filter((q) => q.startsWith('getConfig:'))).toHaveLength(62);
    expect(h.queries.filter((q) => q.startsWith('getContracts:'))).toHaveLength(62);
    expect(h.queries).toHaveLength(138);
  });

  it('spends them per ACTIVE user after it', async () => {
    const h = harness(alphaRoster(), true);
    await runReconcilePass(SINCE, h.deps);

    // 1 roster + 13 getConfig + 13 getContracts + 13 recordCalls.
    expect(h.queries.filter((q) => q.startsWith('getConfig:'))).toHaveLength(13);
    expect(h.queries.filter((q) => q.startsWith('getContracts:'))).toHaveLength(13);
    expect(h.queries).toHaveLength(40);

    // The 49 dormant accounts cost nothing at all — not even one query.
    for (let i = 13; i < 62; i++) {
      expect(h.queries.some((q) => q.endsWith(`:user-${i}`))).toBe(false);
    }
  });

  it('costs the same at 62 registered users as at 620, given the same 13 active', async () => {
    const small = alphaRoster();
    const large: Record<string, ContractEntry[]> = { ...small };
    for (let i = 62; i < 620; i++) large[`user-${i}`] = [];

    const a = harness(small, true);
    const b = harness(large, true);
    await runReconcilePass(SINCE, a.deps);
    await runReconcilePass(SINCE, b.deps);

    // The whole point of the fix: the cost curve is flat in registrations.
    expect(b.queries.length).toBe(a.queries.length);
  });

  it('falls back to the full roster when the narrowing is unavailable', async () => {
    // An un-applied migration must leave the sweep correct, just expensive.
    const rows = alphaRoster();
    const wide = harness(rows, false);
    const narrow = harness(rows, true);
    await runReconcilePass(SINCE, wide.deps);
    await runReconcilePass(SINCE, narrow.deps);

    expect(wide.queries[0]).toBe('user_configs');
    expect(narrow.queries[0]).toBe('caller_stats_active_users');
    // Same writes either way — the fallback is a cost difference, not a
    // behaviour difference.
    expect(wide.written).toEqual(narrow.written);
  });
});

describe('reconcile pass correctness', () => {
  it('produces identical writes narrowed and un-narrowed', async () => {
    const rows: Record<string, ContractEntry[]> = {
      busy: [
        contract({ authorId: '1', authorName: 'a', messageId: 'm1' }),
        contract({ authorId: '2', authorName: 'b', messageId: 'm2', address: 'Mint2' }),
      ],
      quiet: [],
      // Only rows OLDER than the cutoff: the sweep can do nothing for them
      // either way, which is exactly why skipping them is safe.
      stale: [contract({ authorId: '3', timestamp: '2026-08-01T00:00:00.000Z' })],
    };

    const wide = harness(rows, false);
    const narrow = harness(rows, true);
    await runReconcilePass(SINCE, wide.deps);
    await runReconcilePass(SINCE, narrow.deps);

    expect(wide.written).toEqual([{ userId: 'busy', callers: ['discord:1', 'discord:2'] }]);
    expect(narrow.written).toEqual(wide.written);
  });

  it('picks a dormant user up on the very next pass once they scan', async () => {
    const rows: Record<string, ContractEntry[]> = { sleeper: [] };

    // Pass 1 — dormant. Not one query is spent on them.
    const p1 = harness(rows, true);
    await runReconcilePass(SINCE, p1.deps);
    expect(p1.queries).toEqual(['caller_stats_active_users']);
    expect(p1.written).toEqual([]);

    // They come back and scan one contract.
    rows.sleeper = [contract({ authorId: '7', authorName: 'sleeper', messageId: 'm7' })];

    // Pass 2 — the roster question is re-asked from scratch every pass, so
    // there is no watermark to have gone stale. They are back immediately.
    const p2 = harness(rows, true);
    await runReconcilePass(SINCE, p2.deps);
    expect(p2.queries).toEqual([
      'caller_stats_active_users',
      'getConfig:sleeper',
      'getContracts:sleeper',
      'recordCalls:sleeper',
    ]);
    expect(p2.written).toEqual([{ userId: 'sleeper', callers: ['discord:7'] }]);
  });

  it('keeps re-folding an active user, so late enrichment still lands', async () => {
    // The sweep's other job: a row is logged BEFORE enrichment prices it, and
    // the re-read minutes later is what fills MC@call in. The narrowing must
    // not cut that off — the user still has a row in the window, so they stay
    // on the roster and get re-swept with the now-priced value.
    const rows: Record<string, ContractEntry[]> = {
      scanner: [contract({ authorId: '5', messageId: 'm5' })],
    };

    const p1 = harness(rows, true);
    await runReconcilePass(SINCE, p1.deps);
    expect(p1.written).toEqual([{ userId: 'scanner', callers: ['discord:5'] }]);

    rows.scanner = [contract({ authorId: '5', messageId: 'm5', fdvAtCall: 30_000 })];

    const p2 = harness(rows, true);
    await runReconcilePass(SINCE, p2.deps);
    expect(p2.queries).toContain('getContracts:scanner');
    expect(p2.written).toEqual([{ userId: 'scanner', callers: ['discord:5'] }]);
  });

  it('lets one user\'s failure not stop the rest of the pass', async () => {
    const rows: Record<string, ContractEntry[]> = {
      broken: [contract({ authorId: '1', messageId: 'm1' })],
      fine: [contract({ authorId: '2', messageId: 'm2' })],
    };
    const h = harness(rows, true);
    const inner = h.deps.getContracts.bind(h.deps);
    h.deps.getContracts = async (userId, limit, since) => {
      if (userId === 'broken') throw new Error('boom');
      return inner(userId, limit, since);
    };

    await runReconcilePass(SINCE, h.deps);
    expect(h.written).toEqual([{ userId: 'fine', callers: ['discord:2'] }]);
  });
});
