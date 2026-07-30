import { describe, it, expect, vi, beforeEach } from 'vitest';

const snapshotCalls: Array<{ chainSlug: string; address: string }> = [];
let snapshotResult: {
  symbol?: string | null;
  name?: string | null;
  mc?: number | null;
  mcDisplay?: string | null;
} | null = null;

vi.mock('../src/utils/tokenSnapshot.js', () => ({
  getTokenSnapshot: async (chainSlug: string, address: string) => {
    snapshotCalls.push({ chainSlug, address });
    return snapshotResult;
  },
}));

const { lookupTokenInfo, resolveTradeTokenInfo } = await import('../src/fomo/tokenInfo.js');
const SOL_NET = 1399811149;
const MEME = 'EW7I3DsomeMemeTokenAddressXXXXXXXXXXXXXXXXXX';

function baseTrade(over: Record<string, unknown> = {}) {
  return {
    tradeId: 't1',
    fomoUserId: 'u1',
    fomoHandle: 'vee',
    displayName: 'Vee',
    side: 'buy',
    tokenAddress: MEME,
    tokenSymbol: null,
    tokenName: null,
    marketCap: null,
    marketCapDisplay: null,
    networkId: SOL_NET,
    usdValue: 1791,
    raw: {},
    ...over,
  };
}

describe('lookupTokenInfo', () => {
  beforeEach(() => {
    snapshotCalls.length = 0;
    snapshotResult = { symbol: 'TA', name: 'Test Alpha', mc: 1_200_000, mcDisplay: '$1.2M' };
  });

  it('returns symbol, name, and market cap from the snapshot', async () => {
    const info = await lookupTokenInfo(MEME, SOL_NET);
    expect(info).toEqual({ tokenSymbol: 'TA', tokenName: 'Test Alpha', marketCap: 1_200_000, marketCapDisplay: '$1.2M' });
  });

  it('returns null when the address is missing', async () => {
    expect(await lookupTokenInfo(null, SOL_NET)).toBeNull();
    expect(snapshotCalls).toHaveLength(0);
  });

  it('returns null when the network is unsupported', async () => {
    expect(await lookupTokenInfo(MEME, 999)).toBeNull();
    expect(snapshotCalls).toHaveLength(0);
  });

  it('returns null when the snapshot has nothing', async () => {
    snapshotResult = null;
    expect(await lookupTokenInfo(MEME, SOL_NET)).toBeNull();
  });
});

describe('resolveTradeTokenInfo', () => {
  beforeEach(() => {
    snapshotCalls.length = 0;
    snapshotResult = { symbol: 'TA', name: 'Test Alpha', mc: 1_200_000, mcDisplay: '$1.2M' };
  });

  it('fills in symbol, name, and market cap for a fresh (never-resolved) trade', async () => {
    const trade = await resolveTradeTokenInfo(baseTrade());
    expect(trade.tokenSymbol).toBe('TA');
    expect(trade.tokenName).toBe('Test Alpha');
    expect(trade.marketCap).toBe(1_200_000);
    expect(trade.marketCapDisplay).toBe('$1.2M');
    expect(snapshotCalls).toHaveLength(1);
  });

  // A live poll always needs a fresh market cap for a genuinely new trade —
  // FOMO's own payload never carries name/marketCap, so a trade with only a
  // pre-existing symbol must still resolve, not short-circuit.
  it('still resolves name/market cap when only the symbol was already present', async () => {
    const trade = await resolveTradeTokenInfo(baseTrade({ tokenSymbol: 'TA' }));
    expect(trade.tokenName).toBe('Test Alpha');
    expect(trade.marketCap).toBe(1_200_000);
    expect(snapshotCalls).toHaveLength(1);
  });

  // A stored trade being replayed already carries a market-cap snapshot from
  // when it happened — must not be silently replaced by a current value.
  it('skips the lookup once symbol, name, and market cap are all already present', async () => {
    const trade = await resolveTradeTokenInfo(
      baseTrade({ tokenSymbol: 'TA', tokenName: 'Test Alpha', marketCap: 900_000, marketCapDisplay: '$900K' }),
    );
    expect(trade.marketCap).toBe(900_000);
    expect(trade.marketCapDisplay).toBe('$900K');
    expect(snapshotCalls).toHaveLength(0);
  });

  it('treats a market cap of exactly 0 as already resolved (not falsy-missing)', async () => {
    const trade = await resolveTradeTokenInfo(
      baseTrade({ tokenSymbol: 'TA', tokenName: 'Test Alpha', marketCap: 0, marketCapDisplay: '$0' }),
    );
    expect(snapshotCalls).toHaveLength(0);
    expect(trade.marketCap).toBe(0);
  });

  it('leaves the trade unchanged when enrichment finds nothing', async () => {
    snapshotResult = null;
    const trade = await resolveTradeTokenInfo(baseTrade());
    expect(trade.tokenSymbol).toBeNull();
    expect(trade.tokenName).toBeNull();
    expect(trade.marketCap).toBeNull();
  });
});
