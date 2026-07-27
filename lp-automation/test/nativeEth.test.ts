import { describe, expect, it } from 'vitest';
import {
  NATIVE_ETH_ADDRESS,
  isNativeEthAddress,
  poolHasWethSide,
  resolveZapTokenIn,
} from '../src/calldata/nativeEth.js';
import { ROBINHOOD_WETH } from '../src/calldata/erc20Approve.js';
import type { Address } from '../src/types.js';

const USDC = '0x2222222222222222222222222222222222222222' as Address;
const OTHER = '0x3333333333333333333333333333333333333333' as Address;

describe('nativeEth', () => {
  it('recognises the Krystal native-token sentinel', () => {
    expect(isNativeEthAddress(NATIVE_ETH_ADDRESS)).toBe(true);
    expect(isNativeEthAddress(NATIVE_ETH_ADDRESS.toUpperCase())).toBe(true);
    expect(isNativeEthAddress(ROBINHOOD_WETH)).toBe(false);
  });

  it('detects a WETH pool side', () => {
    expect(poolHasWethSide(ROBINHOOD_WETH, USDC)).toBe(true);
    expect(poolHasWethSide(USDC, ROBINHOOD_WETH)).toBe(true);
    expect(poolHasWethSide(USDC, OTHER)).toBe(false);
  });

  it('maps native ETH to the WETH pool side and Krystal sentinel', () => {
    const resolved = resolveZapTokenIn({
      tokenInAddress: NATIVE_ETH_ADDRESS,
      poolToken0: ROBINHOOD_WETH,
      poolToken1: USDC,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.poolTokenAddress).toBe(ROBINHOOD_WETH.toLowerCase());
      expect(resolved.krystalTokenIn).toBe(NATIVE_ETH_ADDRESS);
      expect(resolved.isNative).toBe(true);
    }
  });

  it('passes ERC-20 tokenIn through unchanged', () => {
    const resolved = resolveZapTokenIn({
      tokenInAddress: USDC,
      poolToken0: ROBINHOOD_WETH,
      poolToken1: USDC,
    });
    expect(resolved).toEqual({
      ok: true,
      poolTokenAddress: USDC,
      krystalTokenIn: USDC,
      isNative: false,
    });
  });

  it('refuses native ETH when the pool has no WETH side', () => {
    const resolved = resolveZapTokenIn({
      tokenInAddress: NATIVE_ETH_ADDRESS,
      poolToken0: USDC,
      poolToken1: OTHER,
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toContain('WETH pool side');
  });

  it('refuses a token that is not in the pool', () => {
    const resolved = resolveZapTokenIn({
      tokenInAddress: OTHER,
      poolToken0: ROBINHOOD_WETH,
      poolToken1: USDC,
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toContain('is not in pool');
  });
});
