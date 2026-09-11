// The caller-stats audit (2026-09-05) — three defects the Top Callers board
// shipped with, one describe block each.
//
// Kept beside callerQuality.test.ts rather than inside it because each block
// is anchored to a specific piece of production evidence (real dust readings,
// real provider disagreement, the real bot roster), and those numbers are the
// point of the tests: if someone raises the MC@call floor or removes the 1x
// floor, these are the rows that say what it would cost.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EXCLUDED_CALLERS,
  KNOWN_BOT_CALLERS,
  MIN_MC_AT_CALL,
  buildCallerScores,
  isUsableMarketCap,
  parseCallerKey,
  rateCall,
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

function call(fdvAtCall?: number): CallerCall {
  return {
    callerKey: 'discord:1',
    displayName: 'haider',
    address: 'aaa',
    fdvAtCall,
    timestamp: '2026-07-29T12:00:00.000Z',
    roomIds: [],
  };
}

// ---------------------------------------------------------------------------
// Defect 1 — a denominator that is not a market cap.
// ---------------------------------------------------------------------------
describe('MC@call floor', () => {
  // The exact prod rows. GMGN recorded $1.19 as MC@call (a real supply times a
  // price it had not indexed), and because bestMultiple is a max, that single
  // row became two callers' headline BEST at 26,959,682x.
  it('leaves a dust reading unrated rather than scoring it', () => {
    expect(rateCall(call(1.1935995), 18_185.953)).toBeNull();
    expect(rateCall(call(0.0237454), 4_689_727.3)).toBeNull();
    expect(rateCall(call(269), 56_173.688)).toBeNull();
  });

  // The floor exists to keep these. Sub-$2k calls whose peak agrees with the
  // reading are real micro-cap calls, and catching those early is the product;
  // a rounder floor at $5,000 would have discarded ~890 of them.
  it('still rates a legitimate small-cap call', () => {
    expect(rateCall(call(1_400), 1_416.72)?.multiple).toBeCloseTo(1.012, 3);
    expect(rateCall(call(MIN_MC_AT_CALL), 100_000)?.multiple).toBe(100);
    expect(rateCall(call(2_079.35), 56_477)?.multiple).toBeCloseTo(27.16, 2);
  });

  it('treats a refused reading exactly like a missing one — a call, not a rating', () => {
    const rows = [
      contract({ address: 'dust', authorId: '1', fdvAtCall: 1.19, messageId: 'm1' }),
      contract({ address: 'good', authorId: '1', fdvAtCall: 10_000, messageId: 'm2' }),
    ];
    const [score] = buildCallerScores(rows, () => 100_000, 30);
    expect(score.calls).toBe(2);
    expect(score.rated).toBe(1);
    expect(score.bestMultiple).toBe(10);
  });

  it('agrees with isUsableMarketCap on every edge', () => {
    expect(isUsableMarketCap(MIN_MC_AT_CALL)).toBe(true);
    expect(isUsableMarketCap(MIN_MC_AT_CALL - 0.01)).toBe(false);
    expect(isUsableMarketCap(0)).toBe(false);
    expect(isUsableMarketCap(-5_000)).toBe(false);
    expect(isUsableMarketCap(undefined)).toBe(false);
    expect(isUsableMarketCap(Number.NaN)).toBe(false);
    expect(isUsableMarketCap(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Defect 2 — the 1x floor, and what it does to the median.
// ---------------------------------------------------------------------------
describe('the 1x floor is a property of the measurement, not a bug', () => {
  // A peak is a high-water mark that starts at the call and only ever rises,
  // so a token that rugged keeps the peak it had when it was called. The 1.0x
  // is what "we cannot see downside" looks like, not a claim of break-even.
  it('reads a rug and a flat token identically — the peak store cannot tell them apart', () => {
    expect(rateCall(call(50_000), 50_000)?.multiple).toBe(1);
  });

  // Provider disagreement between the call's own reading and the peak store's
  // first sample runs to a couple of percent on prod ($2,200 call against a
  // $2,157 peak). Without the floor, that noise would render as a real loss.
  it('does not turn sampling noise into a fake sub-1x loss', () => {
    expect(rateCall(call(2_200), 2_157.495)?.multiple).toBe(1);
  });

  // The honest consequence, pinned down so nobody changes what MEDIAN means
  // without also changing what the board says it means.
  it('collapses the whole lower half of the distribution onto the floor', () => {
    const peaks = new Map<string, number>();
    const rows = [1, 2, 3, 4, 5].map((i) => {
      // Calls 1-3 went nowhere or to zero; 4-5 ran. The three are identical.
      peaks.set(`mint${i}`, i <= 3 ? 10_000 : 40_000);
      return contract({ address: `mint${i}`, authorId: '1', fdvAtCall: 10_000, messageId: `m${i}` });
    });
    const [score] = buildCallerScores(rows, (a) => peaks.get(a), 30);
    expect(score.medianMultiple).toBe(1);
    // slopRate is the stand-in the console now shows for the invisible downside.
    expect(score.slopRate).toBeCloseTo(0.6);
  });
});

// ---------------------------------------------------------------------------
// Defect 3 — scanner bots ranked as callers.
// ---------------------------------------------------------------------------
describe('scanner bots are not callers', () => {
  const bots: [string, string, string][] = [
    ['telegram:8436907499', 'TokenScan', 'tg_-100123_1'],
    ['telegram:7979852115', 'Cipher', 'tg_-100123_2'],
    ['telegram:7948422606', 'Ray Khaki | Wallet Tracker', 'tg_-100123_3'],
    ['discord:1530886531126923396', 'Fomo Alerts', 'm1'],
    ['discord:1445566018570293498', 'fomobot', 'm2'],
    ['discord:1527757006004293852', 'blue bot', 'm3'],
    ['discord:1539965210096443424', 'Raybot', 'm4'],
  ];

  it.each(bots)('keeps %s (%s) off the board by default', (key, name, messageId) => {
    const authorId = key.slice(key.indexOf(':') + 1);
    const scores = buildCallerScores(
      [
        contract({ address: 'aaa', authorId, authorName: name, messageId, fdvAtCall: 10_000 }),
        contract({ address: 'aaa', authorId: '1', authorName: 'haider', messageId: 'm-human', fdvAtCall: 10_000 }),
      ],
      () => 100_000,
      30,
    );
    expect(scores.map((s) => s.key)).toEqual(['discord:1']);
  });

  // The board sorts by the size of the scoring sample, so the reposters with
  // the most rows pinned themselves to the top permanently. That ordering is
  // fine once the reposters are not in the list.
  it('leaves the real caller first once the reposters are gone', () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, i) =>
        contract({
          address: `mint${i}`,
          authorId: '8436907499',
          authorName: 'TokenScan',
          messageId: `tg_-100123_${i}`,
          fdvAtCall: 10_000,
        }),
      ),
      ...Array.from({ length: 12 }, (_, i) =>
        contract({ address: `mint${i}`, authorId: '1', authorName: 'haider', messageId: `m${i}`, fdvAtCall: 10_000 }),
      ),
    ];
    const scores = buildCallerScores(rows, () => 100_000, 30);
    expect(scores[0].displayName).toBe('haider');
  });

  // Identified by id, so a person cannot inherit a bot's exclusion by name.
  it('does not exclude a human who happens to share a bot display name', () => {
    const scores = buildCallerScores(
      [contract({ address: 'aaa', authorId: '4242', authorName: 'Cipher', messageId: 'm1', fdvAtCall: 10_000 })],
      () => 100_000,
      30,
    );
    expect(scores.map((s) => s.key)).toEqual(['discord:4242']);
  });

  it('ships every default as a caller key, except Rick who has no known id', () => {
    for (const bot of KNOWN_BOT_CALLERS) {
      expect(bot.label.length).toBeGreaterThan(0);
      expect(bot.why.length).toBeGreaterThan(0);
      if (bot.entry !== 'rick') expect(parseCallerKey(bot.entry)).not.toBeNull();
    }
    expect(DEFAULT_EXCLUDED_CALLERS).toEqual(KNOWN_BOT_CALLERS.map((b) => b.entry));
  });
});
