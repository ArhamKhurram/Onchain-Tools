import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { TokenEnrichment } from '../src/utils/rickEmbedParser.js';

/**
 * GMGN derives FDV as supply x price, and `/v1/token/info` returns no supply
 * for tokens it has not indexed yet — so a freshly-launched token comes back
 * named and priced with no market cap at all.
 *
 * `fetchEnrichment` used to accept that silently: its only DexScreener
 * consultation was gated on the SYMBOL being absent, which is the opposite
 * condition, so a GMGN answer carrying a symbol returned immediately and
 * MC@call stayed blank on a token DexScreener could price perfectly well.
 */

const enrichFromGmgn = vi.fn<(chain: string, address: string) => Promise<TokenEnrichment | null>>();
const enrichFromDexScreener = vi.fn<(address: string) => Promise<TokenEnrichment | null>>();

vi.mock('../src/utils/gmgnEnrichment.js', () => ({
  enrichFromGmgn: (chain: string, address: string) => enrichFromGmgn(chain, address),
  resolveGmgnChain: (slug?: string) => (slug ? slug : null),
}));

vi.mock('../src/utils/tokenEnrichment.js', () => ({
  enrichFromDexScreener: (address: string) => enrichFromDexScreener(address),
}));

vi.mock('../src/alerts/tokenPeakStore.js', () => ({
  recordPeakObservation: () => {},
}));

const { enrichToken } = await import('../src/utils/tokenSnapshot.js');

const ADDRESS = '0x40df1828c5aec639f9c0a0181622d2b650843e35';

function gmgnAnswer(overrides: Partial<TokenEnrichment> = {}): TokenEnrichment {
  return {
    address: ADDRESS,
    tokenName: 'Ponsi',
    tokenSymbol: 'PONSI',
    priceUsd: 0.000036731143,
    liquidityUsd: 15_900.5,
    evmChain: 'robinhood',
    enrichmentSource: 'gmgn',
    ...overrides,
  } as TokenEnrichment;
}

function dexAnswer(overrides: Partial<TokenEnrichment> = {}): TokenEnrichment {
  return {
    address: ADDRESS,
    tokenName: 'Ponsi',
    tokenSymbol: 'PONSI',
    tokenPair: 'PONSI/WETH',
    fdvAtCall: 36_123,
    fdvAtCallDisplay: '36.1K',
    enrichmentSource: 'dexscreener',
    ...overrides,
  } as TokenEnrichment;
}

describe('enrichToken when GMGN answers without a market cap', () => {
  const previousKey = process.env.GMGN_API_KEY;

  beforeEach(() => {
    process.env.GMGN_API_KEY = 'test-key';
    enrichFromGmgn.mockReset();
    enrichFromDexScreener.mockReset();
  });

  afterEach(() => {
    if (previousKey === undefined) delete process.env.GMGN_API_KEY;
    else process.env.GMGN_API_KEY = previousKey;
  });

  it('asks DexScreener for the FDV even though GMGN supplied a symbol', async () => {
    enrichFromGmgn.mockResolvedValue(gmgnAnswer({ fdvAtCall: undefined }));
    enrichFromDexScreener.mockResolvedValue(dexAnswer());

    const result = await enrichToken(ADDRESS, 'robinhood');

    expect(enrichFromDexScreener).toHaveBeenCalledWith(ADDRESS);
    expect(result?.fdvAtCall).toBe(36_123);
    expect(result?.fdvAtCallDisplay).toBe('36.1K');
  });

  it('keeps GMGN metadata and price when borrowing only the FDV', async () => {
    enrichFromGmgn.mockResolvedValue(gmgnAnswer({ fdvAtCall: undefined }));
    enrichFromDexScreener.mockResolvedValue(dexAnswer({ tokenSymbol: 'STALE', tokenName: 'Stale' }));

    const result = await enrichToken(ADDRESS, 'robinhood');

    expect(result?.tokenSymbol).toBe('PONSI');
    expect(result?.tokenName).toBe('Ponsi');
    expect(result?.priceUsd).toBe(0.000036731143);
    expect(result?.liquidityUsd).toBe(15_900.5);
  });

  it('still fills a missing symbol from DexScreener', async () => {
    enrichFromGmgn.mockResolvedValue(
      gmgnAnswer({ tokenSymbol: undefined, tokenName: undefined, fdvAtCall: 36_123 }),
    );
    enrichFromDexScreener.mockResolvedValue(dexAnswer());

    const result = await enrichToken(ADDRESS, 'robinhood');

    expect(result?.tokenSymbol).toBe('PONSI');
    expect(result?.fdvAtCall).toBe(36_123);
  });

  it('spends no DexScreener call when GMGN already answered in full', async () => {
    enrichFromGmgn.mockResolvedValue(gmgnAnswer({ fdvAtCall: 36_123 }));

    const result = await enrichToken(ADDRESS, 'robinhood');

    expect(enrichFromDexScreener).not.toHaveBeenCalled();
    expect(result?.fdvAtCall).toBe(36_123);
  });

  it('returns the partial GMGN answer when DexScreener has nothing either', async () => {
    enrichFromGmgn.mockResolvedValue(gmgnAnswer({ fdvAtCall: undefined }));
    enrichFromDexScreener.mockResolvedValue(null);

    const result = await enrichToken(ADDRESS, 'robinhood');

    expect(result?.tokenSymbol).toBe('PONSI');
    expect(result?.fdvAtCall).toBeUndefined();
  });

  // A null GMGN answer is a provider failure, not a priced-at-nothing token:
  // the chain loop must fall through to DexScreener as it always did.
  it('falls through to DexScreener when GMGN returns nothing', async () => {
    enrichFromGmgn.mockResolvedValue(null);
    enrichFromDexScreener.mockResolvedValue(dexAnswer());

    const result = await enrichToken(ADDRESS, 'robinhood');

    expect(result?.fdvAtCall).toBe(36_123);
    expect(result?.enrichmentSource).toBe('dexscreener');
  });
});
