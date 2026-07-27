import { describe, expect, it } from 'vitest';
import type { Address, LpPosition } from '../src/types.js';
import { resolveDecreaseLiquidityPercent } from '../src/lifecycle/decreaseLiquidity.js';

const WETH = '0x1111111111111111111111111111111111111111' as Address;
const USDC = '0x2222222222222222222222222222222222222222' as Address;
const POOL = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as Address;

function position(valueUsd = 1000): LpPosition {
  return {
    tokenId: '1001',
    pool: {
      address: POOL,
      chainId: 1,
      platform: 'uniswap_v3',
      feeTierBps: 3000,
      token0: { address: WETH, symbol: 'WETH', decimals: 18 },
      token1: { address: USDC, symbol: 'USDC', decimals: 6 },
      tvlUsd: 1_000_000,
      volume24hUsd: 100_000,
      feeApr: 0.1,
    },
    status: 'in_range',
    tickLower: 0,
    tickUpper: 100,
    currentTick: 50,
    valueUsd,
    unclaimedFeesUsd: 5,
    openedAt: Date.now(),
    lastCompoundedAt: null,
  };
}

describe('resolveDecreaseLiquidityPercent', () => {
  it('passes through percent mode', () => {
    const result = resolveDecreaseLiquidityPercent({ liquidityPercent: 0.25 }, position(), WETH);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.liquidityPercent).toBe(0.25);
  });

  it('derives percent from USDC amountOut', () => {
    const result = resolveDecreaseLiquidityPercent({ amountOut: '100000000' }, position(200), USDC);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.liquidityPercent).toBe(0.5);
  });
});
