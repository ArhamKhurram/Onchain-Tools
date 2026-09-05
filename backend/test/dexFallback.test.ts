import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveFallbackTarget,
  recordFallbackFdv,
  isFdvUnavailable,
  resetFallbackGuard,
  FDV_UNAVAILABLE_TTL_MS,
} from '../src/utils/dexFallback.js';
import type { ContractEntry } from '../src/utils/contractLog.js';

const SOL_ADDRESS = 'So11111111111111111111111111111111111111112';
const EVM_ADDRESS = '0xAbC0000000000000000000000000000000000001';

function row(overrides: Partial<ContractEntry> & { messageId: string }): ContractEntry {
  return {
    address: SOL_ADDRESS,
    chain: 'sol',
    authorId: 'a1',
    authorName: 'caller',
    channelId: 'c1',
    channelName: 'calls',
    guildId: 'g1',
    guildName: 'guild',
    roomIds: ['r1'],
    timestamp: '2026-08-08T12:00:00.000Z',
    ...overrides,
  };
}

/**
 * Stand-in for the storage provider. It carries `getContracts` as well as the
 * targeted lookup so that the "scrolled out of the recent window" test below
 * still describes the real store's behaviour if anyone reaches for it again.
 */
function makeStore(rows: ContractEntry[]) {
  const calls = { byMessage: 0, recentWindow: 0 };
  return {
    calls,
    async getContractByMessage(_userId: string, messageId: string, address: string) {
      calls.byMessage++;
      return (
        rows.find(
          (r) => r.messageId === messageId && r.address.toLowerCase() === address.toLowerCase(),
        ) ?? null
      );
    },
    async getContracts(_userId: string, limit = 100) {
      calls.recentWindow++;
      return rows.slice(0, limit);
    },
  };
}

describe('resolveFallbackTarget', () => {
  beforeEach(() => {
    resetFallbackGuard();
  });

  // Cause 3: both fallback timers used to look for their row inside the 20 most
  // recent contracts. A burst buries it well before the 8s/15s timer fires.
  it('resolves a row that has scrolled far past the recent window', async () => {
    const target = row({ messageId: 'm-target', tokenSymbol: 'puf' });
    const burst = Array.from({ length: 40 }, (_, i) => row({ messageId: `m-${i}` }));
    const store = makeStore([...burst, target]);

    const hit = await resolveFallbackTarget(store, 'local', SOL_ADDRESS, 'm-target');

    expect(hit).not.toBeNull();
    expect(hit?.messageId).toBe('m-target');
    expect(store.calls.recentWindow).toBe(0);
  });

  it('returns null when the row is gone', async () => {
    const store = makeStore([]);
    expect(await resolveFallbackTarget(store, 'local', SOL_ADDRESS, 'm-1')).toBeNull();
  });

  // Cause 1: logContract carries the symbol forward onto a repeat mention but
  // not the FDV, so this row is exactly what a repeat mention looks like 15s in.
  it('fetches for a repeat mention that has a symbol but no MC@call', async () => {
    const store = makeStore([
      row({ messageId: 'm-1', tokenSymbol: 'puf', tokenName: 'sillypufcat', enrichmentSource: 'rick' }),
    ]);

    const hit = await resolveFallbackTarget(store, 'local', SOL_ADDRESS, 'm-1');
    expect(hit?.messageId).toBe('m-1');
  });

  it('skips a row that already has both a symbol and an MC@call', async () => {
    const store = makeStore([row({ messageId: 'm-1', tokenSymbol: 'puf', fdvAtCall: 2100 })]);
    expect(await resolveFallbackTarget(store, 'local', SOL_ADDRESS, 'm-1')).toBeNull();
  });

  describe('once a provider says it cannot price the address', () => {
    it('stops re-asking for the FDV on every later mention', async () => {
      const store = makeStore([row({ messageId: 'm-2', tokenSymbol: 'puf' })]);
      recordFallbackFdv(SOL_ADDRESS, { fdvAtCall: undefined });

      expect(await resolveFallbackTarget(store, 'local', SOL_ADDRESS, 'm-2')).toBeNull();
    });

    it('still fetches when the row has no symbol either', async () => {
      const store = makeStore([row({ messageId: 'm-2' })]);
      recordFallbackFdv(SOL_ADDRESS, { fdvAtCall: undefined });

      // Unchanged from before the FDV gate existed: a symbol-less row's only
      // chance at a symbol is this fetch.
      expect(await resolveFallbackTarget(store, 'local', SOL_ADDRESS, 'm-2')).not.toBeNull();
    });

    it('probes again once the window expires', async () => {
      const store = makeStore([row({ messageId: 'm-2', tokenSymbol: 'puf' })]);
      const t0 = Date.UTC(2026, 7, 8, 12, 0, 0);
      recordFallbackFdv(SOL_ADDRESS, { fdvAtCall: undefined }, t0);

      expect(await resolveFallbackTarget(store, 'local', SOL_ADDRESS, 'm-2', t0 + 60_000)).toBeNull();
      expect(
        await resolveFallbackTarget(store, 'local', SOL_ADDRESS, 'm-2', t0 + FDV_UNAVAILABLE_TTL_MS + 1),
      ).not.toBeNull();
    });

    it('forgets the address as soon as one fetch does return an FDV', () => {
      recordFallbackFdv(SOL_ADDRESS, { fdvAtCall: undefined });
      expect(isFdvUnavailable(SOL_ADDRESS)).toBe(true);

      recordFallbackFdv(SOL_ADDRESS, { fdvAtCall: 2100 });
      expect(isFdvUnavailable(SOL_ADDRESS)).toBe(false);
    });

    // The same EVM token reaches us checksummed from a Rick embed and lowercase
    // from the caller's own post; both must hit the same guard entry.
    it('keys EVM addresses case-insensitively', () => {
      recordFallbackFdv(EVM_ADDRESS, { fdvAtCall: undefined });
      expect(isFdvUnavailable(EVM_ADDRESS.toLowerCase())).toBe(true);
    });
  });

  // "No provider answered" is not "this token has no price". GMGN inside its
  // 90s rate-limit cooldown, an open DexScreener breaker or a timeout all make
  // `enrichToken` return null, and arming the 30-minute guard on that would
  // blank MC@call for the address on every mention for half an hour — most
  // often exactly when the feed is busiest.
  describe('when the fetch produced nothing at all', () => {
    it('does not arm the negative guard on a null enrichment', () => {
      recordFallbackFdv(SOL_ADDRESS, null);
      expect(isFdvUnavailable(SOL_ADDRESS)).toBe(false);

      recordFallbackFdv(SOL_ADDRESS, undefined);
      expect(isFdvUnavailable(SOL_ADDRESS)).toBe(false);
    });

    it('leaves the next mention free to fetch again', async () => {
      const store = makeStore([row({ messageId: 'm-3', tokenSymbol: 'puf' })]);
      recordFallbackFdv(SOL_ADDRESS, null);

      expect(await resolveFallbackTarget(store, 'local', SOL_ADDRESS, 'm-3')).not.toBeNull();
    });

    it('does not clear a guard an answering provider had already armed', () => {
      recordFallbackFdv(SOL_ADDRESS, { fdvAtCall: undefined });
      recordFallbackFdv(SOL_ADDRESS, null);

      expect(isFdvUnavailable(SOL_ADDRESS)).toBe(true);
    });
  });
});
