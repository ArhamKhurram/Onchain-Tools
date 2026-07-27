import { describe, expect, it } from 'vitest';
import { decreaseIssuesByField, validateDecreaseForm, type LpDecreaseFormValues } from '../src/components/lp/decrease';
import type { LpPositionView } from '../src/components/lp/positions';

const POSITION: LpPositionView = {
  tokenId: '1001',
  poolAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  platform: 'uniswap_v3',
  feeTierBps: 3000,
  token0: { address: '0x1111111111111111111111111111111111111111', symbol: 'WETH', decimals: 18 },
  token1: { address: '0x2222222222222222222222222222222222222222', symbol: 'USDC', decimals: 6 },
  status: 'in_range',
  valueUsd: 1000,
  unclaimedFeesUsd: 5,
  minPrice: 0.5,
  maxPrice: 2,
  currentPrice: 1,
  isAllowlisted: true,
  managedByAutomation: true,
};

describe('validateDecreaseForm', () => {
  it('accepts percent mode', () => {
    const values: LpDecreaseFormValues = {
      tokenOutAddress: POSITION.token0!.address,
      mode: 'percent',
      percent: '50',
      amount: '',
      slippagePercent: '0.5',
    };
    const { issues, request } = validateDecreaseForm(values, POSITION);
    expect(issues).toHaveLength(0);
    expect(request?.liquidityPercent).toBe(0.5);
  });

  it('maps issues by field', () => {
    expect(decreaseIssuesByField([{ field: 'percent', message: 'bad' }]).percent).toBe('bad');
  });
});
