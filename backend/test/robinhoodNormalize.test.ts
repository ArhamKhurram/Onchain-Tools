import { describe, it, expect, beforeEach } from 'vitest';
import {
  highestFillId,
  normalizeFill,
  normalizeFills,
  normalizeFlow,
  normalizeOverview,
  normalizeRadar,
  normalizeStatus,
  normalizeTraderProfile,
  normalizeTraders,
  selectNewFills,
  ROBINHOOD_CHAIN_ID,
} from '../src/robinhood/normalize.js';
import { getFeedSize, getRecentFills, recordFills, resetRobinhoodFeed } from '../src/robinhood/feed.js';

// robinhoodtrenches.com is a free, keyless, third-party indexer of Robinhood
// Chain (4663) ONLY — no Solana, no BSC. Its payloads are untrusted input, so
// every parser is tested against the live shapes and against malformed ones.

const SAMPLE_FILL = {
  id: 58236,
  ts: 1788719325,
  tx: '0xf9fc0bd0ae74dddef740a995857c20a9182ce951ede323c90c97674e094f7b10',
  side: 'buy',
  usd: 2.823_042_486_010_648,
  amount: 0.028_998_895_593_329_722,
  price: 97.35,
  new_position: 0,
  is_stock: 1,
  handle: 'AvgJoesCrypto',
  display_name: 'AJC',
  followers: 105301,
  wallet: '0x06de9c48b1e639ed5c13ec8fbd4080a38e39f2d1',
  token: '0xc72b96e0e48ecd4dc75e1e45396e26300bc39681',
  symbol: 'INTC',
  name: 'Intel • Robinhood Token',
  mark: 97.35,
  liquidity: 2000,
  pair_url: 'https://dexscreener.com/robinhood/0x3b852b8cc5b0792ca3e38991ddba0e762c05b0af',
};

describe('normalizeFill', () => {
  it('maps a live tape row onto the console contract', () => {
    const fill = normalizeFill(SAMPLE_FILL);
    expect(fill).toMatchObject({
      id: 58236,
      ts: 1788719325,
      side: 'buy',
      handle: 'AvgJoesCrypto',
      displayName: 'AJC',
      symbol: 'INTC',
      isStock: true,
      newPosition: false,
    });
  });

  it('requires a numeric id — it is both the dedupe key and the cursor', () => {
    expect(normalizeFill({ ...SAMPLE_FILL, id: undefined })).toBeNull();
    expect(normalizeFill({ ...SAMPLE_FILL, id: 'abc' })).toBeNull();
    expect(normalizeFill(null)).toBeNull();
    expect(normalizeFill([SAMPLE_FILL])).toBeNull();
  });

  it('only accepts buy/sell as a side, nulling anything else', () => {
    expect(normalizeFill({ ...SAMPLE_FILL, side: 'SELL' })?.side).toBe('sell');
    expect(normalizeFill({ ...SAMPLE_FILL, side: 'transfer' })?.side).toBeNull();
    expect(normalizeFill({ ...SAMPLE_FILL, side: 7 })?.side).toBeNull();
  });

  it('drops a non-http pair_url so it can never become a click target', () => {
    expect(normalizeFill({ ...SAMPLE_FILL, pair_url: 'javascript:alert(1)' })?.pairUrl).toBeNull();
  });

  it('nulls non-finite numerics rather than letting NaN reach toFixed()', () => {
    const fill = normalizeFill({ ...SAMPLE_FILL, usd: 'lots', liquidity: null, mark: undefined });
    expect(fill?.usd).toBeNull();
    expect(fill?.liquidity).toBeNull();
    expect(fill?.mark).toBeNull();
  });
});

describe('normalizeFills', () => {
  it('drops unusable rows and dedupes by upstream id', () => {
    const fills = normalizeFills([
      SAMPLE_FILL,
      { ...SAMPLE_FILL },
      { ...SAMPLE_FILL, id: 58237 },
      null,
      { no: 'id' },
    ]);
    expect(fills.map((f) => f.id)).toEqual([58236, 58237]);
  });

  it('returns empty for a non-array body', () => {
    expect(normalizeFills({ fills: [SAMPLE_FILL] })).toEqual([]);
    expect(normalizeFills(undefined)).toEqual([]);
  });
});

describe('selectNewFills / highestFillId', () => {
  const fills = normalizeFills([
    { ...SAMPLE_FILL, id: 3 },
    { ...SAMPLE_FILL, id: 1 },
    { ...SAMPLE_FILL, id: 2 },
  ]);

  it('emits nothing on a cold cursor — a restart must not replay the tape as live', () => {
    expect(selectNewFills(fills, null)).toEqual([]);
  });

  it('emits only ids above the cursor, oldest-first', () => {
    expect(selectNewFills(fills, 1).map((f) => f.id)).toEqual([2, 3]);
    expect(selectNewFills(fills, 3)).toEqual([]);
  });

  it('advances the cursor to the highest id, never backwards', () => {
    expect(highestFillId(fills)).toBe(3);
    expect(highestFillId(fills, 10)).toBe(10);
    expect(highestFillId([], 5)).toBe(5);
    expect(highestFillId([])).toBeNull();
  });
});

describe('feed buffer', () => {
  beforeEach(() => resetRobinhoodFeed());

  it('keeps newest-first and dedupes across calls', () => {
    recordFills(normalizeFills([{ ...SAMPLE_FILL, id: 1 }, { ...SAMPLE_FILL, id: 2 }]));
    recordFills(normalizeFills([{ ...SAMPLE_FILL, id: 2 }, { ...SAMPLE_FILL, id: 3 }]));
    expect(getRecentFills().map((f) => f.id)).toEqual([3, 2, 1]);
    expect(getFeedSize()).toBe(3);
  });

  it('clamps the requested limit into range', () => {
    recordFills(normalizeFills([{ ...SAMPLE_FILL, id: 1 }, { ...SAMPLE_FILL, id: 2 }]));
    expect(getRecentFills(1)).toHaveLength(1);
    expect(getRecentFills(-5)).toHaveLength(1);
    expect(getRecentFills(10_000)).toHaveLength(2);
  });
});

describe('normalizeStatus', () => {
  it('reads the indexer heartbeat, including the chain id that bounds this source', () => {
    const status = normalizeStatus({
      ok: true,
      chain: 'robinhood',
      chain_id: ROBINHOOD_CHAIN_ID,
      wallets: 147,
      trades: 45185,
      last_ts: 1788719325,
      lag_seconds: 0.1,
      last_block: 56192347,
      source: 'websocket',
    });
    expect(status).toEqual({
      ok: true,
      chainId: 4663,
      wallets: 147,
      trades: 45185,
      lastTs: 1788719325,
      lagSeconds: 0.1,
      lastBlock: 56192347,
      source: 'websocket',
    });
  });

  it('defaults ok to false rather than assuming health', () => {
    expect(normalizeStatus({})?.ok).toBe(false);
    expect(normalizeStatus(null)).toBeNull();
  });
});

describe('normalizeRadar', () => {
  const row = {
    token: '0x7d8a38c94baaeace8e3662d1ed33eaf6fd581071',
    symbol: 'BUDDY',
    name: 'BUDDY',
    is_stock: 0,
    first_ts: 1788718819,
    buyers: 1,
    usd_in: 494.041049,
    liquidity: 47404.06,
    pair_created_at: 1788124318,
    pair_url: 'https://dexscreener.com/robinhood/0x3b85',
    fresh: true,
    first_buyer: { handle: 'fibs', followers: 31047, ts: 1788124494 },
  };

  it('maps a radar row including the nested first buyer', () => {
    const [parsed] = normalizeRadar([row]);
    expect(parsed.symbol).toBe('BUDDY');
    expect(parsed.firstBuyer).toEqual({ handle: 'fibs', followers: 31047, ts: 1788124494 });
    expect(parsed.isStock).toBe(false);
  });

  it('drops a row without a token address and survives a bad first_buyer', () => {
    expect(normalizeRadar([{ ...row, token: null }])).toEqual([]);
    expect(normalizeRadar([{ ...row, first_buyer: 'fibs' }])[0].firstBuyer).toBeNull();
  });
});

describe('normalizeTraders / normalizeTraderProfile', () => {
  it('requires a handle on a roster row', () => {
    expect(normalizeTraders([{ address: '0x1' }])).toEqual([]);
    expect(normalizeTraders([{ handle: 'unipcs', volume: 307976.09 }])[0].handle).toBe('unipcs');
  });

  it('parses a profile and its bags, dropping bags with no token', () => {
    const profile = normalizeTraderProfile({
      address: '0x80f3',
      handle: 'fibs',
      display_name: 'fibs (6,9)',
      followers: 31047,
      num_trades: 2147,
      volume_usd: 6029343,
      solana_address: 'FhsbQzAJWVDNwaH61cTo6XkkfEsmSYMZKs9VJHH32bVG',
      profile_url: 'https://fomo.family/profile/fibs',
      streak: 2,
      bags: [
        { token: '0xcdbb', symbol: 'OPAR', amount: 9088089.6, pnl: -470.1, pnl_pct: -47.36, priced: true },
        { symbol: 'NOPE' },
        null,
      ],
    });
    expect(profile?.handle).toBe('fibs');
    expect(profile?.bags).toHaveLength(1);
    expect(profile?.bags[0]).toMatchObject({ token: '0xcdbb', symbol: 'OPAR', priced: true });
  });

  it('returns null without a handle', () => {
    expect(normalizeTraderProfile({ address: '0x1' })).toBeNull();
    expect(normalizeTraderProfile(undefined)).toBeNull();
  });
});

describe('normalizeOverview', () => {
  it('maps the 24h aggregate block', () => {
    const overview = normalizeOverview({
      window: '24h',
      fills: 3842,
      buys: 2844,
      sells: 998,
      active_traders: 106,
      tokens: 439,
      volume: 9319396.05,
      realized_pnl: -896020.63,
      unrealized_pnl: 9092177.09,
      net_pnl: 8196156.46,
      win_rate: 0.3882978723404255,
      closed_trades: 376,
    });
    expect(overview).toMatchObject({ window: '24h', activeTraders: 106, winRate: 0.3882978723404255 });
  });
});

describe('normalizeFlow', () => {
  // This is robinhoodtrenches' OWN lead/follower read. It is surfaced under its
  // own label and is deliberately NOT fused into OCT's convergence detector.
  const row = {
    token: '0xcdbb7008414aaf31de517dfea5bc1b09e9626690',
    symbol: 'OPAR',
    name: 'oPar',
    lead: { ts: 1788716132, usd: 997.4, handle: '31337___', followers: 38780, wallet: '0xc9ca' },
    followers: [
      { ts: 1788716421, usd: 3993.09, handle: 'rasmr', lag_seconds: 289 },
      'garbage',
      null,
    ],
  };

  it('parses lead and followers, dropping malformed follower entries', () => {
    const [parsed] = normalizeFlow([row]);
    expect(parsed.lead?.handle).toBe('31337___');
    expect(parsed.followers).toHaveLength(1);
    expect(parsed.followers[0].lagSeconds).toBe(289);
  });

  it('drops a row with no token and returns empty for a non-array body', () => {
    expect(normalizeFlow([{ ...row, token: undefined }])).toEqual([]);
    expect(normalizeFlow({ rows: [row] })).toEqual([]);
  });
});
