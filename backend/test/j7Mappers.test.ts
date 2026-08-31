import { describe, it, expect } from 'vitest';
import { mapCallout, mapFomoTrade } from '../src/j7/mappers.js';

// The sample `data` payloads below are the real captures documented in the j7
// migration brief. The assertions pin every mapped field so a wire-shape drift
// (a renamed key, a moved nesting) fails loudly here rather than silently
// blanking the console feed.

// A pump_event kind:"callout" — the recovered pump.fun capability. Note the two
// market caps: `calledOutAtMcap` (MC-at-call, the datum we keep) vs the token's
// live `marketCapUsd`, which we deliberately DON'T use for the frame.
const CALLOUT_DATA = {
  calloutId: 'co_abc123',
  author: {
    wallet: 'Ca11erWa11etAdd7ess11111111111111111111111',
    username: 'kelsier',
    displayName: 'Kelsier',
    avatar: 'https://img.j7/avatar.png',
    twitter: 'kelsier',
    profileUrl: 'https://j7tracker.io/u/kelsier',
  },
  token: {
    address: 'M1ntAddress2222222222222222222222222222222',
    symbol: 'ABC',
    name: 'Alpha Beta Coin',
    tokenImageUrl: 'https://img.j7/token.png',
    network: 'solana',
    networkId: 1399811149,
    marketCapUsd: 142000, // live cap — must NOT win over calledOutAtMcap
  },
  text: 'this one runs',
  calledOutAtMcap: 85771,
  multiple: 1.4,
  maxMultiplier: 3.2,
  createdAt: '2026-08-29T13:00:00.000Z',
  timestamp: '2026-08-29T13:24:16.047Z',
  updateCount: 0,
};

// A fomo_event kind:"trade" — per-trader activity, multi-chain (Robinhood here).
// price/marketCap/equityUsd came back null on the real trade.
const TRADE_DATA = {
  id: 'evt_1',
  tradeId: '0x1788aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabf8',
  side: 'sell',
  userId: 'u_42',
  userHandle: 'unipcs',
  displayName: 'unipcs',
  source: 'trading_activity_ws',
  rawType: 'swap',
  usdAmount: 35034.84,
  price: null,
  marketCap: null,
  equityUsd: null,
  timestamp: '2026-08-29T13:24:16.047Z',
  profileUrl: 'https://j7tracker.io/u/unipcs',
  token: {
    address: '0xToken0000000000000000000000000000000000',
    symbol: 'HOOD',
    networkId: 4663,
    network: 'robinhood',
    networkName: 'Robinhood Chain',
    tokenImageUrl: 'https://img.j7/hood.png',
    explorerUrl: 'https://explorer/hood',
  },
};

describe('mapCallout', () => {
  it('maps every field of a real callout to the pump_callout frame data', () => {
    const out = mapCallout(CALLOUT_DATA);
    expect(out).not.toBeNull();
    expect(out).toEqual({
      calloutId: 'co_abc123',
      callerAddress: 'Ca11erWa11etAdd7ess11111111111111111111111',
      username: 'kelsier',
      avatar: 'https://img.j7/avatar.png',
      coinMint: 'M1ntAddress2222222222222222222222222222222',
      symbol: 'ABC',
      name: 'Alpha Beta Coin',
      image: 'https://img.j7/token.png',
      marketCapUsd: 85771, // calledOutAtMcap, NOT token.marketCapUsd (142000)
      thesis: 'this one runs',
      multiple: 1.4,
      createdAt: Date.parse('2026-08-29T13:24:16.047Z'), // timestamp → epoch ms
      maxMultiplier: 3.2,
    });
  });

  it('takes MC-at-call from calledOutAtMcap, never the token live cap', () => {
    const out = mapCallout(CALLOUT_DATA);
    expect(out?.marketCapUsd).toBe(85771);
  });

  it('surfaces maxMultiplier (the field the old firehose never carried)', () => {
    expect(mapCallout(CALLOUT_DATA)?.maxMultiplier).toBe(3.2);
  });

  it('accepts a numeric epoch-ms timestamp as well as ISO', () => {
    const out = mapCallout({ ...CALLOUT_DATA, timestamp: 1724937600000 });
    expect(out?.createdAt).toBe(1724937600000);
  });

  it('returns null (never throws) when a required key is missing', () => {
    expect(mapCallout({ ...CALLOUT_DATA, calloutId: undefined })).toBeNull();
    expect(mapCallout({ ...CALLOUT_DATA, author: {} })).toBeNull(); // no wallet
    expect(mapCallout({ ...CALLOUT_DATA, token: {} })).toBeNull(); // no address
  });

  it('handles a kind:"reply" / null-field shape without throwing', () => {
    // A reply hangs off data.parent and has null callout price/multiplier; it
    // lacks the top-level calloutId/wallet/coin, so it maps to null cleanly.
    const reply = {
      parent: { calloutId: 'co_parent' },
      calledOutAtMcap: 12345,
      calloutPrice: null,
      maxMultiplier: null,
    };
    expect(() => mapCallout(reply)).not.toThrow();
    expect(mapCallout(reply)).toBeNull();
  });

  it('does not throw on non-record input', () => {
    expect(mapCallout(null)).toBeNull();
    expect(mapCallout('nope')).toBeNull();
    expect(mapCallout(undefined)).toBeNull();
  });
});

describe('mapFomoTrade', () => {
  it('maps every field of a real trade to the fomo_trade frame data', () => {
    const out = mapFomoTrade(TRADE_DATA);
    expect(out).not.toBeNull();
    expect(out).toEqual({
      fomoUserId: 'u_42',
      fomoHandle: 'unipcs',
      displayName: 'unipcs',
      side: 'sell',
      tokenAddress: '0xToken0000000000000000000000000000000000',
      tokenSymbol: 'HOOD',
      tokenName: null,
      marketCap: null,
      marketCapDisplay: null,
      networkId: 4663, // j7's own networkId, passed through verbatim
      usdValue: 35034.84, // usdAmount → usdValue
      tradeId: '0x1788aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabf8',
      timestamp: '2026-08-29T13:24:16.047Z',
      network: 'robinhood',
      venue: 'fomo.family',
    });
  });

  it('hard-codes venue to fomo.family', () => {
    expect(mapFomoTrade(TRADE_DATA)?.venue).toBe('fomo.family');
  });

  it('treats price/marketCap/equityUsd as nullable without throwing', () => {
    const out = mapFomoTrade(TRADE_DATA);
    expect(out?.marketCap).toBeNull();
    expect(out?.marketCapDisplay).toBeNull();
  });

  it('falls back to the row id when tradeId is absent', () => {
    const { tradeId, ...noTradeId } = TRADE_DATA;
    void tradeId;
    expect(mapFomoTrade(noTradeId)?.tradeId).toBe('evt_1');
  });

  it('returns null (never throws) when there is no dedup key at all', () => {
    const { tradeId, id, ...noKeys } = TRADE_DATA;
    void tradeId;
    void id;
    expect(() => mapFomoTrade(noKeys)).not.toThrow();
    expect(mapFomoTrade(noKeys)).toBeNull();
  });

  it('does not throw on non-record input', () => {
    expect(mapFomoTrade(null)).toBeNull();
    expect(mapFomoTrade(42)).toBeNull();
  });
});
