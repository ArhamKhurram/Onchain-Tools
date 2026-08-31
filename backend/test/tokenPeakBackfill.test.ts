import { describe, it, expect } from 'vitest';
import {
  pickBackfillTargets,
  clampLookbackDays,
} from '../src/alerts/tokenPeakBackfill.js';
import { collectSampleTargets, type SampleTarget } from '../src/alerts/tokenPeakSampler.js';
import type { ContractEntry } from '../src/utils/contractLog.js';

function target(address: string, over: Partial<SampleTarget> = {}): SampleTarget {
  return { address, chain: 'sol', ...over };
}

describe('pickBackfillTargets', () => {
  const targets = [target('AAA'), target('bbb'), target('0xCcc', { chain: 'evm', evmChain: 'base' })];

  it('skips tokens that already have a peak — the idempotency path', () => {
    const existing = new Map([
      ['aaa', 50_000],
      ['0xccc', 10_000],
    ]);
    const { toFetch, alreadySeeded } = pickBackfillTargets(targets, existing, false);
    expect(toFetch.map((t) => t.address)).toEqual(['bbb']);
    expect(alreadySeeded).toBe(2);
  });

  it('matches existing peaks case-insensitively', () => {
    const existing = new Map([['aaa', 1]]);
    const { toFetch } = pickBackfillTargets([target('AaA')], existing, false);
    expect(toFetch).toHaveLength(0);
  });

  it('fetches everything under force, without counting skips', () => {
    const existing = new Map([['aaa', 1], ['bbb', 1], ['0xccc', 1]]);
    const { toFetch, alreadySeeded } = pickBackfillTargets(targets, existing, true);
    expect(toFetch).toHaveLength(3);
    expect(alreadySeeded).toBe(0);
  });

  it('fetches everything when nothing is seeded yet', () => {
    const { toFetch, alreadySeeded } = pickBackfillTargets(targets, new Map(), false);
    expect(toFetch).toHaveLength(3);
    expect(alreadySeeded).toBe(0);
  });
});

describe('clampLookbackDays', () => {
  it('defaults junk to the standard window', () => {
    expect(clampLookbackDays(undefined)).toBe(90);
    expect(clampLookbackDays('nope')).toBe(90);
    expect(clampLookbackDays(-5)).toBe(90);
    expect(clampLookbackDays(0)).toBe(90);
  });

  it('clamps to the ceiling and floors fractional days', () => {
    expect(clampLookbackDays(10_000)).toBe(365);
    expect(clampLookbackDays(14.9)).toBe(14);
    expect(clampLookbackDays(30)).toBe(30);
  });
});

// The backfill reuses the sampler's target collection; pin the behaviors the
// backfill leans on so a sampler refactor can't silently break seeding.
describe('collectSampleTargets (as used by the backfill)', () => {
  function contract(over: Partial<ContractEntry>): ContractEntry {
    return {
      address: 'AAA',
      chain: 'sol',
      authorId: '1',
      authorName: 'x',
      channelId: 'c',
      channelName: 'c',
      guildId: 'g',
      guildName: 'g',
      messageId: 'm',
      timestamp: '2026-08-01T00:00:00.000Z',
      source: 'discord',
      ...over,
    } as ContractEntry;
  }

  it('dedupes by address and backfills a later-resolved evm chain', () => {
    const out = collectSampleTargets([
      contract({ address: '0xAbc', chain: 'evm', timestamp: '2026-08-01T00:00:00.000Z' }),
      contract({ address: '0xabc', chain: 'evm', evmChain: 'base', timestamp: '2026-07-31T00:00:00.000Z' }),
      contract({ address: 'SOLSOL', chain: 'sol' }),
    ]);
    expect(out).toHaveLength(2);
    const evm = out.find((t) => t.address.toLowerCase() === '0xabc');
    expect(evm?.evmChain).toBe('base');
  });
});

describe('resolveTargetsTtlMs', () => {
  it('defaults to 15 minutes and accepts overrides, including 0 to disable', async () => {
    const { resolveTargetsTtlMs } = await import('../src/alerts/tokenPeakSampler.js');
    const prev = process.env.TOKEN_PEAK_TARGETS_TTL_MS;
    try {
      delete process.env.TOKEN_PEAK_TARGETS_TTL_MS;
      expect(resolveTargetsTtlMs()).toBe(900_000);
      process.env.TOKEN_PEAK_TARGETS_TTL_MS = '60000';
      expect(resolveTargetsTtlMs()).toBe(60_000);
      process.env.TOKEN_PEAK_TARGETS_TTL_MS = '0';
      expect(resolveTargetsTtlMs()).toBe(0);
      process.env.TOKEN_PEAK_TARGETS_TTL_MS = 'junk';
      expect(resolveTargetsTtlMs()).toBe(900_000);
      process.env.TOKEN_PEAK_TARGETS_TTL_MS = '-5';
      expect(resolveTargetsTtlMs()).toBe(900_000);
    } finally {
      if (prev === undefined) delete process.env.TOKEN_PEAK_TARGETS_TTL_MS;
      else process.env.TOKEN_PEAK_TARGETS_TTL_MS = prev;
    }
  });
});
