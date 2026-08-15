import { describe, it, expect } from 'vitest';
import {
  FOMO_ACTIVITY_MAX_LIMIT,
  activityKind,
  clampActivityLimit,
  deriveSwapDirection,
  extractActivityEnvelope,
  normalizeActivityEntry,
  summarizeTraderActivity,
} from '../src/fomo/activity.js';

// Real addresses, so the quote-token set in fomo/store.ts is exercised for real.
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WSOL = 'So11111111111111111111111111111111111111112';
const MEME_A = 'GkyPYa7NnCF6bABGZQfmiJdgHHgh1ecgurbnLpdMpump';
const MEME_B = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';

const SOL_NET = 1399811149;
const BASE_NET = 8453;

// A realistic /v2/users/{id}/activity swap record.
const swapRecord = (over: Record<string, unknown> = {}) => ({
  activityType: 'swap',
  id: 'swap-1',
  address: 'FakePlatformAddress1111111111111111111111111',
  networkId: SOL_NET,
  inTokenAddress: SOL_USDC,
  inAmount: '250000000',
  inHumanAmount: 250,
  outTokenAddress: MEME_A,
  outAmount: '1000000000',
  outHumanAmount: 1000,
  humanUsdAmountIn: 250,
  humanUsdAmountOut: 248.5,
  createdAt: '2026-08-15T12:00:00.000Z',
  platformFeeHumanAmount: 1.25,
  provider: 'RELAY',
  inNetworkId: SOL_NET,
  outNetworkId: SOL_NET,
  isCrossmint: true,
  isOffPlatform: false,
  ...over,
});

const transferRecord = (over: Record<string, unknown> = {}) => ({
  activityType: 'transfer',
  id: 'xfer-1',
  toAddress: 'FakePlatformAddress1111111111111111111111111',
  fromAddress: 'SomeOtherAddress2222222222222222222222222222',
  tokenAddress: SOL_USDC,
  networkId: SOL_NET,
  humanAmount: 500,
  usdAmount: 500,
  type: 'DEPOSIT',
  createdAt: '2026-08-14T09:00:00.000Z',
  tokenMetadata: { symbol: 'USDC', imageLargeUrl: 'https://example.test/usdc.png' },
  ...over,
});

describe('deriveSwapDirection', () => {
  it('calls stablecoin → token a buy', () => {
    expect(deriveSwapDirection(SOL_USDC, MEME_A)).toBe('buy');
    expect(deriveSwapDirection(BASE_USDC, '0xdeadbeef00000000000000000000000000000001')).toBe('buy');
  });

  it('calls token → stablecoin a sell', () => {
    expect(deriveSwapDirection(MEME_A, SOL_USDC)).toBe('sell');
    expect(deriveSwapDirection('0xdeadbeef00000000000000000000000000000001', BASE_USDC)).toBe('sell');
  });

  it('treats a wrapped native as a quote leg too', () => {
    expect(deriveSwapDirection(WSOL, MEME_A)).toBe('buy');
    expect(deriveSwapDirection(MEME_A, WSOL)).toBe('sell');
  });

  it('calls token → token a swap rather than guessing a side', () => {
    expect(deriveSwapDirection(MEME_A, MEME_B)).toBe('swap');
  });

  it('calls stablecoin → stablecoin a swap, not a buy or a sell', () => {
    expect(deriveSwapDirection(SOL_USDC, SOL_USDT)).toBe('swap');
    expect(deriveSwapDirection(SOL_USDC, WSOL)).toBe('swap');
  });

  it('is case-insensitive for EVM addresses', () => {
    expect(deriveSwapDirection(BASE_USDC.toUpperCase().replace('0X', '0x'), MEME_B)).toBe('buy');
  });

  it('treats a missing leg as a non-quote token', () => {
    expect(deriveSwapDirection(null, SOL_USDC)).toBe('sell');
    expect(deriveSwapDirection(SOL_USDC, undefined)).toBe('buy');
    expect(deriveSwapDirection(null, null)).toBe('swap');
  });
});

describe('activityKind', () => {
  it('discriminates swap from transfer on activityType', () => {
    expect(activityKind(swapRecord())).toBe('swap');
    expect(activityKind(transferRecord())).toBe('transfer');
  });

  it('rejects unknown or missing record types rather than guessing', () => {
    expect(activityKind({ activityType: 'perp' })).toBeNull();
    expect(activityKind({ inTokenAddress: SOL_USDC, outTokenAddress: MEME_A })).toBeNull();
    expect(activityKind(null)).toBeNull();
    expect(activityKind('swap')).toBeNull();
  });
});

describe('normalizeActivityEntry — swaps', () => {
  it('shapes a buy around the token leg, not the stablecoin leg', () => {
    const entry = normalizeActivityEntry(swapRecord());
    expect(entry).toMatchObject({
      kind: 'swap',
      id: 'swap-1',
      direction: 'buy',
      tokenAddress: MEME_A,
      quoteTokenAddress: SOL_USDC,
      networkId: SOL_NET,
      provider: 'RELAY',
      at: '2026-08-15T12:00:00.000Z',
    });
    // Buys are sized by what was spent.
    expect(entry).toMatchObject({ usdValue: 250 });
    expect(entry?.explorerUrl).toBe(`https://solscan.io/token/${MEME_A}`);
  });

  it('shapes a sell around the token leg and sizes it by proceeds', () => {
    const entry = normalizeActivityEntry(
      swapRecord({ inTokenAddress: MEME_A, outTokenAddress: SOL_USDC }),
    );
    expect(entry).toMatchObject({
      kind: 'swap',
      direction: 'sell',
      tokenAddress: MEME_A,
      quoteTokenAddress: SOL_USDC,
      usdValue: 248.5,
    });
  });

  it('keeps a token↔token rotation as a swap with both legs recorded', () => {
    const entry = normalizeActivityEntry(
      swapRecord({ inTokenAddress: MEME_A, outTokenAddress: MEME_B }),
    );
    expect(entry).toMatchObject({
      kind: 'swap',
      direction: 'swap',
      tokenAddress: MEME_B,
      quoteTokenAddress: MEME_A,
    });
  });

  it('uses the per-leg network id for a cross-chain swap', () => {
    const entry = normalizeActivityEntry(
      swapRecord({
        inTokenAddress: SOL_USDC,
        inNetworkId: SOL_NET,
        outTokenAddress: '0xdeadbeef00000000000000000000000000000001',
        outNetworkId: BASE_NET,
      }),
    );
    expect(entry).toMatchObject({ direction: 'buy', networkId: BASE_NET });
    expect(entry?.explorerUrl).toBe(
      'https://basescan.org/token/0xdeadbeef00000000000000000000000000000001',
    );
  });

  it('leaves explorerUrl null for an unmapped network', () => {
    const entry = normalizeActivityEntry(swapRecord({ inNetworkId: 424242, outNetworkId: 424242, networkId: 424242 }));
    expect(entry?.explorerUrl).toBeNull();
  });

  it('drops a swap with neither leg addressed', () => {
    expect(
      normalizeActivityEntry(swapRecord({ inTokenAddress: null, outTokenAddress: null })),
    ).toBeNull();
  });
});

describe('normalizeActivityEntry — transfers', () => {
  it('shapes a deposit with its metadata symbol and both endpoints', () => {
    expect(normalizeActivityEntry(transferRecord())).toEqual({
      kind: 'transfer',
      id: 'xfer-1',
      at: '2026-08-14T09:00:00.000Z',
      transferType: 'DEPOSIT',
      tokenAddress: SOL_USDC,
      tokenSymbol: 'USDC',
      networkId: SOL_NET,
      amount: 500,
      usdValue: 500,
      fromAddress: 'SomeOtherAddress2222222222222222222222222222',
      toAddress: 'FakePlatformAddress1111111111111111111111111',
      explorerUrl: `https://solscan.io/token/${SOL_USDC}`,
    });
  });

  it('never assigns a transfer a buy/sell direction', () => {
    const entry = normalizeActivityEntry(transferRecord());
    expect(entry?.kind).toBe('transfer');
    expect(entry).not.toHaveProperty('direction');
  });
});

describe('extractActivityEnvelope', () => {
  it('reads activities and hasNextPage out of the responseObject envelope', () => {
    expect(
      extractActivityEnvelope({
        success: true,
        message: 'ok',
        responseObject: { activities: [swapRecord()], hasNextPage: true },
      }),
    ).toMatchObject({ hasNextPage: true });
  });

  it('defaults hasNextPage to false and tolerates junk', () => {
    expect(extractActivityEnvelope(null)).toEqual({ activities: [], hasNextPage: false });
    expect(extractActivityEnvelope({ responseObject: {} })).toEqual({
      activities: [],
      hasNextPage: false,
    });
    expect(extractActivityEnvelope([swapRecord()]).activities).toHaveLength(1);
  });
});

describe('summarizeTraderActivity', () => {
  const entries = [
    swapRecord({ id: 'b1' }),
    swapRecord({ id: 'b2', humanUsdAmountIn: 100 }),
    swapRecord({ id: 's1', inTokenAddress: MEME_A, outTokenAddress: SOL_USDC, humanUsdAmountOut: 400 }),
    swapRecord({ id: 'r1', inTokenAddress: MEME_A, outTokenAddress: MEME_B, humanUsdAmountIn: 9999 }),
    transferRecord(),
  ]
    .map(normalizeActivityEntry)
    .filter((e) => e !== null);

  it('counts swaps and transfers separately', () => {
    const summary = summarizeTraderActivity(entries);
    expect(summary.swapCount).toBe(4);
    expect(summary.transferCount).toBe(1);
  });

  it('totals only directional swaps, so a rotation never inflates either side', () => {
    const summary = summarizeTraderActivity(entries);
    expect(summary.buyUsd).toBe(350);
    expect(summary.sellUsd).toBe(400);
  });

  it('reports the window bounds by timestamp, oldest first', () => {
    const summary = summarizeTraderActivity(entries);
    expect(summary.fromAt).toBe('2026-08-14T09:00:00.000Z');
    expect(summary.toAt).toBe('2026-08-15T12:00:00.000Z');
  });

  it('is empty-safe', () => {
    expect(summarizeTraderActivity([])).toEqual({
      swapCount: 0,
      transferCount: 0,
      buyUsd: 0,
      sellUsd: 0,
      fromAt: null,
      toAt: null,
    });
  });
});

describe('clampActivityLimit', () => {
  it('never exceeds the upstream cap that returns HTTP 400', () => {
    expect(clampActivityLimit(500)).toBe(FOMO_ACTIVITY_MAX_LIMIT);
    expect(clampActivityLimit(101)).toBe(100);
  });

  it('floors at 1 and defaults on junk', () => {
    expect(clampActivityLimit(0)).toBe(1);
    expect(clampActivityLimit(-5)).toBe(1);
    expect(clampActivityLimit(Number.NaN)).toBe(FOMO_ACTIVITY_MAX_LIMIT);
    expect(clampActivityLimit(undefined)).toBe(FOMO_ACTIVITY_MAX_LIMIT);
    expect(clampActivityLimit(25)).toBe(25);
  });
});
