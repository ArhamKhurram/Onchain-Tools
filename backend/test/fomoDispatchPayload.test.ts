import { describe, it, expect } from 'vitest';
import { buildFomoTradePayload } from '../src/fomo/dispatch.js';
import type { NormalizedTrade } from '../src/fomo/store.js';

function trade(over: Partial<NormalizedTrade> = {}): NormalizedTrade {
  return {
    tradeId: 't1',
    fomoUserId: 'u1',
    fomoHandle: 'vee',
    displayName: 'Vee',
    side: 'buy',
    tokenAddress: '0xabc',
    tokenSymbol: 'TA',
    tokenName: 'Test Alpha',
    marketCap: 1_200_000,
    marketCapDisplay: '$1.2M',
    networkId: 8453,
    usdValue: 1791,
    raw: {},
    ...over,
  };
}

describe('buildFomoTradePayload', () => {
  it('carries token name and market cap through to the WS payload', () => {
    const payload = buildFomoTradePayload(trade());
    expect((payload.data as Record<string, unknown>).tokenName).toBe('Test Alpha');
    expect((payload.data as Record<string, unknown>).marketCap).toBe(1_200_000);
    expect((payload.data as Record<string, unknown>).marketCapDisplay).toBe('$1.2M');
  });

  // Backfill/replay must never fire a client-side toast/sound for a burst of
  // history — notify defaults false unless the caller explicitly opts in.
  it('defaults notify to false when no options are passed', () => {
    const payload = buildFomoTradePayload(trade());
    expect((payload.data as Record<string, unknown>).notify).toBe(false);
  });

  it('sets notify true only when explicitly requested (a live, opted-in dispatch)', () => {
    const payload = buildFomoTradePayload(trade(), { notify: true });
    expect((payload.data as Record<string, unknown>).notify).toBe(true);
  });

  it('coerces a falsy notify option to false rather than leaving it undefined', () => {
    const payload = buildFomoTradePayload(trade(), { notify: false });
    expect((payload.data as Record<string, unknown>).notify).toBe(false);
  });
});
