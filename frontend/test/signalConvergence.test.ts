import { describe, it, expect } from 'vitest';
import {
  isFomoBuySide,
  addressesMatch,
  getSignalConvergenceWindowMs,
  findConvergenceForContract,
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
    const t = trade({ receivedAt: T0 + 5 * 60_000 });
    expect(findConvergenceForContract(contract(), [t])).toBe(t);
  });

  it('returns null when the buy is outside the window', () => {
    const t = trade({ receivedAt: T0 + 40 * 60_000 });
    expect(findConvergenceForContract(contract(), [t])).toBeNull();
  });

  it('ignores non-buy sides', () => {
    const t = trade({ side: 'sell', receivedAt: T0 });
    expect(findConvergenceForContract(contract(), [t])).toBeNull();
  });

  it('ignores trades for a different token', () => {
    const t = trade({ tokenAddress: '0xdead0000000000000000000000000000000beef0' });
    expect(findConvergenceForContract(contract(), [t])).toBeNull();
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
