import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mapHolders, mapTokenInfo, resolveNetworkId, DEFAULT_NETWORK_ID } from '../src/bot/service';
import { requireBotAuth } from '../src/auth/botAuth';

const SOL_NET = 1399811149;
const ADDR = 'So11111111111111111111111111111111111111112';

// Realistic /hodlers/top batch envelope (matches fomo/store.ts matchHoldersToTracked
// and the old Outpost bot's parsing).
const hodlersFixture = {
  responseObject: [
    {
      tokenAddress: ADDR,
      networkId: SOL_NET,
      topHolders: [
        { user: { displayName: 'Whale One', userHandle: 'whale1' }, value: 125000, pnl: 42000, address: 'Wallet111' },
        { user: { username: 'shrimp' }, value: '999.5', pnl: -120.25, walletAddress: 'Wallet222' },
        { value: 5, pnl: 0 }, // no user, no address
      ],
    },
  ],
};

// Realistic /proxy/filterTokens envelope (mirrors FomoClient.getTokenMetadata parsing).
const filterFixture = {
  responseObject: [
    {
      token: {
        address: ADDR,
        networkId: SOL_NET,
        symbol: 'WSOL',
        name: 'Wrapped SOL',
        info: { description: 'Wrapped Solana', imageLargeUrl: 'https://img/x.png' },
        socialLinks: { twitter: 'https://x.com/solana', website: 'https://solana.com', telegram: null },
      },
      marketCap: '81000000000',
      priceUSD: '172.5',
    },
  ],
};

describe('resolveNetworkId', () => {
  it('accepts numeric FOMO ids that OCT supports', () => {
    expect(resolveNetworkId('1399811149')).toBe(SOL_NET);
    expect(resolveNetworkId(8453)).toBe(8453);
  });
  it('accepts OCT chain slugs (incl. aliases)', () => {
    expect(resolveNetworkId('sol')).toBe(SOL_NET);
    expect(resolveNetworkId('eth')).toBe(1);
    expect(resolveNetworkId('bnb')).toBe(56);
    expect(resolveNetworkId('base')).toBe(8453);
    expect(resolveNetworkId('hood')).toBe(143);
  });
  it('rejects unknown networks and empty input', () => {
    expect(resolveNetworkId('dogechain')).toBeNull();
    expect(resolveNetworkId('12345')).toBeNull();
    expect(resolveNetworkId('')).toBeNull();
    expect(resolveNetworkId(undefined)).toBeNull();
  });
  it('defaults to Solana', () => {
    expect(DEFAULT_NETWORK_ID).toBe(SOL_NET);
  });
});

describe('mapHolders', () => {
  it('maps holder rows with rank, name precedence, and numeric coercion', () => {
    const holders = mapHolders(hodlersFixture, ADDR, SOL_NET);
    expect(holders).toHaveLength(3);
    expect(holders[0]).toEqual({ rank: 1, name: 'Whale One', address: 'Wallet111', valueUsd: 125000, pnlUsd: 42000 });
    // string value coerced; username fallback; walletAddress alias
    expect(holders[1]).toEqual({ rank: 2, name: 'shrimp', address: 'Wallet222', valueUsd: 999.5, pnlUsd: -120.25 });
    // no user + no address → em-dash placeholder
    expect(holders[2].name).toBe('—');
    expect(holders[2].address).toBe('');
  });
  it('matches the entry by address+networkId case-insensitively', () => {
    const holders = mapHolders(hodlersFixture, ADDR.toLowerCase(), SOL_NET);
    expect(holders).toHaveLength(3);
  });
  it('returns [] for an empty/foreign payload', () => {
    expect(mapHolders({}, ADDR, SOL_NET)).toEqual([]);
    expect(mapHolders({ responseObject: [] }, ADDR, SOL_NET)).toEqual([]);
  });
});

describe('mapTokenInfo', () => {
  it('extracts symbol/name/mcap/price/icon/socials', () => {
    const info = mapTokenInfo(filterFixture, ADDR, SOL_NET);
    expect(info.symbol).toBe('WSOL');
    expect(info.name).toBe('Wrapped SOL');
    expect(info.marketCap).toBe(81000000000);
    expect(info.priceUsd).toBe(172.5);
    expect(info.iconUrl).toBe('https://img/x.png');
    expect(info.socials).toEqual({ twitter: 'https://x.com/solana', website: 'https://solana.com' });
  });
  it('returns an empty shell when the token is not in the payload', () => {
    const info = mapTokenInfo(filterFixture, '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 1);
    expect(info.symbol).toBeNull();
    expect(info.socials).toEqual({});
    expect(info.address).toBe('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  });
});

describe('requireBotAuth', () => {
  const KEY = 'oct_bot_test_secret_key_123';

  function mockReqRes(auth?: string) {
    const req = { headers: auth ? { authorization: auth } : {} } as any;
    const json = vi.fn();
    const res = { status: vi.fn().mockReturnValue({ json }), json } as any;
    const next = vi.fn();
    return { req, res, next, json };
  }

  beforeEach(() => { process.env.OCT_BOT_API_KEY = KEY; });
  afterEach(() => { delete process.env.OCT_BOT_API_KEY; });

  it('503s when no key is configured', () => {
    delete process.env.OCT_BOT_API_KEY;
    const { req, res, next } = mockReqRes(`Bearer ${KEY}`);
    requireBotAuth(req, res, () => next());
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('401s on missing, malformed, or wrong tokens', () => {
    for (const auth of [undefined, 'Bearer ', 'Bearer wrong-key', KEY /* no Bearer prefix */]) {
      const { req, res, next } = mockReqRes(auth);
      requireBotAuth(req, res, () => next());
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('calls next() on the correct key', () => {
    const { req, res, next } = mockReqRes(`Bearer ${KEY}`);
    requireBotAuth(req, res, next as any);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
