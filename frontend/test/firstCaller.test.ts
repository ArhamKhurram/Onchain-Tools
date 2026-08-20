import { describe, it, expect } from 'vitest';
import { buildFirstCallerIndex, firstCallerIsElsewhere } from '../src/utils/firstCaller';
import { canOpenContractSource } from '../src/utils/contractSource';
import type { ContractEntry } from '../src/types';

// "Open the message where this CA was first called." The interesting part is
// what the console is allowed to CLAIM: only a row the backend flagged
// firstSeen is genuinely the first detection; anything else is just the
// earliest row still loaded. And a Telegram row in a plain group has no
// shareable URL at all, so it can't be a destination.

let seq = 0;

function entry(overrides: Partial<ContractEntry> = {}): ContractEntry {
  seq += 1;
  return {
    address: '0xAAA',
    chain: 'evm',
    authorId: `a${seq}`,
    authorName: `caller${seq}`,
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

function minutesAgo(min: number): string {
  return new Date(Date.parse('2026-08-16T12:00:00.000Z') - min * 60_000).toISOString();
}

describe('canOpenContractSource', () => {
  it('is always true for Discord rows', () => {
    expect(canOpenContractSource(entry())).toBe(true);
  });

  it('is true for a Telegram supergroup message and false for anything else', () => {
    expect(canOpenContractSource(entry({ source: 'telegram', messageId: 'tg_-1001234_55' }))).toBe(true);
    expect(canOpenContractSource(entry({ source: 'telegram', messageId: 'tg_44556_9' }))).toBe(false);
    expect(canOpenContractSource(entry({ source: 'telegram', messageId: 'tg_broken' }))).toBe(false);
  });
});

describe('buildFirstCallerIndex', () => {
  it('claims "first" only when the earliest row was the address first detection', () => {
    const first = entry({ timestamp: minutesAgo(60), firstSeen: true, authorName: 'earlybird' });
    const later = entry({ timestamp: minutesAgo(2), firstSeen: false });
    const index = buildFirstCallerIndex([later, first]);

    const resolved = index.get('0xaaa');
    expect(resolved?.entry.authorName).toBe('earlybird');
    expect(resolved?.isFirstLogged).toBe(true);
    expect(resolved?.skippedUnlinkable).toBe(false);
  });

  it('falls back to "earliest in view" when the oldest row we hold is itself a rescan', () => {
    // The true first call has aged out of the log, so every row is firstSeen:false.
    const index = buildFirstCallerIndex([
      entry({ timestamp: minutesAgo(2), firstSeen: false }),
      entry({ timestamp: minutesAgo(90), firstSeen: false, authorName: 'oldest-held' }),
    ]);
    const resolved = index.get('0xaaa');
    expect(resolved?.entry.authorName).toBe('oldest-held');
    expect(resolved?.isFirstLogged).toBe(false);
  });

  it('skips past an earlier row that cannot produce a link, and says it did', () => {
    const unlinkable = entry({
      timestamp: minutesAgo(90),
      firstSeen: true,
      source: 'telegram',
      messageId: 'tg_44556_9',
      authorName: 'tg-private',
    });
    const linkable = entry({ timestamp: minutesAgo(30), authorName: 'discord-caller' });
    const index = buildFirstCallerIndex([linkable, unlinkable]);

    const resolved = index.get('0xaaa');
    expect(resolved?.entry.authorName).toBe('discord-caller');
    expect(resolved?.earliest.authorName).toBe('tg-private');
    expect(resolved?.skippedUnlinkable).toBe(true);
    // Not the earliest row, so it must not claim to be the first call.
    expect(resolved?.isFirstLogged).toBe(false);
  });

  it('omits an address entirely when nothing about it is linkable', () => {
    const index = buildFirstCallerIndex([
      entry({ source: 'telegram', messageId: 'tg_44556_9' }),
      entry({ source: 'telegram', messageId: 'tg_44556_10' }),
    ]);
    expect(index.has('0xaaa')).toBe(false);
  });

  it('keys case-insensitively and keeps addresses apart', () => {
    const index = buildFirstCallerIndex([
      entry({ address: '0xAAA', timestamp: minutesAgo(1) }),
      entry({ address: '0xaaa', timestamp: minutesAgo(50), authorName: 'same-token-earlier' }),
      entry({ address: '0xBBB', timestamp: minutesAgo(5) }),
    ]);
    expect(index.size).toBe(2);
    expect(index.get('0xaaa')?.entry.authorName).toBe('same-token-earlier');
  });
});

describe('firstCallerIsElsewhere', () => {
  it('is false when the resolved first call is the row you already clicked', () => {
    const only = entry({ firstSeen: true });
    const index = buildFirstCallerIndex([only]);
    expect(firstCallerIsElsewhere(index.get('0xaaa'), only)).toBe(false);
  });

  it('is true when the first call is a different message', () => {
    const first = entry({ timestamp: minutesAgo(60), firstSeen: true });
    const clicked = entry({ timestamp: minutesAgo(1) });
    const index = buildFirstCallerIndex([clicked, first]);
    expect(firstCallerIsElsewhere(index.get('0xaaa'), clicked)).toBe(true);
  });

  it('is false when there is no resolution at all', () => {
    expect(firstCallerIsElsewhere(undefined, entry())).toBe(false);
  });
});
