import { describe, it, expect } from 'vitest';
import { fomoTradeDisplay } from '../src/utils/fomoTradeDisplay';
import type { FomoTrade } from '../src/types/fomo';
import type { ContractLinkTemplates } from '../src/types';

const SOL_NET = 1399811149;
const SOL_ADDR = 'EW7I3DsomeMemeTokenAddressXXXXXXXXXXXXXXXXXX';
const EVM_ADDR = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';

const templates = {
  solPlatform: 'axiom',
  evmPlatform: 'gmgn',
  sol: '',
  evm: '',
} as unknown as ContractLinkTemplates;

const trade = (over: Partial<FomoTrade> = {}): FomoTrade =>
  ({
    fomoUserId: 'u1',
    fomoHandle: 'vee',
    displayName: 'Vee',
    side: 'buy',
    tokenAddress: SOL_ADDR,
    tokenSymbol: null,
    networkId: SOL_NET,
    usdValue: 1791,
    tradeId: 't1',
    receivedAt: 0,
    key: 'k1',
    ...over,
  }) as FomoTrade;

describe('fomoTradeDisplay', () => {
  it('headlines the symbol as $TICKER when resolved', () => {
    const d = fomoTradeDisplay(trade({ tokenSymbol: 'ta' }), templates);
    expect(d.tokenLabel).toBe('$TA');
    expect(d.hasSymbol).toBe(true);
    // address stays available as secondary context
    expect(d.shortAddress).toBe('EW7I…XXXX');
    expect(d.address).toBe(SOL_ADDR);
  });

  it('falls back to a short address when the symbol is missing (pre-enrichment)', () => {
    const d = fomoTradeDisplay(trade({ tokenSymbol: null }), templates);
    expect(d.tokenLabel).toBe('EW7I…XXXX');
    expect(d.hasSymbol).toBe(false);
  });

  it('handles a trade with no address at all', () => {
    const d = fomoTradeDisplay(trade({ tokenAddress: null, tokenSymbol: null }), templates);
    expect(d.tokenLabel).toBe('Unknown token');
    expect(d.shortAddress).toBeNull();
    expect(d.chartUrl).toBeNull();
  });

  it('treats a blank/whitespace symbol as missing', () => {
    expect(fomoTradeDisplay(trade({ tokenSymbol: '   ' }), templates).hasSymbol).toBe(false);
  });

  it('exposes the chain slug for the network id', () => {
    expect(fomoTradeDisplay(trade(), templates).chainSlug).toBe('sol');
    expect(fomoTradeDisplay(trade({ networkId: 8453 }), templates).chainSlug).toBe('base');
    expect(fomoTradeDisplay(trade({ networkId: 999 }), templates).chainSlug).toBeNull();
  });

  it('builds a chart link for sol and evm tokens', () => {
    const sol = fomoTradeDisplay(trade(), templates);
    expect(sol.chartUrl).toContain(SOL_ADDR);

    const evm = fomoTradeDisplay(trade({ tokenAddress: EVM_ADDR, networkId: 8453 }), templates);
    expect(evm.chartUrl).toContain(EVM_ADDR);
  });

  it('omits the chart link when no templates are configured', () => {
    expect(fomoTradeDisplay(trade(), null).chartUrl).toBeNull();
    expect(fomoTradeDisplay(trade(), undefined).chartUrl).toBeNull();
  });
});
