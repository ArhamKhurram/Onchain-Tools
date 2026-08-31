import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mapHolders,
  mapTokenInfo,
  resolveNetworkId,
  DEFAULT_NETWORK_ID,
  EVM_NETWORK_IDS,
  candidateNetworkIds,
  isEvmAddress,
} from '../src/bot/service';
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

// Realistic /proxy/filterTokens envelope (matches bot/service.ts mapTokenInfo parsing).
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
  it('falls back to the first entry only when not strict', () => {
    // Regression: probing several networks in one batch must not attribute
    // BSC's holders to Ethereum just because Ethereum had no entry.
    expect(mapHolders(hodlersFixture, ADDR, 1)).toHaveLength(3);
    expect(mapHolders(hodlersFixture, ADDR, 1, true)).toEqual([]);
  });
});

describe('candidateNetworkIds — chain detection for /holders', () => {
  const EVM_TOKEN = '0xfe189e97832da1573e4e4ff034f4ffc3a15c7777';

  it('recognises EVM vs base58 addresses', () => {
    expect(isEvmAddress(EVM_TOKEN)).toBe(true);
    expect(isEvmAddress(` ${EVM_TOKEN.toUpperCase().replace('0X', '0x')} `)).toBe(true);
    expect(isEvmAddress(ADDR)).toBe(false);
    expect(isEvmAddress('0xnothex')).toBe(false);
  });

  it('probes every EVM chain for an 0x address, never Solana', () => {
    const ids = candidateNetworkIds(EVM_TOKEN);
    expect(ids).toEqual([...EVM_NETWORK_IDS]);
    expect(ids).not.toContain(DEFAULT_NETWORK_ID);
  });

  it('keeps a base58 address on Solana alone', () => {
    expect(candidateNetworkIds(ADDR)).toEqual([DEFAULT_NETWORK_ID]);
  });

  it('picks the chain that actually has holders', () => {
    // What FOMO returns for 0xfe18…7777: holders on BSC, empty on the rest.
    const batch = {
      responseObject: [
        { tokenAddress: EVM_TOKEN, networkId: 56, topHolders: [{ user: { userHandle: 'loganlim_x' }, value: 10, pnl: 1 }] },
        { tokenAddress: EVM_TOKEN, networkId: 1, topHolders: [], totalHolders: 0 },
        { tokenAddress: EVM_TOKEN, networkId: 8453, topHolders: [], totalHolders: 0 },
        { tokenAddress: EVM_TOKEN, networkId: 143, topHolders: [], totalHolders: 0 },
      ],
    };
    const winner = candidateNetworkIds(EVM_TOKEN)
      .map((id) => ({ id, holders: mapHolders(batch, EVM_TOKEN, id, true) }))
      .reduce((best, cur) => (cur.holders.length > best.holders.length ? cur : best));
    expect(winner.id).toBe(56);
    expect(winner.holders[0].name).toBe('loganlim_x');
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
