import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_BUY_ETH,
  DEFAULT_DAILY_CAP_ETH,
  DEFAULT_DEADLINE_SECONDS,
  DEFAULT_MIN_LIQUIDITY_USD,
  DEFAULT_MIN_ROUNDTRIP_BPS,
  DEFAULT_SLIPPAGE_BPS,
  MAX_BUY_ETH,
  MAX_DAILY_CAP_ETH,
  hasEvmSigningKey,
  parseAmount,
  parseGateEnabled,
  parseTriggerChatIds,
  parseRpcUrl,
  readEvmSniperConfig,
  type EnvBag,
} from '../src/sniper/evm/config';
import { ROBINHOOD_DEFAULT_RPC_URL } from '../src/sniper/evm/chain';

// Every warning path in this module logs. Silenced so the suite output stays
// readable; the assertions are about the returned values, not the noise.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseAmount — the one numeric funnel', () => {
  it('accepts a real positive number', () => {
    expect(parseAmount('0.05', 0.01)).toBe(0.05);
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['a unit suffix', '0.1 ETH'],
    ['words', 'ten'],
    ['zero', '0'],
    ['negative', '-1'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
  ])('falls back to the default for %s', (_label, raw) => {
    expect(parseAmount(raw, 0.01)).toBe(0.01);
  });

  it('NEVER yields an unbounded value — a huge number clamps to the ceiling', () => {
    // The whole point of the module: a cap that does not cap is worse than no
    // cap, because it looks like one.
    expect(parseAmount('1e9', 0.1, { max: MAX_DAILY_CAP_ETH })).toBe(MAX_DAILY_CAP_ETH);
    expect(parseAmount('999999', 0.1, { max: MAX_DAILY_CAP_ETH })).toBe(MAX_DAILY_CAP_ETH);
  });
});

describe('readEvmSniperConfig — defaults', () => {
  it('an empty environment yields every documented default', () => {
    const c = readEvmSniperConfig({});
    expect(c.buyEth).toBe(DEFAULT_BUY_ETH);
    expect(c.dailyCapEth).toBe(DEFAULT_DAILY_CAP_ETH);
    expect(c.slippageBps).toBe(DEFAULT_SLIPPAGE_BPS);
    expect(c.minLiquidityUsd).toBe(DEFAULT_MIN_LIQUIDITY_USD);
    expect(c.minRoundTripBps).toBe(DEFAULT_MIN_ROUNDTRIP_BPS);
    expect(c.deadlineSeconds).toBe(DEFAULT_DEADLINE_SECONDS);
    expect(c.rpcUrl).toBe(ROBINHOOD_DEFAULT_RPC_URL);
    expect(c.declaredWalletAddress).toBeNull();
  });

  it('the operator spec: 0.01 ETH per fire, 0.1 ETH per day', () => {
    expect(DEFAULT_BUY_ETH).toBe(0.01);
    expect(DEFAULT_DAILY_CAP_ETH).toBe(0.1);
  });

  it('BOTH gates default ON with nothing set', () => {
    const c = readEvmSniperConfig({});
    expect(c.liquidityGateEnabled).toBe(true);
    expect(c.sellSimGateEnabled).toBe(true);
  });

  it('garbage in every numeric var still yields the defaults, never unlimited', () => {
    const env: EnvBag = {
      SNIPER_EVM_BUY_ETH: 'lots',
      SNIPER_EVM_DAILY_CAP_ETH: '',
      SNIPER_EVM_SLIPPAGE_BPS: '-4',
      SNIPER_EVM_MIN_LIQUIDITY_USD: 'NaN',
      SNIPER_EVM_MIN_ROUNDTRIP_BPS: '1e400',
      SNIPER_EVM_DEADLINE_SECONDS: '0',
    };
    const c = readEvmSniperConfig(env);
    expect(c.buyEth).toBe(DEFAULT_BUY_ETH);
    expect(c.dailyCapEth).toBe(DEFAULT_DAILY_CAP_ETH);
    expect(c.slippageBps).toBe(DEFAULT_SLIPPAGE_BPS);
    expect(c.minLiquidityUsd).toBe(DEFAULT_MIN_LIQUIDITY_USD);
    expect(c.minRoundTripBps).toBe(DEFAULT_MIN_ROUNDTRIP_BPS);
    expect(c.deadlineSeconds).toBe(DEFAULT_DEADLINE_SECONDS);
    // And nothing is Infinity, which is the specific shape of "uncapped" that
    // survives a `> cap` comparison by making it always false.
    for (const v of [c.buyEth, c.dailyCapEth, c.minLiquidityUsd]) expect(Number.isFinite(v)).toBe(true);
  });

  it('clamps an over-large daily cap down to the hard ceiling', () => {
    expect(readEvmSniperConfig({ SNIPER_EVM_DAILY_CAP_ETH: '50' }).dailyCapEth).toBe(MAX_DAILY_CAP_ETH);
  });

  it('clamps an over-large per-fire size down to the hard ceiling', () => {
    expect(readEvmSniperConfig({ SNIPER_EVM_BUY_ETH: '5' }).buyEth).toBe(MAX_BUY_ETH);
  });

  it('raises a daily cap that sits below one fire, so the module is not a silent outage', () => {
    const c = readEvmSniperConfig({ SNIPER_EVM_BUY_ETH: '0.05', SNIPER_EVM_DAILY_CAP_ETH: '0.01' });
    expect(c.buyEth).toBe(0.05);
    expect(c.dailyCapEth).toBe(0.05); // exactly one fire — the only upward move in the module
  });

  it('honours real operator values', () => {
    const c = readEvmSniperConfig({
      SNIPER_EVM_BUY_ETH: '0.02',
      SNIPER_EVM_DAILY_CAP_ETH: '0.2',
      SNIPER_EVM_SLIPPAGE_BPS: '300',
      SNIPER_EVM_MIN_LIQUIDITY_USD: '10000',
    });
    expect(c).toMatchObject({ buyEth: 0.02, dailyCapEth: 0.2, slippageBps: 300, minLiquidityUsd: 10_000 });
  });
});

describe('parseGateEnabled — a gate only turns off deliberately', () => {
  it.each(['0', 'false', 'no', 'off', 'FALSE', ' Off '])('turns off for %s', (raw) => {
    expect(parseGateEnabled(raw, 'X')).toBe(false);
  });

  it.each([undefined, '', '1', 'true', 'yes', 'on'])('stays on for %s', (raw) => {
    expect(parseGateEnabled(raw, 'X')).toBe(true);
  });

  it('an unrecognised spelling leaves the gate ON, not off', () => {
    // Fails toward "spend less". The opposite polarity would let a typo in a
    // safety flag silently disable a pre-trade check.
    expect(parseGateEnabled('disabled', 'X')).toBe(true);
    expect(parseGateEnabled('nope', 'X')).toBe(true);
  });
});

describe('parseTriggerChatIds — fails closed', () => {
  it('is EMPTY when unset, and empty means nothing fires', () => {
    expect(parseTriggerChatIds(undefined).size).toBe(0);
    expect(parseTriggerChatIds('').size).toBe(0);
    expect(parseTriggerChatIds('  ,  , ').size).toBe(0);
  });

  it('parses a comma-separated list of Bot-API ids', () => {
    const s = parseTriggerChatIds('-1001234567890, -1009876543210');
    expect([...s]).toEqual(['-1001234567890', '-1009876543210']);
  });

  it('drops malformed entries instead of widening the gate', () => {
    const s = parseTriggerChatIds('-1001234567890, @cipher, https://t.me/x, 12abc');
    expect([...s]).toEqual(['-1001234567890']);
  });

  it('keeps ids as STRINGS, matching TelegramRawMessage.chatId', () => {
    const s = parseTriggerChatIds('-1001234567890');
    expect(s.has('-1001234567890')).toBe(true);
    expect(s.has(String(-1001234567890))).toBe(true);
  });
});

describe('parseRpcUrl', () => {
  it('defaults to the Robinhood Chain RPC', () => {
    expect(parseRpcUrl(undefined)).toBe(ROBINHOOD_DEFAULT_RPC_URL);
  });
  it('accepts an http(s) override', () => {
    expect(parseRpcUrl('https://my-node.example/rpc')).toBe('https://my-node.example/rpc');
  });
  it.each(['file:///etc/passwd', 'not a url', 'ftp://x/y'])('rejects %s and falls back', (raw) => {
    expect(parseRpcUrl(raw)).toBe(ROBINHOOD_DEFAULT_RPC_URL);
  });
});

describe('hasEvmSigningKey', () => {
  it('returns a bare boolean and never the value', () => {
    expect(hasEvmSigningKey({})).toBe(false);
    expect(hasEvmSigningKey({ SNIPER_EVM_PRIVATE_KEY: '   ' })).toBe(false);
    expect(hasEvmSigningKey({ SNIPER_EVM_PRIVATE_KEY: `0x${'ab'.repeat(32)}` })).toBe(true);
  });

  it('is not part of the parsed config object, so it cannot be cached', () => {
    const c = readEvmSniperConfig({ SNIPER_EVM_PRIVATE_KEY: `0x${'ab'.repeat(32)}` });
    // No property of the config carries the key, or anything derived from it.
    expect(JSON.stringify([...Object.values(c)])).not.toContain('abab');
  });
});

describe('declared wallet address', () => {
  it('is kept when well-formed', () => {
    const a = '0x1111111111111111111111111111111111111111';
    expect(readEvmSniperConfig({ SNIPER_EVM_WALLET_ADDRESS: a }).declaredWalletAddress).toBe(a);
  });
  it('is dropped when malformed rather than half-trusted', () => {
    expect(readEvmSniperConfig({ SNIPER_EVM_WALLET_ADDRESS: '0x123' }).declaredWalletAddress).toBeNull();
  });
});
