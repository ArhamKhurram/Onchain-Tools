import { describe, expect, it } from 'vitest';
import {
  buildMissedRunnerAlertRow,
  buildTokenCandidates,
  type TokenCandidate,
} from '../src/alerts/missedRunnerPoller.js';
import type { ContractEntry } from '../src/utils/contractLog.js';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');

function candidate(overrides: Partial<TokenCandidate> = {}): TokenCandidate {
  return {
    address: '0xAbCdEf1234567890abcdef1234567890ABCDEF12',
    chain: 'evm',
    evmChain: 'base',
    mcAtCall: 50_000,
    tokenSymbol: 'TEST',
    channelName: 'alpha-calls',
    firstSeenAt: '2026-07-29T10:00:00.000Z',
    ...overrides,
  };
}

function entry(overrides: Partial<ContractEntry>): ContractEntry {
  return {
    address: 'So11111111111111111111111111111111111111112',
    chain: 'sol',
    authorId: 'a1',
    authorName: 'caller',
    channelId: 'c1',
    channelName: 'alpha',
    guildId: null,
    guildName: null,
    roomIds: [],
    messageId: 'm1',
    timestamp: '2026-07-29T10:00:00.000Z',
    firstSeen: true,
    ...overrides,
  } as ContractEntry;
}

describe('buildMissedRunnerAlertRow', () => {
  // The unique key (user_id, token_address) and the table's lowercase CHECK
  // both assume normalized addresses — a mixed-case write would violate the
  // constraint and the upsert would stop matching the existing row.
  it('lowercases the token address', () => {
    const row = buildMissedRunnerAlertRow('u1', candidate(), 100_000, 2, 24, NOW);
    expect(row.token_address).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
  });

  it('computes cooldown_until from cooldownHours', () => {
    const row = buildMissedRunnerAlertRow('u1', candidate(), 100_000, 2, 24, NOW);
    expect(row.triggered_at).toBe('2026-07-29T12:00:00.000Z');
    expect(row.cooldown_until).toBe('2026-07-30T12:00:00.000Z');
  });

  it('refreshing after cooldown produces a later cooldown_until than the original', () => {
    const first = buildMissedRunnerAlertRow('u1', candidate(), 100_000, 2, 24, NOW);
    const later = NOW + 25 * 3_600_000; // past the 24h cooldown
    const second = buildMissedRunnerAlertRow('u1', candidate(), 300_000, 6, 24, later);
    expect(Date.parse(second.cooldown_until)).toBeGreaterThan(Date.parse(first.cooldown_until));
    expect(second.mc_now).toBe(300_000);
    expect(second.multiplier).toBe(6);
  });

  it('nulls optional channel/symbol fields', () => {
    const row = buildMissedRunnerAlertRow(
      'u1',
      candidate({ tokenSymbol: undefined, channelName: undefined }),
      100_000,
      2,
      24,
      NOW,
    );
    expect(row.channel_name).toBeNull();
    expect(row.token_symbol).toBeNull();
  });
});

describe('buildTokenCandidates', () => {
  it('takes MC@call from the earliest entry that has one, and firstSeenAt from the earliest scan', () => {
    const addr = 'So11111111111111111111111111111111111111112';
    const candidates = buildTokenCandidates([
      // First scan had no FDV (Rick often omits it on the first row).
      entry({ address: addr, messageId: 'm1', timestamp: '2026-07-29T10:00:00.000Z' }),
      entry({
        address: addr,
        messageId: 'm2',
        timestamp: '2026-07-29T10:05:00.000Z',
        fdvAtCall: 40_000,
        fdvAtCallDisplay: '40K',
      }),
      entry({
        address: addr,
        messageId: 'm3',
        timestamp: '2026-07-29T11:00:00.000Z',
        fdvAtCall: 90_000,
      }),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].mcAtCall).toBe(40_000);
    expect(candidates[0].mcAtCallDisplay).toBe('40K');
    expect(candidates[0].firstSeenAt).toBe('2026-07-29T10:00:00.000Z');
  });

  it('groups case-insensitively by address', () => {
    const candidates = buildTokenCandidates([
      entry({
        address: '0xABCDEF1234567890abcdef1234567890abcdef12',
        chain: 'evm',
        messageId: 'm1',
        fdvAtCall: 10_000,
      }),
      entry({
        address: '0xabcdef1234567890abcdef1234567890abcdef12',
        chain: 'evm',
        messageId: 'm2',
        timestamp: '2026-07-29T11:00:00.000Z',
        fdvAtCall: 20_000,
      }),
    ]);
    expect(candidates).toHaveLength(1);
  });

  it('drops tokens with no MC@call at all', () => {
    expect(buildTokenCandidates([entry({ messageId: 'm1' })])).toHaveLength(0);
  });
});
