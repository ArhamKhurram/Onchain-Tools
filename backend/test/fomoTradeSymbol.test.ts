import { describe, it, expect } from 'vitest';
import { normalizeUserActivity } from '../src/fomo/store';
import { chainSlugFromNetworkId, chainKindFromNetworkId } from '@oct/shared';

const SOL_NET = 1399811149;
const WSOL = 'So11111111111111111111111111111111111111112'; // quote token
const MEME = 'EW7I3DsomeMemeTokenAddressXXXXXXXXXXXXXXXXXX';

const trader = { fomoUserId: 'u1', fomoHandle: 'vee', displayName: 'Vee' };

// Shape of a FOMO /v2/users/:id/activity swap row (in/out legs).
const swap = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  activityType: 'swap',
  inTokenAddress: WSOL,
  outTokenAddress: MEME,
  inNetworkId: SOL_NET,
  outNetworkId: SOL_NET,
  humanUsdAmountIn: 1791,
  ...over,
});

describe('normalizeUserActivity — side + subject token', () => {
  it('quote in / token out => buy, subject is the out token', () => {
    const t = normalizeUserActivity(swap(), trader)!;
    expect(t.side).toBe('buy');
    expect(t.tokenAddress).toBe(MEME);
    expect(t.usdValue).toBe(1791);
  });

  it('token in / quote out => sell, subject is the in token', () => {
    const t = normalizeUserActivity(
      swap({ inTokenAddress: MEME, outTokenAddress: WSOL }),
      trader,
    )!;
    expect(t.side).toBe('sell');
    expect(t.tokenAddress).toBe(MEME);
  });

  it('skips non-swap activity and quote↔quote swaps', () => {
    expect(normalizeUserActivity(swap({ activityType: 'transfer' }), trader)).toBeNull();
    expect(normalizeUserActivity(swap({ outTokenAddress: WSOL }), trader)).toBeNull();
  });
});

describe('normalizeUserActivity — symbol extraction (the live-feed fix)', () => {
  it('reads the symbol from the SUBJECT leg on a buy (out leg)', () => {
    const t = normalizeUserActivity(swap({ inTokenSymbol: 'SOL', outTokenSymbol: 'TA' }), trader)!;
    expect(t.side).toBe('buy');
    expect(t.tokenSymbol).toBe('TA'); // not the SOL it was paid with
  });

  it('reads the symbol from the SUBJECT leg on a sell (in leg)', () => {
    const t = normalizeUserActivity(
      swap({ inTokenAddress: MEME, outTokenAddress: WSOL, inTokenSymbol: 'TA', outTokenSymbol: 'SOL' }),
      trader,
    )!;
    expect(t.side).toBe('sell');
    expect(t.tokenSymbol).toBe('TA');
  });

  it('supports nested token objects and ticker aliases', () => {
    expect(normalizeUserActivity(swap({ outToken: { symbol: 'NESTED' } }), trader)!.tokenSymbol).toBe('NESTED');
    expect(normalizeUserActivity(swap({ outTokenTicker: 'TICK' }), trader)!.tokenSymbol).toBe('TICK');
    expect(normalizeUserActivity(swap({ outToken: { info: { symbol: 'DEEP' } } }), trader)!.tokenSymbol).toBe('DEEP');
  });

  it('returns null when the payload carries no symbol (catalog lookup then fills it)', () => {
    expect(normalizeUserActivity(swap(), trader)!.tokenSymbol).toBeNull();
  });
});

describe('chain mapping from FOMO network ids', () => {
  it('maps supported networks to OCT chain slugs', () => {
    expect(chainSlugFromNetworkId(SOL_NET)).toBe('sol');
    expect(chainSlugFromNetworkId(1)).toBe('eth');
    expect(chainSlugFromNetworkId(56)).toBe('bsc');
    expect(chainSlugFromNetworkId(8453)).toBe('base');
    expect(chainSlugFromNetworkId(143)).toBe('robinhood');
  });

  it('returns null for unknown/absent networks', () => {
    expect(chainSlugFromNetworkId(999)).toBeNull();
    expect(chainSlugFromNetworkId(null)).toBeNull();
    expect(chainSlugFromNetworkId(undefined)).toBeNull();
  });

  it('buckets into sol vs evm', () => {
    expect(chainKindFromNetworkId(SOL_NET)).toBe('sol');
    expect(chainKindFromNetworkId(8453)).toBe('evm');
    expect(chainKindFromNetworkId(999)).toBeNull();
  });
});
