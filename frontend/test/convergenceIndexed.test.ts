import { describe, it, expect } from 'vitest';
import {
  findConvergenceForContract,
  findConvergenceForContractIndexed,
  SIGNAL_CONVERGENCE_WINDOW_MS,
} from '../src/utils/signalConvergence';
import type { ContractEntry } from '../src/types';
import type { FomoTrade } from '../src/types/fomo';

// Every rendered contract row asks "does a tracked FOMO buy converge with this
// call?". The per-row hook used to subscribe to the whole fomoTrades array and
// the whole config object, so EVERY row re-rendered on every trade frame and
// every config replacement. It now selects the matched trade itself through a
// WeakMap-indexed lookup. These tests pin (1) result equivalence with the
// original scan, (2) the identity-stability that keeps unmatched rows quiet,
// and (3) the per-array-identity caching that keeps the selector cheap on
// unrelated store writes.

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();
const MIN = 60_000;

const contract = (over: Partial<ContractEntry> = {}): ContractEntry =>
  ({
    address: '0xAbCdef0000000000000000000000000000000001',
    timestamp: new Date(T0).toISOString(),
    messageId: 'm1',
    channelId: 'c1',
    channelName: 'alpha',
    ...over,
  } as unknown as ContractEntry);

let seq = 0;
const trade = (over: Partial<FomoTrade> = {}): FomoTrade =>
  ({
    side: 'buy',
    tokenAddress: '0xabcdef0000000000000000000000000000000001',
    occurredAt: T0,
    receivedAt: T0,
    key: `k${++seq}`,
    fomoUserId: 'u1',
    fomoHandle: 'trader',
    ...over,
  } as unknown as FomoTrade);

describe('findConvergenceForContractIndexed', () => {
  it('agrees with the unindexed scan across match shapes', () => {
    const cases: { trades: FomoTrade[]; entry: ContractEntry }[] = [
      // plain match
      { trades: [trade()], entry: contract() },
      // sell side never matches
      { trades: [trade({ side: 'sell' })], entry: contract() },
      // outside the window
      { trades: [trade({ occurredAt: T0 + SIGNAL_CONVERGENCE_WINDOW_MS + MIN })], entry: contract() },
      // different token
      { trades: [trade({ tokenAddress: '0xother' })], entry: contract() },
      // null token address
      { trades: [trade({ tokenAddress: null as unknown as string })], entry: contract() },
      // case/whitespace-insensitive address match
      {
        trades: [trade({ tokenAddress: ' 0xABCDEF0000000000000000000000000000000001 ' })],
        entry: contract(),
      },
      // several candidates: first in array order wins
      {
        trades: [
          trade({ side: 'sell' }),
          trade({ occurredAt: T0 + 5 * MIN }),
          trade({ occurredAt: T0 + 1 * MIN }),
        ],
        entry: contract(),
      },
      // unparseable contract timestamp
      { trades: [trade()], entry: contract({ timestamp: 'not-a-date' }) },
      // empty trades
      { trades: [], entry: contract() },
    ];

    for (const { trades, entry } of cases) {
      expect(findConvergenceForContractIndexed(entry, trades)).toBe(
        findConvergenceForContract(entry, trades),
      );
    }
  });

  it('returns an identity-stable result for repeated calls on the same array', () => {
    const trades = [trade({ side: 'sell' }), trade({ occurredAt: T0 + 2 * MIN }), trade()];
    const entry = contract();
    const first = findConvergenceForContractIndexed(entry, trades);
    expect(first).not.toBeNull();
    // Same array identity -> same trade object, so an Object.is-compared
    // zustand subscription does not re-render.
    expect(findConvergenceForContractIndexed(entry, trades)).toBe(first);

    // A new array holding the SAME trade objects (how addFomoTrade prepends)
    // still returns the identical object for an unchanged match.
    const grown = [trade({ tokenAddress: '0xunrelated' }), ...trades];
    expect(findConvergenceForContractIndexed(entry, grown)).toBe(first);
  });

  it('stays quiet for unmatched rows while unrelated trades stream in', () => {
    const entry = contract({ address: '0xNoTradesForThisOne' });
    let trades: FomoTrade[] = [];
    let changes = 0;
    let prev = findConvergenceForContractIndexed(entry, trades);
    for (let i = 0; i < 200; i++) {
      trades = [trade({ tokenAddress: `0xunrelated${i}` }), ...trades];
      const next = findConvergenceForContractIndexed(entry, trades);
      if (!Object.is(prev, next)) changes += 1;
      prev = next;
    }
    // The old whole-array subscription re-rendered this row 200 times.
    expect(changes).toBe(0);

    // ...and the row still lights up the moment its own buy lands.
    trades = [trade(), ...trades];
    const matched = findConvergenceForContractIndexed(contract(), trades);
    expect(matched).not.toBeNull();
  });
});
