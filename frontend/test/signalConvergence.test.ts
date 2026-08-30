import { describe, it, expect } from 'vitest';
import {
  isFomoBuySide,
  addressesMatch,
  getSignalConvergenceWindowMs,
  findConvergenceForContract,
  findConvergenceForAddress,
  buildConvergenceIndex,
  convergenceKey,
  DEFAULT_SIGNAL_CONVERGENCE_WINDOW_MINUTES,
} from '../src/utils/signalConvergence';
import type { ContractEntry } from '../src/types';
import type { FomoTrade } from '../src/types/fomo';

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();

const contract = (over: Partial<ContractEntry> = {}): ContractEntry =>
  ({
    address: '0xAbCdef0000000000000000000000000000000001',
    timestamp: new Date(T0).toISOString(),
    messageId: 'm1',
    channelId: 'c1',
    channelName: 'alpha',
    ...over,
  } as unknown as ContractEntry);

const trade = (over: Partial<FomoTrade> = {}): FomoTrade =>
  ({
    side: 'buy',
    tokenAddress: '0xabcdef0000000000000000000000000000000001',
    occurredAt: T0,
    receivedAt: T0,
    key: 'k1',
    fomoUserId: 'u1',
    fomoHandle: 'trader',
    ...over,
  } as unknown as FomoTrade);

describe('isFomoBuySide', () => {
  it('treats buy/long/bought as buys (case + whitespace tolerant)', () => {
    for (const s of ['buy', 'BUY', ' long ', 'Bought']) expect(isFomoBuySide(s)).toBe(true);
  });
  it('rejects sells, empty, and nullish', () => {
    for (const s of ['sell', 'short', '', null, undefined]) expect(isFomoBuySide(s)).toBe(false);
  });
});

describe('addressesMatch', () => {
  it('matches case-insensitively and trims', () => {
    expect(addressesMatch('0xAbC', '  0xabc ')).toBe(true);
  });
  it('does not match a null token address', () => {
    expect(addressesMatch('0xAbC', null)).toBe(false);
  });
});

describe('getSignalConvergenceWindowMs', () => {
  it('defaults to 30 minutes when no config', () => {
    expect(getSignalConvergenceWindowMs()).toBe(DEFAULT_SIGNAL_CONVERGENCE_WINDOW_MINUTES * 60_000);
    expect(getSignalConvergenceWindowMs(null)).toBe(30 * 60_000);
  });
  it('honors a configured window', () => {
    expect(getSignalConvergenceWindowMs({ signalConvergenceWindowMinutes: 10 } as never)).toBe(600_000);
  });
  it('clamps a zero/negative window up to at least 1 minute', () => {
    expect(getSignalConvergenceWindowMs({ signalConvergenceWindowMinutes: 0 } as never)).toBe(60_000);
  });
});

describe('findConvergenceForContract', () => {
  it('returns the trade when a matching buy lands inside the window', () => {
    const t = trade({ occurredAt: T0 + 5 * 60_000 });
    expect(findConvergenceForContract(contract(), [t])).toBe(t);
  });

  it('returns null when the buy is outside the window', () => {
    const t = trade({ occurredAt: T0 + 40 * 60_000 });
    expect(findConvergenceForContract(contract(), [t])).toBeNull();
  });

  it('ignores non-buy sides', () => {
    const t = trade({ side: 'sell', occurredAt: T0 });
    expect(findConvergenceForContract(contract(), [t])).toBeNull();
  });

  it('ignores trades for a different token', () => {
    const t = trade({ tokenAddress: '0xdead0000000000000000000000000000000beef0' });
    expect(findConvergenceForContract(contract(), [t])).toBeNull();
  });

  // Replayed history is stamped with this session's arrival time. Keying on that
  // would make every day-old trade converge with whatever was called at reload.
  it('keys on when the trade happened, not when it reached this session', () => {
    const stale = trade({ occurredAt: T0 - 26 * 3_600_000, receivedAt: T0 });
    expect(findConvergenceForContract(contract(), [stale])).toBeNull();
  });

  it('returns null for a contract with an unparseable timestamp', () => {
    expect(findConvergenceForContract(contract({ timestamp: 'not-a-date' }), [trade()])).toBeNull();
  });
});

describe('convergenceKey', () => {
  it('is stable and keyed on normalized address + trader id', () => {
    expect(convergenceKey(contract(), trade())).toBe(
      '0xabcdef0000000000000000000000000000000001:u1',
    );
  });
});


describe('buildConvergenceIndex', () => {
  it('maps a converging address to its trade, keyed normalized', () => {
    const idx = buildConvergenceIndex([contract()], [trade()]);
    expect(idx.get('0xabcdef0000000000000000000000000000000001')?.key).toBe('k1');
    expect(idx.size).toBe(1);
  });

  it('skips sells, other tokens, out-of-window trades, and bad timestamps', () => {
    const idx = buildConvergenceIndex(
      [
        contract(),
        contract({ address: '0xdead0000000000000000000000000000000beef0', timestamp: 'not-a-date' }),
      ],
      [
        trade({ side: 'sell', key: 's' }),
        trade({ occurredAt: T0 - 26 * 3_600_000, key: 'stale' }),
        trade({ tokenAddress: '0xdead0000000000000000000000000000000beef0', key: 'other' }),
      ],
    );
    expect(idx.size).toBe(0);
  });

  it('returns exactly what findConvergenceForAddress returns, per address, on a fuzzed feed', () => {
    // Deterministic LCG so the case reproduces.
    let seed = 1234;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    const addrs = Array.from({ length: 40 }, (_, i) => `0xToken${i.toString(16)}`);
    const contracts = Array.from({ length: 400 }, (_, i) =>
      contract({
        address: rnd() < 0.5 ? addrs[Math.floor(rnd() * addrs.length)] : addrs[Math.floor(rnd() * addrs.length)].toUpperCase(),
        timestamp: new Date(T0 + Math.floor(rnd() * 86_400_000)).toISOString(),
        messageId: `m${i}`,
      }),
    );
    const trades = Array.from({ length: 120 }, (_, i) =>
      trade({
        side: rnd() < 0.7 ? 'buy' : 'sell',
        tokenAddress: rnd() < 0.9 ? addrs[Math.floor(rnd() * addrs.length)].toLowerCase() : null,
        occurredAt: T0 + Math.floor(rnd() * 86_400_000),
        key: `t${i}`,
      }),
    );
    const idx = buildConvergenceIndex(contracts, trades);
    for (const a of addrs) {
      const expected = findConvergenceForAddress(a, contracts, trades);
      expect(idx.get(a.toLowerCase()) ?? null).toBe(expected);
    }
  });
});
