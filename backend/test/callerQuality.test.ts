import { describe, it, expect } from 'vitest';
import {
  callerKey,
  parseCallerKey,
  contractCallerKey,
  resolveCallerTier,
  bandFromRates,
  scoreCaller,
  buildCallerScores,
  effectiveBand,
  callerRank,
  median,
  MIN_RATED_CALLS,
  type CallerTierEntry,
  type RatedCall,
} from '@oct/shared';
import type { ContractEntry } from '@oct/shared';

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

function ratedCalls(multiples: number[]): RatedCall[] {
  return multiples.map((multiple, i) => ({
    address: `addr${i}`,
    multiple,
    timestamp: '2026-07-29T12:00:00.000Z',
  }));
}

describe('caller keys', () => {
  it('round-trips', () => {
    expect(parseCallerKey(callerKey('telegram', '4242'))).toEqual({
      platform: 'telegram',
      authorId: '4242',
    });
  });

  it('rejects junk rather than coercing it', () => {
    expect(parseCallerKey('')).toBeNull();
    expect(parseCallerKey('nope:1')).toBeNull();
    expect(parseCallerKey('discord:')).toBeNull();
    expect(parseCallerKey(':123')).toBeNull();
  });

  it('keys Telegram contracts by platform even without an explicit source', () => {
    expect(contractCallerKey(contract({ source: undefined, messageId: 'tg_-100123_5' })))
      .toBe('telegram:1');
    expect(contractCallerKey(contract())).toBe('discord:1');
  });
});

describe('resolveCallerTier', () => {
  const entries: CallerTierEntry[] = [
    { key: 'discord:1', displayName: 'haider', tier: 'trusted' },
    { key: 'discord:1', displayName: 'haider', tier: 'muted', roomId: 'room-prosp' },
    { key: 'discord:2', displayName: 'owari', tier: 'trusted' },
  ];

  it('defaults to normal with no entries', () => {
    expect(resolveCallerTier(undefined, 'discord:1')).toBe('normal');
    expect(resolveCallerTier([], 'discord:1')).toBe('normal');
    expect(resolveCallerTier(entries, 'discord:99')).toBe('normal');
  });

  it('falls back to the global entry outside the scoped room', () => {
    expect(resolveCallerTier(entries, 'discord:1', ['room-other'])).toBe('trusted');
  });

  it('lets a room entry beat the global one', () => {
    expect(resolveCallerTier(entries, 'discord:1', ['room-prosp'])).toBe('muted');
  });

  // A contract can land in several rooms at once; a mute in any of them should
  // not be silently overridden by a trust in another.
  it('takes the most restrictive when several rooms match', () => {
    const multi: CallerTierEntry[] = [
      { key: 'discord:1', displayName: 'x', tier: 'trusted', roomId: 'a' },
      { key: 'discord:1', displayName: 'x', tier: 'muted', roomId: 'b' },
    ];
    expect(resolveCallerTier(multi, 'discord:1', ['a', 'b'])).toBe('muted');
  });
});

describe('bandFromRates', () => {
  it('stays unrated below the minimum sample', () => {
    expect(bandFromRates(MIN_RATED_CALLS - 1, 1, 0)).toBe('unrated');
  });

  it('bands by hit rate, demoted by slop', () => {
    expect(bandFromRates(20, 0.5, 0.2)).toBe('elite');
    expect(bandFromRates(20, 0.25, 0.5)).toBe('solid');
    expect(bandFromRates(20, 0.1, 0.7)).toBe('mixed');
    expect(bandFromRates(20, 0.3, 0.85)).toBe('slop');
    expect(bandFromRates(20, 0.0, 0.5)).toBe('slop');
  });

  // The whole point of the slop demotion: one lottery ticket shouldn't read elite.
  it('does not promote a high hit rate that is mostly slop', () => {
    expect(bandFromRates(20, 0.45, 0.5)).not.toBe('elite');
  });
});

describe('median', () => {
  it('handles odd, even, and empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeUndefined();
  });
});

describe('scoreCaller', () => {
  it('reports unrated with no scored calls but still counts them', () => {
    const score = scoreCaller('discord:1', 'haider', 7, [], 30);
    expect(score.calls).toBe(7);
    expect(score.rated).toBe(0);
    expect(score.band).toBe('unrated');
    expect(score.medianMultiple).toBeUndefined();
    expect(score.callsPerDay).toBeCloseTo(7 / 30);
  });

  it('computes rates over the scored sample', () => {
    const score = scoreCaller('discord:2', 'owari', 12, ratedCalls([1, 1.1, 2, 3, 6, 8, 1, 2, 4, 9]), 30);
    expect(score.rated).toBe(10);
    expect(score.hitRate2x).toBeCloseTo(0.7);
    expect(score.hitRate5x).toBeCloseTo(0.3);
    expect(score.slopRate).toBeCloseTo(0.3);
    expect(score.bestMultiple).toBe(9);
    expect(score.band).toBe('elite');
  });
});

describe('buildCallerScores', () => {
  const peaks = new Map<string, number>([
    ['aaa', 100_000],
    ['bbb', 10_000],
  ]);
  const peakFor = (addr: string) => peaks.get(addr.toLowerCase());

  it('attributes each caller against their own MC@call, not the token first call', () => {
    const scores = buildCallerScores(
      [
        contract({ address: 'aaa', authorId: '1', authorName: 'early', fdvAtCall: 10_000, messageId: 'm1' }),
        contract({ address: 'aaa', authorId: '2', authorName: 'late', fdvAtCall: 50_000, messageId: 'm2' }),
      ],
      peakFor,
      30,
    );
    const early = scores.find((s) => s.key === 'discord:1');
    const late = scores.find((s) => s.key === 'discord:2');
    expect(early?.medianMultiple).toBeCloseTo(10);
    expect(late?.medianMultiple).toBeCloseTo(2);
  });

  // Otherwise spamming the same CA inflates the sample a caller is judged on.
  it('counts a caller/token pair once no matter how often they post it', () => {
    const scores = buildCallerScores(
      [
        contract({ address: 'aaa', fdvAtCall: 10_000, messageId: 'm1', timestamp: '2026-07-29T12:00:00.000Z' }),
        contract({ address: 'aaa', fdvAtCall: 90_000, messageId: 'm2', timestamp: '2026-07-29T13:00:00.000Z' }),
        contract({ address: 'aaa', fdvAtCall: 95_000, messageId: 'm3', timestamp: '2026-07-29T14:00:00.000Z' }),
      ],
      peakFor,
      30,
    );
    expect(scores).toHaveLength(1);
    expect(scores[0].calls).toBe(1);
    expect(scores[0].rated).toBe(1);
    // Their earliest post is the call that counts.
    expect(scores[0].medianMultiple).toBeCloseTo(10);
  });

  it('counts calls it cannot rate without scoring them', () => {
    const scores = buildCallerScores(
      [
        contract({ address: 'aaa', fdvAtCall: 10_000, messageId: 'm1' }),
        contract({ address: 'ccc', fdvAtCall: 10_000, messageId: 'm2' }), // no peak
        contract({ address: 'ddd', messageId: 'm3' }), // no MC@call
      ],
      peakFor,
      30,
    );
    expect(scores[0].calls).toBe(3);
    expect(scores[0].rated).toBe(1);
  });

  // A call made at the top shouldn't read as a negative multiple.
  it('floors a peak below the call at 1x', () => {
    const scores = buildCallerScores(
      [contract({ address: 'bbb', fdvAtCall: 40_000, messageId: 'm1' })],
      peakFor,
      30,
    );
    expect(scores[0].medianMultiple).toBe(1);
  });

  it('ignores rows with no author', () => {
    expect(buildCallerScores([contract({ authorId: '' })], peakFor, 30)).toHaveLength(0);
  });
});

describe('effectiveBand + callerRank', () => {
  it('lets a manual tier override the earned band', () => {
    expect(effectiveBand('muted', 'elite')).toBe('slop');
    expect(effectiveBand('trusted', 'slop')).toBe('elite');
    expect(effectiveBand('normal', 'solid')).toBe('solid');
    expect(effectiveBand('normal', undefined)).toBe('unrated');
  });

  it('pins manual tiers outside the earned range', () => {
    expect(callerRank('trusted', 'slop')).toBeGreaterThan(callerRank('normal', 'elite'));
    expect(callerRank('muted', 'elite')).toBeLessThan(callerRank('normal', 'slop'));
  });

  it('orders the earned bands', () => {
    const ranks = (['slop', 'unrated', 'mixed', 'solid', 'elite'] as const).map((b) =>
      callerRank('normal', b),
    );
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});
