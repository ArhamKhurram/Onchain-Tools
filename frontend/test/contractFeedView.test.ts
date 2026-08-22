import { describe, it, expect } from 'vitest';
import {
  filterGoodCallerRows,
  filterTopCallerRows,
  groupHistoryOldestFirst,
  groupRank,
  groupSummaryItem,
  isProvenCaller,
  isTopCaller,
  isUnratedCaller,
  passesGoodCallerFilter,
  sortContractGroups,
  type FeedRowQuality,
} from '../src/utils/contractFeedView';
import { groupContractFeedByAddress } from '../src/utils/contractFeedGrouping';
import type { ContractEntry } from '../src/types';
import type { CallerBand, CallerTier } from '@oct/shared';

// The Contract Feed's filter + ordering rules. Two things these guard, both
// reported as bugs by a live tester:
//
//  - "good callers only" must not bury a brand-new caller (unrated is kept and
//    tagged, never dropped), and must cut the graded-and-found-wanting middle.
//  - Ranked ordering must not corrupt what a collapsed rescan group
//    summarises: the group's head stays its NEWEST scan whatever the sort.

let seq = 0;

function entry(overrides: Partial<ContractEntry> = {}): ContractEntry {
  seq += 1;
  return {
    address: '0xabc',
    chain: 'evm',
    authorId: `a${seq}`,
    authorName: 'author',
    channelId: 'c1',
    channelName: 'general',
    guildId: 'g1',
    guildName: 'guild',
    roomIds: ['room1'],
    messageId: `msg-${seq}`,
    timestamp: new Date('2026-08-16T12:00:00.000Z').toISOString(),
    ...overrides,
  };
}

function quality(band: CallerBand, tier: CallerTier = 'normal', rank = 0): FeedRowQuality {
  return { band, tier, rank };
}

function row(band: CallerBand, tier: CallerTier = 'normal', overrides: Partial<ContractEntry> = {}) {
  const rank = tier === 'trusted' ? 100 : tier === 'muted' ? -100 : { elite: 4, solid: 3, mixed: 2, unrated: 1, slop: 0 }[band];
  return { entry: entry(overrides), quality: quality(band, tier, rank) };
}

function minutesAgo(min: number): string {
  return new Date(Date.parse('2026-08-16T12:00:00.000Z') - min * 60_000).toISOString();
}

describe('good-caller predicates', () => {
  it('counts elite, solid and manually trusted callers as proven', () => {
    expect(isProvenCaller(quality('elite'))).toBe(true);
    expect(isProvenCaller(quality('solid'))).toBe(true);
    // effectiveBand already maps trusted -> elite; the tier check is belt and braces.
    expect(isProvenCaller(quality('elite', 'trusted'))).toBe(true);
    expect(isProvenCaller(quality('mixed'))).toBe(false);
    expect(isProvenCaller(quality('unrated'))).toBe(false);
    expect(isProvenCaller(quality('slop'))).toBe(false);
  });

  it('does not treat a muted caller as unrated, even though the band reads slop', () => {
    expect(isUnratedCaller(quality('slop', 'muted'))).toBe(false);
    expect(isUnratedCaller(quality('unrated'))).toBe(true);
  });

  it('lets unrated callers through the filter — a new sharp caller starts there', () => {
    expect(passesGoodCallerFilter(quality('unrated'))).toBe(true);
    expect(passesGoodCallerFilter(quality('mixed'))).toBe(false);
    expect(passesGoodCallerFilter(quality('slop'))).toBe(false);
    expect(passesGoodCallerFilter(quality('slop', 'muted'))).toBe(false);
  });
});

describe('top-caller filter (Top Callers Feed)', () => {
  it('admits only elite and manually-trusted callers', () => {
    // The "absolute best" — earned elite or a manual trust.
    expect(isTopCaller(quality('elite'))).toBe(true);
    expect(isTopCaller(quality('elite', 'trusted'))).toBe(true);
    // A trusted tier survives even if its band somehow read otherwise.
    expect(isTopCaller(quality('unrated', 'trusted'))).toBe(true);
  });

  it('is stricter than the good-callers filter — solid and unrated are OUT', () => {
    // The whole point of the pane is that it stays quiet, so anything short of
    // the top is excluded — including callers the "Hide slop" filter keeps.
    expect(isTopCaller(quality('solid'))).toBe(false);
    expect(isTopCaller(quality('unrated'))).toBe(false);
    expect(isTopCaller(quality('mixed'))).toBe(false);
    expect(isTopCaller(quality('slop'))).toBe(false);
    expect(isTopCaller(quality('slop', 'muted'))).toBe(false);
  });

  it('keeps only the top rows and counts what it held out', () => {
    const rows = [
      row('elite'),
      row('elite', 'trusted'),
      row('solid'),
      row('unrated'),
      row('mixed'),
      row('slop', 'muted'),
    ];
    const result = filterTopCallerRows(rows);
    expect(result.rows).toHaveLength(2);
    expect(result.hidden).toBe(4);
  });
});

describe('filterGoodCallerRows', () => {
  it('is a pass-through when disabled', () => {
    const rows = [row('slop'), row('mixed'), row('elite')];
    const result = filterGoodCallerRows(rows, false);
    expect(result.rows).toHaveLength(3);
    expect(result.hidden).toBe(0);
    expect(result.unratedShown).toBe(0);
  });

  it('keeps proven and unrated, drops mixed / slop / muted, and counts both sides', () => {
    const rows = [
      row('elite'),
      row('solid'),
      row('elite', 'trusted'),
      row('unrated'),
      row('unrated'),
      row('mixed'),
      row('slop'),
      row('slop', 'muted'),
    ];
    const result = filterGoodCallerRows(rows, true);
    expect(result.rows).toHaveLength(5);
    expect(result.unratedShown).toBe(2);
    expect(result.hidden).toBe(3);
  });
});

describe('group summary + ordering', () => {
  it('summarises a group by its newest scan even when the input is not time-ordered', () => {
    const items = [
      { entry: entry({ address: '0xAAA', timestamp: minutesAgo(9) }), quality: quality('elite', 'trusted', 100) },
      { entry: entry({ address: '0xAAA', timestamp: minutesAgo(0) }), quality: quality('unrated') },
    ];
    const [group] = groupContractFeedByAddress(items);
    expect(groupSummaryItem(group).entry.timestamp).toBe(minutesAgo(0));
    // Everything else, oldest-first, with the summary scan removed.
    expect(groupHistoryOldestFirst(group).map((i) => i.entry.timestamp)).toEqual([minutesAgo(9)]);
  });

  it('ranks a group by its best caller, not its head row', () => {
    const items = [
      { entry: entry({ address: '0xAAA', timestamp: minutesAgo(0) }), quality: quality('unrated', 'normal', 1) },
      { entry: entry({ address: '0xAAA', timestamp: minutesAgo(2) }), quality: quality('elite', 'trusted', 100) },
    ];
    const [group] = groupContractFeedByAddress(items);
    expect(groupRank(group)).toBe(100);
  });

  it('leaves feed order alone in recent mode and floats the best caller in ranked mode', () => {
    const items = [
      { entry: entry({ address: '0xAAA', timestamp: minutesAgo(0) }), quality: quality('unrated', 'normal', 1) },
      { entry: entry({ address: '0xBBB', timestamp: minutesAgo(5) }), quality: quality('elite', 'trusted', 100) },
      { entry: entry({ address: '0xCCC', timestamp: minutesAgo(9) }), quality: quality('solid', 'normal', 3) },
    ];
    const groups = groupContractFeedByAddress(items);

    expect(sortContractGroups(groups, 'recent').map((g) => g.address)).toEqual([
      '0xaaa',
      '0xbbb',
      '0xccc',
    ]);
    expect(sortContractGroups(groups, 'ranked').map((g) => g.address)).toEqual([
      '0xbbb',
      '0xccc',
      '0xaaa',
    ]);
  });

  it('breaks a ranked tie on the newest scan', () => {
    const items = [
      { entry: entry({ address: '0xAAA', timestamp: minutesAgo(30) }), quality: quality('solid', 'normal', 3) },
      { entry: entry({ address: '0xBBB', timestamp: minutesAgo(1) }), quality: quality('solid', 'normal', 3) },
    ];
    const groups = groupContractFeedByAddress(items);
    expect(sortContractGroups(groups, 'ranked').map((g) => g.address)).toEqual(['0xbbb', '0xaaa']);
  });

  it('does not mutate the groups it was handed', () => {
    const items = [
      { entry: entry({ address: '0xAAA', timestamp: minutesAgo(0) }), quality: quality('unrated', 'normal', 1) },
      { entry: entry({ address: '0xBBB', timestamp: minutesAgo(5) }), quality: quality('elite', 'normal', 4) },
    ];
    const groups = groupContractFeedByAddress(items);
    const before = groups.map((g) => g.address);
    sortContractGroups(groups, 'ranked');
    expect(groups.map((g) => g.address)).toEqual(before);
  });
});
