// Persistent caller quality — the pure half.
//
// Scores used to be derived on read from the contract log, which rolls; a
// caller's record therefore only lasted as long as the log. The durable unit is
// now the CALL — one record per (caller, token) — and the board is folded back
// out of stored per-caller counts.
//
// That creates exactly one danger worth testing hard: two paths now produce a
// CallerScore, and they must not drift. The last block below asserts that
// equivalence directly.

import { describe, it, expect } from 'vitest';
import {
  foldCallerCalls,
  rateCall,
  scoreFromAggregate,
  splitCallerAggregates,
  buildCallerScores,
  isExcludedCallerKey,
  median,
  SLOP_MULTIPLE,
  MIN_RATED_CALLS,
  DEFAULT_EXCLUDED_CALLERS,
  type CallerAggregateRow,
  type CallerCall,
  type ContractEntry,
} from '@oct/shared';

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
    timestamp: '2026-07-29T12:00:00.000Z',
    source: 'discord',
    ...over,
  } as ContractEntry;
}

/**
 * A JS stand-in for `caller_quality_aggregate`, so the fold-back maths can be
 * tested without a database. It counts exactly what the SQL counts — rated
 * calls, hits at 2x and 5x, sub-slop calls, the median and the max — and
 * nothing else. Rates and bands are deliberately left to the shared code.
 */
function aggregate(
  calls: CallerCall[],
  peaks: Record<string, number>,
  roomId: string | null = null,
): CallerAggregateRow[] {
  const byCaller = new Map<string, CallerCall[]>();
  for (const call of calls) {
    const list = byCaller.get(call.callerKey);
    if (list) list.push(call);
    else byCaller.set(call.callerKey, [call]);
  }

  const out: CallerAggregateRow[] = [];
  for (const [key, group] of byCaller) {
    const multiples = group
      .map((c) => rateCall(c, peaks[c.address.toLowerCase()]))
      .flatMap((r) => (r ? [r.multiple] : []));
    const times = group.map((c) => new Date(c.timestamp).getTime()).sort((a, b) => a - b);
    out.push({
      key,
      displayName: group[group.length - 1].displayName,
      roomId,
      calls: group.length,
      rated: multiples.length,
      medianMultiple: median(multiples),
      bestMultiple: multiples.length ? Math.max(...multiples) : undefined,
      hits2x: multiples.filter((m) => m >= 2).length,
      hits5x: multiples.filter((m) => m >= 5).length,
      slopCount: multiples.filter((m) => m < SLOP_MULTIPLE).length,
      firstCallAt: new Date(times[0]).toISOString(),
      lastCallAt: new Date(times[times.length - 1]).toISOString(),
    });
  }
  return out;
}

describe('foldCallerCalls', () => {
  it('keeps one record per caller/token pair, at their earliest post', () => {
    const calls = foldCallerCalls([
      contract({ messageId: 'm2', timestamp: '2026-07-29T14:00:00.000Z', fdvAtCall: 90_000 }),
      contract({ messageId: 'm1', timestamp: '2026-07-29T12:00:00.000Z', fdvAtCall: 30_000 }),
      contract({ messageId: 'm3', timestamp: '2026-07-29T16:00:00.000Z', fdvAtCall: 200_000 }),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].timestamp).toBe('2026-07-29T12:00:00.000Z');
    // Spamming a CA must not raise the caller's MC@call to a later, higher one:
    // that would turn every repost into a cheaper denominator.
    expect(calls[0].fdvAtCall).toBe(30_000);
  });

  it('scores each caller against their OWN call, not the token\'s earliest', () => {
    const calls = foldCallerCalls([
      contract({ authorId: '1', authorName: 'early', timestamp: '2026-07-29T12:00:00.000Z', fdvAtCall: 10_000 }),
      contract({ authorId: '2', authorName: 'late', messageId: 'm2', timestamp: '2026-07-29T18:00:00.000Z', fdvAtCall: 100_000 }),
    ]);

    expect(calls).toHaveLength(2);
    expect(calls.find((c) => c.callerKey === 'discord:1')?.fdvAtCall).toBe(10_000);
    expect(calls.find((c) => c.callerKey === 'discord:2')?.fdvAtCall).toBe(100_000);
  });

  it('never borrows a later post\'s MC@call to fill an unpriced earliest one', () => {
    // MC@call is point-in-time. An earliest row that enrichment never priced
    // stays unrated rather than being scored against a different moment.
    const calls = foldCallerCalls([
      contract({ messageId: 'm1', timestamp: '2026-07-29T12:00:00.000Z' }),
      contract({ messageId: 'm2', timestamp: '2026-07-29T13:00:00.000Z', fdvAtCall: 50_000 }),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].fdvAtCall).toBeUndefined();
  });

  it('unions rooms and back-fills a resolved EVM chain across the pair\'s rows', () => {
    const addr = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const calls = foldCallerCalls([
      contract({ address: addr, chain: 'evm', roomIds: ['a'], messageId: 'm1', timestamp: '2026-07-29T12:00:00.000Z' }),
      contract({ address: addr, chain: 'evm', roomIds: ['b', 'a'], messageId: 'm2', timestamp: '2026-07-29T13:00:00.000Z', evmChain: 'base' }),
    ]);

    expect(calls).toHaveLength(1);
    expect([...calls[0].roomIds].sort()).toEqual(['a', 'b']);
    // The chain is a fact about the token that a later row may be the first to
    // resolve; unlike MC@call it isn't point-in-time.
    expect(calls[0].evmChain).toBe('base');
  });

  it('is case-insensitive on the address but keeps the posted casing', () => {
    const calls = foldCallerCalls([
      contract({ address: 'AbCdEf', messageId: 'm1', timestamp: '2026-07-29T12:00:00.000Z' }),
      contract({ address: 'abcdef', messageId: 'm2', timestamp: '2026-07-29T13:00:00.000Z' }),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].address).toBe('AbCdEf');
  });

  it('drops excluded authors and rows with no author', () => {
    const calls = foldCallerCalls([
      contract({ authorId: '9', authorName: 'Rick', messageId: 'm1' }),
      contract({ authorId: '', authorName: 'ghost', messageId: 'm2' }),
      contract({ authorId: '3', authorName: 'real', messageId: 'm3' }),
    ]);

    expect(calls.map((c) => c.callerKey)).toEqual(['discord:3']);
  });
});

describe('rateCall', () => {
  const base: CallerCall = {
    callerKey: 'discord:1',
    displayName: 'haider',
    address: 'abc',
    timestamp: '2026-07-29T12:00:00.000Z',
    roomIds: [],
  };

  it('rates peak over the caller\'s own MC@call', () => {
    expect(rateCall({ ...base, fdvAtCall: 25_000 }, 100_000)?.multiple).toBe(4);
  });

  it('floors a call that was itself the top at 1x, not below', () => {
    // A peak under the call means the sampler only ever saw it lower. That's a
    // flat call, not a negative one.
    expect(rateCall({ ...base, fdvAtCall: 100_000 }, 40_000)?.multiple).toBe(1);
  });

  it('declines to rate when either half is missing or non-positive', () => {
    expect(rateCall(base, 100_000)).toBeNull();
    expect(rateCall({ ...base, fdvAtCall: 0 }, 100_000)).toBeNull();
    expect(rateCall({ ...base, fdvAtCall: 25_000 }, undefined)).toBeNull();
    expect(rateCall({ ...base, fdvAtCall: 25_000 }, 0)).toBeNull();
  });
});

describe('scoreFromAggregate', () => {
  function row(over: Partial<CallerAggregateRow> = {}): CallerAggregateRow {
    return {
      key: 'discord:1',
      displayName: 'haider',
      calls: 20,
      rated: 20,
      medianMultiple: 2.5,
      bestMultiple: 30,
      hits2x: 12,
      hits5x: 4,
      slopCount: 4,
      ...over,
    };
  }

  it('turns stored counts into rates and a band', () => {
    const score = scoreFromAggregate(row(), 10);
    expect(score.rated).toBe(20);
    expect(score.hitRate2x).toBe(0.6);
    expect(score.hitRate5x).toBe(0.2);
    expect(score.slopRate).toBe(0.2);
    expect(score.band).toBe('elite');
    expect(score.callsPerDay).toBe(2);
  });

  it('stays unrated below the minimum sample even with a perfect record', () => {
    const score = scoreFromAggregate(
      row({ calls: MIN_RATED_CALLS - 1, rated: MIN_RATED_CALLS - 1, hits2x: MIN_RATED_CALLS - 1, hits5x: MIN_RATED_CALLS - 1, slopCount: 0 }),
      30,
    );
    expect(score.band).toBe('unrated');
  });

  it('reports no rates at all when nothing could be rated', () => {
    const score = scoreFromAggregate(row({ rated: 0, hits2x: 0, hits5x: 0, slopCount: 0 }), 30);
    expect(score.rated).toBe(0);
    expect(score.hitRate2x).toBeUndefined();
    expect(score.slopRate).toBeUndefined();
    expect(score.band).toBe('unrated');
    // Unrated calls are still calls — volume is known even when quality isn't.
    expect(score.calls).toBe(20);
  });

  it('omits a median or best that came back non-numeric', () => {
    const score = scoreFromAggregate(row({ medianMultiple: undefined, bestMultiple: undefined }), 30);
    expect(score.medianMultiple).toBeUndefined();
    expect(score.bestMultiple).toBeUndefined();
    // The band still stands: it's built from counts, not from the median.
    expect(score.band).toBe('elite');
  });

  it('clamps impossible counts rather than emitting a rate above 1', () => {
    // A hit count larger than the rated sample can only be corruption; a
    // hitRate2x of 3.0 would render as a plausible-looking 300%.
    const score = scoreFromAggregate(row({ rated: 10, hits2x: 30, slopCount: -5 }), 30);
    expect(score.hitRate2x).toBe(1);
    expect(score.slopRate).toBe(0);
  });

  it('never reports more rated calls than calls', () => {
    const score = scoreFromAggregate(row({ calls: 5, rated: 40 }), 30);
    expect(score.rated).toBe(5);
  });
});

describe('splitCallerAggregates', () => {
  const rows: CallerAggregateRow[] = [
    { key: 'discord:1', displayName: 'a', roomId: null, calls: 30, rated: 30, hits2x: 15, hits5x: 5, slopCount: 3, medianMultiple: 2.2, bestMultiple: 9, firstCallAt: '2026-06-01T00:00:00.000Z' },
    { key: 'discord:1', displayName: 'a', roomId: 'room-prosp', calls: 20, rated: 20, hits2x: 12, hits5x: 4, slopCount: 2, medianMultiple: 2.4, bestMultiple: 9, firstCallAt: '2026-06-05T00:00:00.000Z' },
    { key: 'discord:2', displayName: 'b', roomId: null, calls: 5, rated: 4, hits2x: 0, hits5x: 0, slopCount: 4, firstCallAt: '2026-05-01T00:00:00.000Z' },
    { key: 'discord:9', displayName: 'Rick', roomId: null, calls: 900, rated: 900, hits2x: 100, hits5x: 10, slopCount: 400, firstCallAt: '2026-01-01T00:00:00.000Z' },
  ];

  it('separates the global board from the per-room boards', () => {
    const out = splitCallerAggregates(rows, 30);
    expect(out.scores.map((s) => s.key)).toEqual(['discord:1', 'discord:2']);
    expect(Object.keys(out.roomScores)).toEqual(['room-prosp']);
    expect(out.roomScores['room-prosp'][0].rated).toBe(20);
  });

  it('drops excluded callers on read, so a new exclusion needs no rewrite', () => {
    const out = splitCallerAggregates(rows, 30);
    // Rick is a default exclusion and would otherwise top the board on volume.
    expect(out.scores.some((s) => s.displayName === 'Rick')).toBe(false);
    expect(out.callers).toBe(2);
  });

  it('honours an operator exclusion by caller key', () => {
    // `exclude` REPLACES the defaults rather than layering onto them — the
    // route merges `DEFAULT_EXCLUDED_CALLERS` in itself, so pass the merged
    // list here too or the known bots come back.
    const out = splitCallerAggregates(rows, 30, {
      exclude: [...DEFAULT_EXCLUDED_CALLERS, 'discord:1'],
    });
    expect(out.scores.map((s) => s.key)).toEqual(['discord:2']);
    // Room boards are filtered by the same rule, not just the global one.
    expect(out.roomScores['room-prosp']).toBeUndefined();
  });

  it('reports coverage from the oldest surviving call, ignoring excluded ones', () => {
    // Rick's 2026-01-01 row is older but excluded, so it must not be what the
    // console tells the operator the board reaches back to.
    const out = splitCallerAggregates(rows, 30);
    expect(out.coversFrom).toBe('2026-05-01T00:00:00.000Z');
  });

  it('orders both boards by depth of scoring sample, then volume', () => {
    const out = splitCallerAggregates(
      [
        { key: 'discord:a', displayName: 'a', calls: 99, rated: 2, hits2x: 0, hits5x: 0, slopCount: 0 },
        { key: 'discord:b', displayName: 'b', calls: 12, rated: 12, hits2x: 0, hits5x: 0, slopCount: 0 },
      ],
      30,
    );
    expect(out.scores.map((s) => s.key)).toEqual(['discord:b', 'discord:a']);
  });
});

describe('the persistent and derived paths agree', () => {
  // The whole risk of this change: two code paths now produce a CallerScore.
  // If they can disagree, a caller's band depends on which deployment mode
  // answered, which is worse than either answer alone.
  const peaks: Record<string, number> = {};
  const contracts: ContractEntry[] = [];

  // 14 calls from one caller across 14 tokens, spread over the quality range,
  // plus a repost of one of them and an unpriceable call.
  const multiples = [12, 8, 5.5, 4, 3, 2.4, 2, 1.9, 1.5, 1.3, 1.1, 1, 0.6, 0.2];
  multiples.forEach((m, i) => {
    const address = `Mint${i}`;
    const fdv = 20_000 + i * 1_000;
    peaks[address.toLowerCase()] = fdv * m;
    contracts.push(
      contract({
        address,
        authorId: '1',
        authorName: 'haider',
        messageId: `m${i}`,
        timestamp: new Date(Date.UTC(2026, 6, 1 + i, 12)).toISOString(),
        fdvAtCall: fdv,
      }),
    );
  });
  // A repost at a much lower cap: must not become a second, cheaper call.
  contracts.push(
    contract({
      address: 'Mint0',
      authorId: '1',
      authorName: 'haider',
      messageId: 'm-repost',
      timestamp: '2026-07-20T12:00:00.000Z',
      fdvAtCall: 500,
    }),
  );
  // A call nothing ever priced: counts as a call, never as a rated one.
  contracts.push(
    contract({ address: 'MintUnpriced', authorId: '1', authorName: 'haider', messageId: 'm-unpriced' }),
  );

  const derived = buildCallerScores(contracts, (a) => peaks[a.toLowerCase()], 30);
  const persistent = splitCallerAggregates(
    aggregate(foldCallerCalls(contracts), peaks),
    30,
  ).scores;

  it('produces identical scores for the same calls and peaks', () => {
    expect(persistent).toEqual(derived);
  });

  it('and that shared score is the one the sample actually supports', () => {
    const score = derived[0];
    expect(score.calls).toBe(15); // 14 priced + 1 unpriced; the repost is not a call
    expect(score.rated).toBe(14);
    expect(score.hitRate2x).toBeCloseTo(7 / 14, 10);
    expect(score.hitRate5x).toBeCloseTo(3 / 14, 10);
    // 1.1, 1, 0.6 and 0.2 all floor at or below SLOP_MULTIPLE — and the 0.6 and
    // 0.2 calls floor to exactly 1x rather than reading as losses.
    expect(score.slopRate).toBeCloseTo(4 / 14, 10);
    expect(score.bestMultiple).toBe(12);
  });
});

describe('isExcludedCallerKey', () => {
  it('matches a full caller key exactly', () => {
    expect(isExcludedCallerKey('discord:42', 'whoever', ['discord:42'])).toBe(true);
    expect(isExcludedCallerKey('discord:43', 'whoever', ['discord:42'])).toBe(false);
  });

  it('matches a display name whole, not as a substring', () => {
    expect(isExcludedCallerKey('discord:1', 'Rick', ['rick'])).toBe(true);
    // The reason name matching is exact: Patrick is a person.
    expect(isExcludedCallerKey('discord:1', 'Patrick', ['rick'])).toBe(false);
  });

  it('ignores decoration and blank entries', () => {
    expect(isExcludedCallerKey('discord:1', '✦ R I C K ✦', ['rick'])).toBe(true);
    expect(isExcludedCallerKey('discord:1', 'rick', ['  ', ''])).toBe(false);
  });
});
