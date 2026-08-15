import { describe, it, expect } from 'vitest';
import {
  groupContractFeedByAddress,
  CONTRACT_RESCAN_GROUP_WINDOW_MS,
  type ContractFeedItem,
} from '../src/utils/contractFeedGrouping';
import type { ContractEntry } from '../src/types';

// The Contract Feed re-broadcasts the same address on every rescan
// (scheduleDexFallback), so a hot token can flood the feed with a dozen
// near-identical rows. These tests guard the pure grouping function that
// collapses that pile-up: same-address rows within the recency window merge
// into one group, everything else (different address, or a stale gap) stays
// separate, and the NEW badge survives onto a group that started NEW.

let seq = 0;

function entry(overrides: Partial<ContractEntry> = {}): ContractEntry {
  seq += 1;
  return {
    address: '0xabc',
    chain: 'evm',
    authorId: 'a1',
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

function item(overrides: Partial<ContractEntry> = {}): ContractFeedItem {
  return { entry: entry(overrides) };
}

function minutesAgo(min: number): string {
  return new Date(Date.parse('2026-08-16T12:00:00.000Z') - min * 60_000).toISOString();
}

describe('groupContractFeedByAddress', () => {
  it('collapses repeated same-address rescans within the window into one group', () => {
    const items = [
      item({ address: '0xAAA', timestamp: minutesAgo(0), firstSeen: false }),
      item({ address: '0xAAA', timestamp: minutesAgo(2), firstSeen: false }),
      item({ address: '0xAAA', timestamp: minutesAgo(9), firstSeen: false }),
    ];
    const groups = groupContractFeedByAddress(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(3);
    // Newest-first, matching input/feed order.
    expect(groups[0].items.map((i) => i.entry.timestamp)).toEqual(items.map((i) => i.entry.timestamp));
  });

  it('keeps different addresses in separate groups', () => {
    const items = [
      item({ address: '0xAAA', timestamp: minutesAgo(0) }),
      item({ address: '0xBBB', timestamp: minutesAgo(1) }),
      item({ address: '0xAAA', timestamp: minutesAgo(2) }),
    ];
    const groups = groupContractFeedByAddress(items);
    expect(groups).toHaveLength(2);
    expect(groups[0].address).toBe('0xaaa');
    expect(groups[0].items).toHaveLength(2);
    expect(groups[1].address).toBe('0xbbb');
    expect(groups[1].items).toHaveLength(1);
  });

  it('splits a same-address scan into a new group once the gap exceeds the window', () => {
    const items = [
      item({ address: '0xAAA', timestamp: minutesAgo(0) }),
      // A rescan hours later reads as a fresh burst, not part of the old one.
      item({ address: '0xAAA', timestamp: minutesAgo(180) }),
    ];
    const groups = groupContractFeedByAddress(items, CONTRACT_RESCAN_GROUP_WINDOW_MS);
    expect(groups).toHaveLength(2);
    expect(groups[0].items).toHaveLength(1);
    expect(groups[1].items).toHaveLength(1);
  });

  it('respects a custom window threshold', () => {
    const items = [
      item({ address: '0xAAA', timestamp: minutesAgo(0) }),
      item({ address: '0xAAA', timestamp: minutesAgo(10) }),
    ];
    expect(groupContractFeedByAddress(items, 5 * 60_000)).toHaveLength(2);
    expect(groupContractFeedByAddress(items, 15 * 60_000)).toHaveLength(1);
  });

  it('marks a group as hasNew when it contains the original NEW detection, even if the head is a rescan', () => {
    const items = [
      item({ address: '0xAAA', timestamp: minutesAgo(0), firstSeen: undefined }), // rescan (latest)
      item({ address: '0xAAA', timestamp: minutesAgo(1), firstSeen: true }), // original NEW
    ];
    const groups = groupContractFeedByAddress(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].hasNew).toBe(true);
  });

  it('a lone entry forms its own single-item group (renders same as an ungrouped row)', () => {
    const items = [item({ address: '0xAAA', firstSeen: true })];
    const groups = groupContractFeedByAddress(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(1);
    expect(groups[0].hasNew).toBe(true);
  });

  it('handles interleaved rows: the same address later in the list still merges into its earlier group', () => {
    const items = [
      item({ address: '0xAAA', timestamp: minutesAgo(0) }),
      item({ address: '0xBBB', timestamp: minutesAgo(0.5) }),
      item({ address: '0xCCC', timestamp: minutesAgo(1) }),
      item({ address: '0xAAA', timestamp: minutesAgo(3) }),
    ];
    const groups = groupContractFeedByAddress(items);
    expect(groups.map((g) => g.address)).toEqual(['0xaaa', '0xbbb', '0xccc']);
    expect(groups[0].items).toHaveLength(2);
  });
});
