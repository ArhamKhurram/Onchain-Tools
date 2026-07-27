import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SWAP_SLIPPAGE,
  MAX_SWAP_SLIPPAGE,
  NATIVE_ETH_ADDRESS,
  buildEnterPools,
  depositTokenOptions,
  findEnterPool,
  parseEnterCommand,
  parseSlippagePercent,
  toBaseUnits,
  validateEnterForm,
  type LpEnterFormValues,
  type LpEnterPool,
} from '../src/components/lp/enter';
import type { LpPositionView } from '../src/components/lp/positions';
import type { PoolCandidate } from '../src/components/lp/types';

const POOL_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const POOL_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const WETH = '0x1111111111111111111111111111111111111111';
const USDC = '0x2222222222222222222222222222222222222222';

// --- Amount conversion: no floating point, ever ------------------------------

describe('toBaseUnits', () => {
  it('scales a whole number by 18 decimals', () => {
    expect(toBaseUnits('1', 18)).toEqual({ ok: true, value: '1000000000000000000' });
  });

  it('scales a fractional number without float drift', () => {
    expect(toBaseUnits('1.5', 18)).toEqual({ ok: true, value: '1500000000000000000' });
    // 0.1 is the classic float failure — it must NOT become 100000000000000001.
    expect(toBaseUnits('0.1', 18)).toEqual({ ok: true, value: '100000000000000000' });
  });

  it('handles a leading-dot fraction', () => {
    expect(toBaseUnits('.5', 18)).toEqual({ ok: true, value: '500000000000000000' });
  });

  it('handles a trailing dot', () => {
    expect(toBaseUnits('1.', 18)).toEqual({ ok: true, value: '1000000000000000000' });
  });

  it('scales USDC (6 decimals)', () => {
    expect(toBaseUnits('1000000', 6)).toEqual({ ok: true, value: '1000000000000' });
    expect(toBaseUnits('0.000001', 6)).toEqual({ ok: true, value: '1' });
  });

  it('handles zero-decimal tokens', () => {
    expect(toBaseUnits('5', 0)).toEqual({ ok: true, value: '5' });
    expect(toBaseUnits('5.5', 0)).toEqual({ ok: false, error: expect.stringContaining('whole number') });
  });

  it('rejects more decimal places than the token allows', () => {
    const result = toBaseUnits('1.1234567', 6);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('6 decimal places');
  });

  it('rejects zero and empty', () => {
    expect(toBaseUnits('0', 18)).toEqual({ ok: false, error: expect.stringContaining('greater than zero') });
    expect(toBaseUnits('0.0', 18)).toEqual({ ok: false, error: expect.stringContaining('greater than zero') });
    expect(toBaseUnits('', 18)).toEqual({ ok: false, error: 'Enter an amount.' });
    expect(toBaseUnits('   ', 18)).toEqual({ ok: false, error: 'Enter an amount.' });
  });

  it('rejects non-numeric, signed, and malformed input', () => {
    for (const bad of ['abc', '-1', '1.2.3', '.', '1e18', '1,000', '0x5']) {
      expect(toBaseUnits(bad, 18).ok).toBe(false);
    }
  });

  it('handles very large values with BigInt precision', () => {
    // 123456789012345.123456789012345678 * 1e18 — well beyond Number precision.
    const result = toBaseUnits('123456789012345.123456789012345678', 18);
    expect(result).toEqual({ ok: true, value: '123456789012345123456789012345678' });
  });

  it('rejects unknown/absurd decimals', () => {
    expect(toBaseUnits('1', -1 as number).ok).toBe(false);
    expect(toBaseUnits('1', 1.5 as number).ok).toBe(false);
    expect(toBaseUnits('1', 999 as number).ok).toBe(false);
  });
});

// --- Slippage ----------------------------------------------------------------

describe('parseSlippagePercent', () => {
  it('defaults on blank', () => {
    expect(parseSlippagePercent('')).toEqual({ ok: true, fraction: DEFAULT_SWAP_SLIPPAGE });
    expect(parseSlippagePercent('   ')).toEqual({ ok: true, fraction: DEFAULT_SWAP_SLIPPAGE });
  });

  it('converts percent to fraction', () => {
    expect(parseSlippagePercent('0.5')).toEqual({ ok: true, fraction: 0.005 });
    expect(parseSlippagePercent('5')).toEqual({ ok: true, fraction: MAX_SWAP_SLIPPAGE });
  });

  it('rejects zero, negative and non-numeric', () => {
    expect(parseSlippagePercent('0').ok).toBe(false);
    expect(parseSlippagePercent('-1').ok).toBe(false);
    expect(parseSlippagePercent('abc').ok).toBe(false);
  });

  it('enforces the 5% cap', () => {
    const result = parseSlippagePercent('6');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('5%');
  });
});

// --- Pool derivation ---------------------------------------------------------

const wethUsdcCandidate: PoolCandidate = {
  address: POOL_A,
  chainId: 4663,
  platform: 'uniswapv3',
  feeTierBps: 3000,
  token0: { address: WETH, symbol: 'WETH', decimals: 18 },
  token1: { address: USDC, symbol: 'USDC', decimals: 6 },
  tvlUsd: 1_000_000,
  volume24hUsd: 500_000,
  feeApr: 0.42,
};

const position = (over: Partial<LpPositionView> = {}): LpPositionView => ({
  tokenId: '1001',
  poolAddress: POOL_A,
  platform: 'uniswapv3',
  feeTierBps: 500,
  token0: { symbol: 'WETH', address: WETH, decimals: 18 },
  token1: { symbol: 'USDC', address: USDC, decimals: 6 },
  status: 'in_range',
  valueUsd: 1_000,
  unclaimedFeesUsd: 12.5,
  minPrice: 1_800,
  maxPrice: 2_200,
  currentPrice: 2_000,
  isAllowlisted: true,
  managedByAutomation: true,
  ...over,
});

describe('buildEnterPools', () => {
  it('restricts to the saved allowlist', () => {
    const pools = buildEnterPools([POOL_A], [], [wethUsdcCandidate]);
    expect(pools).toHaveLength(1);
    expect(pools[0]!.address).toBe(POOL_A);
    expect(pools[0]!.pairLabel).toBe('WETH / USDC');
  });

  it('omits allowlisted pools with no known token metadata', () => {
    // POOL_B is allowlisted but appears in neither feed.
    const pools = buildEnterPools([POOL_A, POOL_B], [], [wethUsdcCandidate]);
    expect(pools.map((p) => p.address)).toEqual([POOL_A]);
  });

  it('derives metadata from held positions', () => {
    const pools = buildEnterPools([POOL_A], [position()], []);
    expect(pools).toHaveLength(1);
    expect(pools[0]!.held).toBe(true);
    expect(pools[0]!.token0.decimals).toBe(18);
  });

  it('prefers held-position metadata over discovery for the same pool', () => {
    const pools = buildEnterPools([POOL_A], [position({ feeTierBps: 500 })], [wethUsdcCandidate]);
    expect(pools).toHaveLength(1);
    expect(pools[0]!.held).toBe(true);
    expect(pools[0]!.feeTierBps).toBe(500); // from the position, not the candidate's 3000
  });

  it('omits a pool whose token decimals are invalid', () => {
    const bad = position({
      token0: { symbol: 'WETH', address: WETH, decimals: Number.NaN as unknown as number },
    });
    // Only the bad-metadata pool is allowlisted, and no candidate covers it.
    expect(buildEnterPools([POOL_A], [bad], [])).toHaveLength(0);
  });

  it('normalizes allowlist casing', () => {
    const pools = buildEnterPools([POOL_A.toUpperCase()], [], [wethUsdcCandidate]);
    expect(pools).toHaveLength(1);
  });

  it('finds a pool by address, case-insensitively', () => {
    const pools = buildEnterPools([POOL_A], [], [wethUsdcCandidate]);
    expect(findEnterPool(pools, POOL_A.toUpperCase())?.address).toBe(POOL_A);
    expect(findEnterPool(pools, POOL_B)).toBeNull();
  });
});

// --- Form validation ---------------------------------------------------------

const pool: LpEnterPool = {
  address: POOL_A,
  token0: { symbol: 'WETH', address: WETH, decimals: 18 },
  token1: { symbol: 'USDC', address: USDC, decimals: 6 },
  feeTierBps: 3000,
  pairLabel: 'WETH / USDC',
  held: false,
};

const values = (over: Partial<LpEnterFormValues> = {}): LpEnterFormValues => ({
  poolAddress: POOL_A,
  tokenInAddress: WETH,
  amount: '1',
  rangeStrategy: 'narrow',
  slippagePercent: '0.5',
  ...over,
});

const fieldsOf = (issues: { field: string }[]) => issues.map((i) => i.field);

describe('validateEnterForm', () => {
  it('accepts a complete form and builds the request', () => {
    const result = validateEnterForm(values(), pool);
    expect(result.issues).toHaveLength(0);
    expect(result.request).toEqual({
      poolAddress: POOL_A,
      tokenInAddress: WETH,
      amountIn: '1000000000000000000',
      rangeStrategy: 'narrow',
      swapSlippage: 0.005,
    });
  });

  it('scales the amount by the SELECTED token’s decimals', () => {
    const result = validateEnterForm(values({ tokenInAddress: USDC, amount: '10' }), pool);
    expect(result.request?.amountIn).toBe('10000000'); // 10 * 1e6
  });

  it('flags a missing pool', () => {
    const result = validateEnterForm(values({ poolAddress: '' }), null);
    expect(fieldsOf(result.issues)).toContain('poolAddress');
    expect(result.request).toBeNull();
  });

  it('flags a missing token', () => {
    const result = validateEnterForm(values({ tokenInAddress: '' }), pool);
    expect(fieldsOf(result.issues)).toContain('tokenInAddress');
  });

  it('flags a token that is not in the pool', () => {
    const result = validateEnterForm(values({ tokenInAddress: POOL_B }), pool);
    expect(fieldsOf(result.issues)).toContain('tokenInAddress');
  });

  it('flags a missing amount', () => {
    const result = validateEnterForm(values({ amount: '' }), pool);
    expect(fieldsOf(result.issues)).toContain('amount');
  });

  it('flags too-many-decimals against the token', () => {
    const result = validateEnterForm(values({ tokenInAddress: USDC, amount: '1.1234567' }), pool);
    expect(fieldsOf(result.issues)).toContain('amount');
  });

  it('flags slippage over the cap', () => {
    const result = validateEnterForm(values({ slippagePercent: '10' }), pool);
    expect(fieldsOf(result.issues)).toContain('swapSlippage');
    expect(result.request).toBeNull();
  });

  it('accepts a blank slippage as the default', () => {
    const result = validateEnterForm(values({ slippagePercent: '' }), pool);
    expect(result.request?.swapSlippage).toBe(DEFAULT_SWAP_SLIPPAGE);
  });

  it('rejects an out-of-set range strategy', () => {
    const result = validateEnterForm(
      values({ rangeStrategy: 'medium' as unknown as LpEnterFormValues['rangeStrategy'] }),
      pool,
    );
    expect(fieldsOf(result.issues)).toContain('rangeStrategy');
  });

  it('offers native ETH when the pool has a WETH side', () => {
    const options = depositTokenOptions(pool);
    expect(options.some((opt) => opt.label === 'ETH' && opt.value === NATIVE_ETH_ADDRESS)).toBe(true);
  });

  it('queues native ETH with the Krystal sentinel address', () => {
    const result = validateEnterForm(values({ tokenInAddress: NATIVE_ETH_ADDRESS, amount: '0.01' }), pool);
    expect(result.issues).toHaveLength(0);
    expect(result.request?.tokenInAddress).toBe(NATIVE_ETH_ADDRESS);
    expect(result.request?.amountIn).toBe('10000000000000000');
  });
});

// --- Command parsing (tolerates null token_id) -------------------------------

describe('parseEnterCommand', () => {
  it('parses the command envelope with a null token id', () => {
    const parsed = parseEnterCommand({
      command: { id: 'cmd_1', tokenId: null, action: 'enter', status: 'pending', requestedAt: '2026-01-01T00:00:00Z' },
    });
    expect(parsed).toEqual({
      id: 'cmd_1',
      status: 'pending',
      requestedAt: '2026-01-01T00:00:00Z',
      txHash: null,
      error: null,
    });
  });

  it('parses a bare command object', () => {
    expect(parseEnterCommand({ id: 'cmd_2', status: 'done', txHash: '0xabc' })?.status).toBe('done');
  });

  it('falls back to unknown for an unrecognized status', () => {
    expect(parseEnterCommand({ id: 'cmd_3', status: 'weird' })?.status).toBe('unknown');
  });

  it('returns null without an id', () => {
    expect(parseEnterCommand({ status: 'pending' })).toBeNull();
    expect(parseEnterCommand(null)).toBeNull();
  });
});
