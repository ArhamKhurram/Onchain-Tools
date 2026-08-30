import { describe, it, expect } from 'vitest';
import { buildRadar, MC_AT_CALL_MAX_LAG_MS } from '../src/components/callers/radarRows';
import type { CallerQuality } from '../src/hooks/useCallerQuality';
import type { ContractEntry } from '../src/types';

const T0 = Date.parse('2026-08-30T12:00:00Z');

function entry(overrides: Partial<ContractEntry>): ContractEntry {
  return {
    address: 'TokenAddrAAAA',
    chain: 'sol',
    authorId: 'a1',
    authorName: 'alice',
    channelId: 'chan-1',
    channelName: 'alpha',
    guildId: 'guild-1',
    guildName: 'g',
    roomIds: [],
    messageId: 'm1',
    timestamp: new Date(T0).toISOString(),
    ...overrides,
  };
}

describe('buildRadar', () => {
  it('groups mentions case-insensitively and aggregates callers/groups/timestamps', () => {
    const rows = buildRadar([
      entry({ messageId: 'm1', authorId: 'a1', guildId: 'g1' }),
      entry({ messageId: 'm2', address: 'tokenaddraaaa', authorId: 'a2', guildId: 'g2', timestamp: new Date(T0 + 60_000).toISOString() }),
      entry({ messageId: 'm3', address: 'OtherToken', authorId: 'a1', guildId: null, channelId: 'chan-9' }),
    ]);
    expect(rows).toHaveLength(2);
    const main = rows.find((r) => r.address === 'TokenAddrAAAA')!;
    expect(main.mentions).toBe(2);
    expect([...main.callers].sort()).toEqual(['a1', 'a2']);
    expect([...main.groups].sort()).toEqual(['g1', 'g2']);
    expect(main.firstSeenAt).toBe(T0);
    expect(main.lastMentionAt).toBe(T0 + 60_000);
    const other = rows.find((r) => r.address === 'OtherToken')!;
    expect([...other.groups]).toEqual(['chan-9']); // channel stands in when no guild
  });

  it('first caller is the earliest mention even when it arrives out of order', () => {
    const rows = buildRadar([
      entry({ authorName: 'late', timestamp: new Date(T0 + 120_000).toISOString() }),
      entry({ authorName: 'earliest', authorId: 'a0', timestamp: new Date(T0 - 300_000).toISOString() }),
    ]);
    expect(rows[0].firstCaller).toBe('earliest');
    expect(rows[0].firstSeenAt).toBe(T0 - 300_000);
  });

  it('takes MC@call from the earliest fdv-bearing mention within the lag window', () => {
    const rows = buildRadar([
      entry({ timestamp: new Date(T0).toISOString() }), // first seen, no fdv
      entry({ timestamp: new Date(T0 + 600_000).toISOString(), fdvAtCall: 50_000, fdvAtCallDisplay: '50.0K' }),
      entry({ timestamp: new Date(T0 + 700_000).toISOString(), fdvAtCall: 90_000, fdvAtCallDisplay: '90.0K' }),
    ]);
    expect(rows[0].mcAtCall).toBe(50_000);
    expect(rows[0].mcAtCallDisplay).toBe('50.0K');
  });

  it('leaves MC@call blank when the earliest fdv arrived past the lag window', () => {
    const rows = buildRadar([
      entry({ timestamp: new Date(T0).toISOString() }),
      entry({
        timestamp: new Date(T0 + MC_AT_CALL_MAX_LAG_MS + 1).toISOString(),
        fdvAtCall: 50_000,
        fdvAtCallDisplay: '50.0K',
      }),
    ]);
    expect(rows[0].mcAtCall).toBeUndefined();
    expect(rows[0].mcAtCallDisplay).toBeUndefined();
  });

  it('keeps the earliest timestamped Rick reading; timestamped beats untimestamped', () => {
    const rows = buildRadar([
      entry({ firstCallerName: 'noclock', firstCallMcapUsd: 10 }),
      entry({ firstCallerName: 'later', firstCallMcapUsd: 20, firstCallAt: new Date(T0 - 1_000).toISOString() }),
      entry({ firstCallerName: 'earliest', firstCallMcapUsd: 30, firstCallAt: new Date(T0 - 9_000).toISOString() }),
    ]);
    expect(rows[0].rickFirstCallerName).toBe('earliest');
    expect(rows[0].rickFirstCallMcapUsd).toBe(30);
    expect(rows[0].rickFirstCallAtMs).toBe(T0 - 9_000);
  });

  it('tracks best band/rank across callers and flags all-muted rows', () => {
    const quality = (c: ContractEntry): CallerQuality =>
      (c.authorId === 'mutedguy'
        ? { key: c.authorId, tier: 'muted', band: 'unrated', rank: -1 }
        : { key: c.authorId, tier: 'normal', band: 'gold', rank: 5 }) as CallerQuality;
    const rows = buildRadar(
      [
        entry({ authorId: 'mutedguy', authorName: 'mutedguy' }),
        entry({ authorId: 'star', timestamp: new Date(T0 + 1_000).toISOString() }),
        entry({ address: 'SlopToken', authorId: 'mutedguy', authorName: 'mutedguy' }),
      ],
      quality,
    );
    const main = rows.find((r) => r.address === 'TokenAddrAAAA')!;
    expect(main.allMuted).toBe(false);
    expect(main.bestBand).toBe('gold');
    expect(main.bestRank).toBe(5);
    expect(main.firstCallerBand).toBe('unrated'); // first caller's own band, not the best
    const slop = rows.find((r) => r.address === 'SlopToken')!;
    expect(slop.allMuted).toBe(true);
  });
});

describe('buildRadar identity reuse', () => {
  const feed = [
    entry({ messageId: 'm1', authorId: 'a1', timestamp: new Date(T0).toISOString() }),
    entry({ messageId: 'm2', authorId: 'a2', timestamp: new Date(T0 + 60_000).toISOString() }),
    entry({ messageId: 'm3', address: 'OtherToken', authorId: 'a1' }),
  ];

  it('returns the previous row objects when nothing visible changed', () => {
    const first = buildRadar(feed);
    const second = buildRadar(feed, undefined, first);
    expect(second).toHaveLength(first.length);
    for (const row of second) {
      expect(first).toContain(row); // same object, not a structural copy
    }
  });

  it('replaces only the touched row when one contract arrives', () => {
    const first = buildRadar(feed);
    const grown = [...feed, entry({ messageId: 'm4', authorId: 'a3', timestamp: new Date(T0 + 120_000).toISOString() })];
    const second = buildRadar(grown, undefined, first);
    const main = second.find((r) => r.address === 'TokenAddrAAAA')!;
    const other = second.find((r) => r.address === 'OtherToken')!;
    expect(first).not.toContain(main); // changed row: fresh object
    expect(first).toContain(other); // untouched row: same object
    expect(main.mentions).toBe(3);
  });

  it('replaces the row when enrichment lands (same mention count)', () => {
    const first = buildRadar(feed);
    const enriched = feed.map((c) =>
      c.messageId === 'm1' ? { ...c, tokenSymbol: 'NEW' } : c,
    );
    const second = buildRadar(enriched, undefined, first);
    const main = second.find((r) => r.address === 'TokenAddrAAAA')!;
    expect(first).not.toContain(main);
    expect(main.symbol).toBe('NEW');
  });

  it('reused output is projection-identical to a fresh build under fuzzing', () => {
    let seed = 777;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    const proj = (r: ReturnType<typeof buildRadar>[number]) => ({
      ...r,
      callers: r.callers.size,
      groups: r.groups.size,
    });
    let contracts = Array.from({ length: 120 }, (_, i) =>
      entry({
        address: `Tok${Math.floor(rnd() * 25)}`,
        messageId: `f${i}`,
        authorId: `a${Math.floor(rnd() * 10)}`,
        timestamp: new Date(T0 + Math.floor(rnd() * 3_600_000)).toISOString(),
        fdvAtCall: rnd() < 0.4 ? 1_000 + rnd() * 10_000 : undefined,
        fdvAtCallDisplay: rnd() < 0.4 ? '1K' : undefined,
      }),
    );
    let prev = buildRadar(contracts);
    for (let step = 0; step < 30; step++) {
      // Mutate the feed like the store does: append, enrich, or drop-oldest.
      const op = rnd();
      if (op < 0.5) {
        contracts = [...contracts, entry({
          address: `Tok${Math.floor(rnd() * 25)}`,
          messageId: `g${step}`,
          authorId: `a${Math.floor(rnd() * 10)}`,
          timestamp: new Date(T0 + Math.floor(rnd() * 3_600_000)).toISOString(),
        })];
      } else if (op < 0.8) {
        const i = Math.floor(rnd() * contracts.length);
        contracts = contracts.map((c, j) => (j === i ? { ...c, tokenSymbol: `S${step}` } : c));
      } else {
        contracts = contracts.slice(1);
      }
      const reused = buildRadar(contracts, undefined, prev);
      const fresh = buildRadar(contracts);
      const sortByAddr = (a: { address: string }, b: { address: string }) =>
        a.address.localeCompare(b.address);
      expect([...reused].sort(sortByAddr).map(proj)).toEqual(
        [...fresh].sort(sortByAddr).map(proj),
      );
      prev = reused;
    }
  });
});
