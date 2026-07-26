// Unit tests for the Krystal ingest mappers and the calldata validator.
//
// NO NETWORK. Every fixture below is a VERBATIM (trimmed only, never edited)
// excerpt of a real response captured from api.krystal.app on 2026-07-26 for
// Robinhood Chain (4663). Values are not invented — if a field is a string here
// it is a string in production, and if it is `""` that is what Krystal sent.
//
// That is the whole point of splitting the mappers out of the fetchers: these
// assertions are about reality, not about a shape someone assumed.

import { describe, expect, it, vi } from 'vitest';

import { ROBINHOOD_CHAIN_ID, type Address, type PoolCandidate } from '../src/types.js';
import {
  KrystalClient,
  KrystalFieldError,
  KrystalRateLimitError,
  assertNoWafTripwire,
  buildQueryString,
} from '../src/ingest/krystal/index.js';
import {
  PHASE1_PLATFORM,
  ROBINHOOD_PLATFORMS,
  isSupportedPhase1Target,
} from '../src/ingest/krystal/platform.js';
import { mapPoolCandidate, mapTopPools } from '../src/ingest/krystal/pools.js';
import {
  deriveTick,
  mapLpPosition,
  mapPositionStatus,
  mapUserPositions,
  sumUsdQuotes,
  type PoolTickState,
} from '../src/ingest/krystal/positions.js';
import {
  CalldataValidationError,
  ROBINHOOD_UNISWAP_V3_TARGETS,
  parseHexQuantity,
  validateLpTxnResponse,
} from '../src/calldata/validate.js';
import { slippageFraction } from '../src/calldata/lpTxn.js';
import { TICK_SPACING_BY_FEE_BPS } from '../src/lifecycle/range.js';
import { dryRun, type EthCallCapableClient } from '../src/calldata/dryRun.js';
import type { CalldataPolicy, PreparedTransaction } from '../src/calldata/types.js';

// ---------------------------------------------------------------------------
// Fixtures — real captured payloads
// ---------------------------------------------------------------------------

/** GET /all/v2/lp_explorer/top_pools?chainId=4663 — one row, verbatim. */
const REAL_POOL_ROW = {
  chainId: 4663,
  protocol: 'uniswapv3',
  protocolLogo: 'https://storage.googleapis.com/k-assets-dev.krystal.team/web3-protocol/uniswap.png',
  poolAddress: '0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a',
  feeTier: 0.05,
  tvlUsd: '2350090.474702',
  tvlToken0: '1327748.022021',
  tvlToken1: '1022342.45268',
  token0: {
    symbol: 'WETH',
    address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
    logo: 'https://storage.googleapis.com/k-assets-prod.krystal.team/krystal/weth.png',
    decimals: '18',
    balance: '706617866183825807421',
    usdPrice: '',
  },
  token1: {
    symbol: 'USDG',
    address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    logo: 'https://storage.googleapis.com/k-assets-prod.krystal.team/krystal/global-dollar.png',
    decimals: '6',
    balance: '1022225752418',
    usdPrice: '',
  },
  tag: 'blue-chip',
  incentives: [],
  stat1h: { volumeUsd: '66199.307298', feeUsd: '33.099655', apr: 12.337949577740595 },
  stat24h: { volumeUsd: '2622429.1379', feeUsd: '1311.214598', apr: 20.364889497742254 },
  stat7d: { volumeUsd: '58455425.645231', feeUsd: '29227.71272', apr: 31.278585796816017 },
  stat30d: { volumeUsd: '121891557.671012', feeUsd: '60945.778795', apr: 13.82883089361575 },
  drawdown24h: -1.3032851559729342,
  priceVolatility: 1.2199278367844129,
  isSupportLpAuto: true,
  skipDrawdownCheck: true,
  hooks: '',
  hooksTag: '',
  dynamicFee: false,
};

/**
 * GET /all/v1/lp/userPositions — tokenId 396426, verbatim except that the
 * token-amount arrays are trimmed to the fields the mapper reads.
 *
 * Chosen because token decimals are UNEQUAL (18 / 6), so the decimal term in
 * `deriveTick` is actually exercised rather than cancelling out.
 */
const REAL_POSITION_ROW = {
  chainId: 4663,
  chainName: 'robinhood',
  userAddress: '0x216f91ce3c1cb358e583441d6179c6c19c834a2e',
  id: '0x73991a25c818bf1f1128deaab1492d45638de0d3-396426',
  tokenAddress: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
  tokenId: '396426',
  liquidity: '50125152307906856',
  minPrice: 0.0006068511612384497,
  maxPrice: 0.001197809270454151,
  status: 'OUT_RANGE',
  currentPositionValue: 499.9687419061259,
  openedTime: 1785037650,
  createdTime: 1785037650,
  apr: 0,
  feeApr: 0,
  feePending: [
    {
      token: { address: '0x30db03a051205ccbeb1b6524ddf87fbc6c0127bc', symbol: 'TA', decimals: 18 },
      balance: '0',
      quotes: { usd: { value: 0 } },
    },
    {
      token: { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG', decimals: 6 },
      balance: '0',
      quotes: { usd: { value: 0 } },
    },
  ],
  pool: {
    poolAddress: '0xa06671d47e0b5b45f4144bf77149995f0bdb495d',
    price: 0.0012916112940996093,
    fees: [1, 0],
    tickSpacing: 200,
    project: 'Uniswap V3',
    projectKey: 'uniswapv3',
    projectAddress: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
    tvl: 2945.8699046944894,
    tokenAmounts: [
      {
        token: { address: '0x30db03a051205ccbeb1b6524ddf87fbc6c0127bc', symbol: 'TA', decimals: 18 },
        balance: '774989425568784923763153',
        quotes: { usd: { value: 1000.9225191021319 } },
      },
      {
        token: { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG', decimals: 6 },
        balance: '1945068980',
        quotes: { usd: { value: 1944.9473855923577 } },
      },
    ],
  },
};

/** On-chain truth for tokenId 396426, read from NonfungiblePositionManager.positions(). */
const ONCHAIN_TICKS_396426 = { tickLower: -350400, tickUpper: -343600 };

const POOL_ADDRESS_396426 = '0xa06671d47e0b5b45f4144bf77149995f0bdb495d' as Address;
/** slot0().tick for that pool at capture time. */
const ONCHAIN_CURRENT_TICK = -342798;

const SAFE = '0x1c66e28620db86524b00ce4c620394c956d29ae2' as Address;

/**
 * GET /all/v1/lp_transaction/swap_and_mint — real 200 response, `data` truncated
 * to the first 4 words (the selector and shape are what the validator reads).
 */
const REAL_SWAP_AND_MINT = {
  prices: [
    { address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', usdPrice: 1881.8375244140625 },
    { address: '0x3d25745850a4b7cf7cea8fcfba64214a9574e207', usdPrice: 0.0000037994277590769343 },
  ],
  txData: {
    from: '0x1c66e28620db86524b00ce4c620394c956d29ae2',
    to: '0xb4acbc082b5e7ded571c98ee4257778a9d784b36',
    value: '0x0',
    data:
      '0x954543e6' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '00000000000000000000000073991a25c818bf1f1128deaab1492d45638de0d3',
    usedDefaultGas: true,
    estimateGas: '0xaae60',
    gasLimit: '0xaae60',
  },
  txInfo: { amountSupply0: '0', amountSupply1: '0' },
};

/**
 * GET /all/v1/lp_transaction/compound — real 200 response.
 *
 * Note `value: ""`. Krystal really does send an empty string here, and on
 * adjust_range and withdraw_and_swap too. `to` is the position manager, not the
 * v3utils helper, because the flow is safeTransferFrom (0xb88d4fde).
 */
const REAL_COMPOUND = {
  prices: [{ address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', usdPrice: 1881.4981689453125 }],
  txData: {
    from: '0x1c66e28620db86524b00ce4c620394c956d29ae2',
    to: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
    value: '',
    data:
      '0xb88d4fde' +
      '0000000000000000000000001c66e28620db86524b00ce4c620394c956d29ae2' +
      '000000000000000000000000b4acbc082b5e7ded571c98ee4257778a9d784b36' +
      '00000000000000000000000000000000000000000000000000000000000609fe',
    usedDefaultGas: false,
    estimateGas: '0xa54fa',
    gasLimit: '0xd1f1e',
  },
  txInfo: { amountSupply0: '7613962635070767', amountSupply1: '0' },
};

/** Native-token zap-in: `value` is non-zero and equals amountIn (1e15 wei). */
const REAL_NATIVE_ZAP_VALUE = '0x38d7ea4c68000';

const POLICY: CalldataPolicy = {
  chainId: ROBINHOOD_CHAIN_ID,
  platform: PHASE1_PLATFORM,
  allowedTargets: ROBINHOOD_UNISWAP_V3_TARGETS,
  expectedFrom: SAFE,
  maxValueWei: 10n ** 18n, // 1 ETH per transaction
};

// ---------------------------------------------------------------------------
// Task 0 — the platform identifier
// ---------------------------------------------------------------------------

describe('platform identifier for chain 4663 (plan §11 item 3)', () => {
  it('is the plain string "uniswapv3"', () => {
    expect(PHASE1_PLATFORM).toBe('uniswapv3');
  });

  it('matches the projectKey Krystal returns on a real 4663 position', () => {
    expect(REAL_POSITION_ROW.pool.projectKey).toBe(PHASE1_PLATFORM);
  });

  it('lists only the automation-eligible Uniswap platforms for Robinhood Chain', () => {
    expect([...ROBINHOOD_PLATFORMS]).toEqual(['uniswapv3', 'uniswapv4']);
  });

  it('only admits the Phase 1 chain/platform pair', () => {
    expect(isSupportedPhase1Target(ROBINHOOD_CHAIN_ID, 'uniswapv3')).toBe(true);
    expect(isSupportedPhase1Target(ROBINHOOD_CHAIN_ID, 'uniswapv4')).toBe(false);
    expect(isSupportedPhase1Target(8453, 'uniswapv3')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pool mapper
// ---------------------------------------------------------------------------

describe('mapPoolCandidate', () => {
  it('maps a real 4663 pool row', () => {
    const pool = mapPoolCandidate(REAL_POOL_ROW);
    expect(pool).toEqual<PoolCandidate>({
      address: '0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a',
      chainId: 4663,
      platform: 'uniswapv3',
      feeTierBps: 500, // 0.05% pool -> on-chain fee unit 500
      token0: {
        address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
        symbol: 'WETH',
        decimals: 18,
      },
      token1: {
        address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
        symbol: 'USDG',
        decimals: 6,
      },
      tvlUsd: 2350090.474702,
      volume24hUsd: 2622429.1379,
      // Krystal's apr is percent (20.36...); types.ts wants a fraction.
      feeApr: pool.feeApr,
    });
    expect(pool.feeApr).toBeCloseTo(0.20364889497742254, 12);
  });

  it('converts Krystal percent fee tiers to the on-chain fee unit we verified', () => {
    // Cross-checked against fee() on the real 4663 pools. These are the Uniswap
    // on-chain fee units, NOT basis points — the unit TICK_SPACING_BY_FEE_BPS
    // is keyed by and the frontend divides by 10000. Getting this wrong made a
    // 1% pool resolve to spacing 1 and rebalance build unaligned ticks.
    const units = (feeTier: number): number =>
      mapPoolCandidate({ ...REAL_POOL_ROW, feeTier }).feeTierBps;
    expect(units(1)).toBe(10000);
    expect(units(0.3)).toBe(3000);
    expect(units(0.05)).toBe(500);
    expect(units(0.01)).toBe(100);
  });

  it('reads string-typed decimals without coercing through Number()', () => {
    expect(mapPoolCandidate(REAL_POOL_ROW).token1.decimals).toBe(6);
  });

  it('lowercases addresses so allowlist comparison is plain equality', () => {
    const upper = {
      ...REAL_POOL_ROW,
      poolAddress: REAL_POOL_ROW.poolAddress.toUpperCase().replace('0X', '0x'),
    };
    expect(mapPoolCandidate(upper).address).toBe(REAL_POOL_ROW.poolAddress);
  });

  describe('refuses to invent a number', () => {
    // Each of these would become a plausible-looking value under Number()/parseFloat().
    const cases: Array<[string, Record<string, unknown>]> = [
      ['tvlUsd empty string (Number("") === 0)', { tvlUsd: '' }],
      ['tvlUsd null (Number(null) === 0)', { tvlUsd: null }],
      ['tvlUsd partially numeric (parseFloat("12abc") === 12)', { tvlUsd: '12abc' }],
      ['tvlUsd negative', { tvlUsd: '-1' }],
      ['tvlUsd missing', { tvlUsd: undefined }],
      ['feeTier zero', { feeTier: 0 }],
      ['feeTier boolean (Number(true) === 1)', { feeTier: true }],
      ['poolAddress truncated', { poolAddress: '0xdeadbeef' }],
      ['protocol empty string', { protocol: '' }],
      ['stat24h missing', { stat24h: undefined }],
    ];

    for (const [label, patch] of cases) {
      it(label, () => {
        const row: Record<string, unknown> = { ...REAL_POOL_ROW, ...patch };
        if ('tvlUsd' in patch && patch.tvlUsd === undefined) delete row.tvlUsd;
        if ('stat24h' in patch && patch.stat24h === undefined) delete row.stat24h;
        expect(() => mapPoolCandidate(row)).toThrow(KrystalFieldError);
      });
    }

    it('reports a Uniswap V4 32-byte pool id as out of scope, not as a bad address', () => {
      // All 57 uniswapv4 rows on chain 4663 look like this. The reason matters:
      // 57 spurious "malformed address" warnings would train an operator to
      // ignore the skip list, which is where real ingest bugs would surface.
      const v4 = {
        ...REAL_POOL_ROW,
        protocol: 'uniswapv4',
        poolAddress: '0x2a161f5753001f9a25ee35017a4e34ec6215b9697736c6d97d2c67c4a786c506',
      };
      expect(() => mapPoolCandidate(v4)).toThrow(/32-byte pool id \(uniswapv4\)/);
    });

    it('rejects decimals outside the plausible ERC-20 range', () => {
      expect(() =>
        mapPoolCandidate({ ...REAL_POOL_ROW, token0: { ...REAL_POOL_ROW.token0, decimals: '99' } }),
      ).toThrow(KrystalFieldError);
    });
  });
});

describe('mapTopPools', () => {
  it('skips a malformed row with a recorded reason instead of aborting the batch', () => {
    const payload = {
      result: [REAL_POOL_ROW, { ...REAL_POOL_ROW, poolAddress: 'not-an-address' }, REAL_POOL_ROW],
      timestamp: 1785037430,
    };
    const { pools, skipped } = mapTopPools(payload);
    expect(pools).toHaveLength(2);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.index).toBe(1);
    expect(skipped[0]!.identifier).toBe('not-an-address');
    expect(skipped[0]!.reason).toMatch(/poolAddress/);
  });

  it('throws when the envelope itself is wrong', () => {
    expect(() => mapTopPools({ data: [] })).toThrow(KrystalFieldError);
    expect(() => mapTopPools(null)).toThrow(KrystalFieldError);
    expect(() => mapTopPools({ result: 'nope' })).toThrow(KrystalFieldError);
  });

  it('handles an empty result set (a real outcome on a 4-week-old chain)', () => {
    expect(mapTopPools({ result: [], timestamp: 0 })).toEqual({ pools: [], skipped: [] });
  });
});

// ---------------------------------------------------------------------------
// Tick derivation
// ---------------------------------------------------------------------------

describe('deriveTick', () => {
  // Every expectation here is the value read from the chain, not a computed one.
  it('reproduces on-chain range ticks for an 18/18 position (tokenId 395774)', () => {
    expect(deriveTick(1438758.3566366078, 18, 18)).toBe(141800);
    expect(deriveTick(2897202.1389831887, 18, 18)).toBe(148800);
  });

  it('reproduces on-chain range ticks for an 18/6 position (tokenId 396426)', () => {
    expect(deriveTick(REAL_POSITION_ROW.minPrice, 18, 6)).toBe(ONCHAIN_TICKS_396426.tickLower);
    expect(deriveTick(REAL_POSITION_ROW.maxPrice, 18, 6)).toBe(ONCHAIN_TICKS_396426.tickUpper);
  });

  it('reproduces on-chain range ticks for a 6/18 position (tokenId 396418)', () => {
    // Decimals reversed relative to 396426, so a sign error in the decimal term
    // would show up here and nowhere else.
    expect(deriveTick(1322.4455622554137, 6, 18)).toBe(348200);
    expect(deriveTick(2610.257103089025, 6, 18)).toBe(355000);
  });

  it('reproduces on-chain range ticks for a second 18/6 position (tokenId 396425)', () => {
    expect(deriveTick(314.2268392218476, 18, 6)).toBe(-218820);
    expect(deriveTick(327.7047475649515, 18, 6)).toBe(-218400);
  });

  it('rejects non-positive or non-finite prices rather than returning -Infinity', () => {
    expect(() => deriveTick(0, 18, 18)).toThrow(KrystalFieldError);
    expect(() => deriveTick(-1, 18, 18)).toThrow(KrystalFieldError);
    expect(() => deriveTick(Number.NaN, 18, 18)).toThrow(KrystalFieldError);
  });
});

// ---------------------------------------------------------------------------
// Position mapper
// ---------------------------------------------------------------------------

const TICKS: ReadonlyMap<Address, PoolTickState> = new Map([
  [POOL_ADDRESS_396426, { currentTick: ONCHAIN_CURRENT_TICK }],
]);

describe('mapLpPosition', () => {
  it('maps a real 4663 position', () => {
    const { position, missing } = mapLpPosition(REAL_POSITION_ROW, {
      chainId: ROBINHOOD_CHAIN_ID,
      currentTicks: TICKS,
    });

    expect(position.tokenId).toBe('396426');
    expect(position.status).toBe('out_of_range');
    expect(position.tickLower).toBe(ONCHAIN_TICKS_396426.tickLower);
    expect(position.tickUpper).toBe(ONCHAIN_TICKS_396426.tickUpper);
    expect(position.currentTick).toBe(ONCHAIN_CURRENT_TICK);
    expect(position.valueUsd).toBe(499.9687419061259);
    expect(position.unclaimedFeesUsd).toBe(0);
    expect(position.openedAt).toBe(1785037650);
    expect(position.lastCompoundedAt).toBeNull();
    expect(position.pool.address).toBe(POOL_ADDRESS_396426);
    expect(position.pool.platform).toBe('uniswapv3');
    expect(position.pool.feeTierBps).toBe(10000); // pool.fees[0] === 1 (percent) -> on-chain unit 10000
    expect(position.pool.token0.decimals).toBe(18);
    expect(position.pool.token1.decimals).toBe(6);

    // Volume/APR are genuinely absent from the position payload — reported, not faked.
    expect(missing).toEqual(['pool.volume24hUsd', 'pool.feeApr']);
  });

  it("a mapped 1% pool's fee unit resolves to tick spacing 200 (rebalance regression)", () => {
    // The bug the tester hit end to end: a 1% Krystal pool mapped to fee unit
    // 100, TICK_SPACING_BY_FEE_BPS[100] read that as the 0.01% tier (spacing 1),
    // and rebalance built ticks unaligned to the pool's real spacing of 200 ->
    // Krystal 400 "Invalid tick range". Guard the whole seam here.
    const { position } = mapLpPosition(REAL_POSITION_ROW, {
      chainId: ROBINHOOD_CHAIN_ID,
      currentTicks: TICKS,
    });
    expect(TICK_SPACING_BY_FEE_BPS[position.pool.feeTierBps]).toBe(200);
  });

  it('is consistent: an out-of-range position really is outside its derived ticks', () => {
    const { position } = mapLpPosition(REAL_POSITION_ROW, {
      chainId: ROBINHOOD_CHAIN_ID,
      currentTicks: TICKS,
    });
    expect(position.status).toBe('out_of_range');
    expect(position.currentTick > position.tickUpper).toBe(true);
  });

  it('prefers the richer discovery record when the pool is in the index', () => {
    const enriched: PoolCandidate = {
      ...mapPoolCandidate(REAL_POOL_ROW),
      address: POOL_ADDRESS_396426,
    };
    const { position, missing } = mapLpPosition(REAL_POSITION_ROW, {
      chainId: ROBINHOOD_CHAIN_ID,
      currentTicks: TICKS,
      poolIndex: new Map([[POOL_ADDRESS_396426, enriched]]),
    });
    expect(position.pool.volume24hUsd).toBe(2622429.1379);
    expect(missing).toEqual([]);
  });

  it('REFUSES to map a position with no authoritative current tick', () => {
    // Krystal's pool.price drifted up to 66 ticks from slot0() when measured, so
    // backfilling it here would let an out-of-range position read as in-range.
    expect(() =>
      mapLpPosition(REAL_POSITION_ROW, { chainId: ROBINHOOD_CHAIN_ID, currentTicks: new Map() }),
    ).toThrow(KrystalFieldError);
  });

  it('rejects a position from a different chain than the one requested', () => {
    expect(() =>
      mapLpPosition({ ...REAL_POSITION_ROW, chainId: 8453 }, {
        chainId: ROBINHOOD_CHAIN_ID,
        currentTicks: TICKS,
      }),
    ).toThrow(KrystalFieldError);
  });

  it('rejects an inverted range rather than emitting a nonsense position', () => {
    expect(() =>
      mapLpPosition({ ...REAL_POSITION_ROW, maxPrice: REAL_POSITION_ROW.minPrice / 2 }, {
        chainId: ROBINHOOD_CHAIN_ID,
        currentTicks: TICKS,
      }),
    ).toThrow(KrystalFieldError);
  });

  it('rejects a negative position value', () => {
    expect(() =>
      mapLpPosition({ ...REAL_POSITION_ROW, currentPositionValue: -1 }, {
        chainId: ROBINHOOD_CHAIN_ID,
        currentTicks: TICKS,
      }),
    ).toThrow(KrystalFieldError);
  });
});

describe('mapPositionStatus', () => {
  it('maps the three status strings Krystal actually returns', () => {
    expect(mapPositionStatus('IN_RANGE', 's')).toBe('in_range');
    expect(mapPositionStatus('OUT_RANGE', 's')).toBe('out_of_range');
    expect(mapPositionStatus('CLOSED', 's')).toBe('closed');
  });

  it('throws on an unknown status rather than defaulting to in_range', () => {
    expect(() => mapPositionStatus('PENDING', 's')).toThrow(KrystalFieldError);
    expect(() => mapPositionStatus('', 's')).toThrow(KrystalFieldError);
  });
});

describe('sumUsdQuotes', () => {
  it('sums real fee quotes', () => {
    const fees = [
      { quotes: { usd: { value: 6.7777582004922206 } } },
      { quotes: { usd: { value: 7.66100077655261 } } },
    ];
    expect(sumUsdQuotes(fees, 'feePending')).toBeCloseTo(14.43875897704483, 10);
  });

  it('throws rather than contributing 0 for an unreadable quote', () => {
    expect(() => sumUsdQuotes([{ quotes: { usd: { value: '' } } }], 'feePending')).toThrow(
      KrystalFieldError,
    );
    expect(() => sumUsdQuotes([{ quotes: {} }], 'feePending')).toThrow(KrystalFieldError);
  });
});

describe('mapUserPositions', () => {
  it('separates mapped, skipped and incomplete entries', () => {
    const payload = {
      statsByChain: {},
      positions: [REAL_POSITION_ROW, { ...REAL_POSITION_ROW, tokenId: '999', status: 'WAT' }],
    };
    const result = mapUserPositions(payload, {
      chainId: ROBINHOOD_CHAIN_ID,
      currentTicks: TICKS,
    });
    expect(result.positions).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.identifier).toBe('999');
    expect(result.incomplete).toEqual([
      { tokenId: '396426', missing: ['pool.volume24hUsd', 'pool.feeApr'] },
    ]);
  });

  it('throws on a malformed envelope', () => {
    expect(() => mapUserPositions({ positions: {} }, { chainId: 4663, currentTicks: TICKS })).toThrow(
      KrystalFieldError,
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP client behaviour
// ---------------------------------------------------------------------------

describe('Cloudflare WAF tripwire', () => {
  it('rejects an all-zero address in a query parameter before sending', () => {
    // Verified live: appending ?x=0x0000...0000 to a working endpoint turns a
    // 200 into a Cloudflare 403 HTML block page.
    expect(() =>
      assertNoWafTripwire({ platformWallet: '0x0000000000000000000000000000000000000000' }),
    ).toThrow(/all-zero address/);
    expect(() => buildQueryString({ platformWallet: '0x' + '0'.repeat(40) })).toThrow(
      /all-zero address/,
    );
  });

  it('allows ordinary addresses', () => {
    expect(buildQueryString({ platformWallet: SAFE, chainId: 4663 })).toContain('chainId=4663');
  });
});

describe('KrystalClient rate limiting', () => {
  const respond = (status: number, body: string, headers: Record<string, string> = {}): Response =>
    new Response(body, { status, headers });

  it('surfaces 429 as a distinct error instead of retrying forever', async () => {
    const fetchImpl = vi.fn(async () => respond(429, '{"error":"slow down"}', { 'retry-after': '0' }));
    const client = new KrystalClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRateLimitRetries: 1,
      retryBaseDelayMs: 0,
    });

    const seen: number[] = [];
    const clientWithHook = new KrystalClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRateLimitRetries: 1,
      retryBaseDelayMs: 0,
      onRateLimit: (info) => seen.push(info.attempt),
    });

    await expect(client.getJson('/x')).rejects.toBeInstanceOf(KrystalRateLimitError);
    await expect(clientWithHook.getJson('/x')).rejects.toBeInstanceOf(KrystalRateLimitError);
    // One retry then give up — bounded, and every 429 reported.
    expect(seen).toEqual([1, 2]);
  });

  it('does not retry a 4xx that is not a rate limit', async () => {
    const fetchImpl = vi.fn(async () => respond(400, '{"error":"bad platform"}'));
    const client = new KrystalClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBaseDelayMs: 0,
    });
    await expect(client.getJson('/x')).rejects.toThrow(/returned 400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx and succeeds', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls < 3 ? respond(500, '{"error":"internal"}') : respond(200, '{"result":[]}');
    });
    const client = new KrystalClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBaseDelayMs: 0,
    });
    await expect(client.getJson('/x')).resolves.toEqual({ result: [] });
    expect(calls).toBe(3);
  });

  it('recognises a Cloudflare HTML 403 as a block, not an API error', async () => {
    const fetchImpl = vi.fn(async () =>
      respond(403, '<!DOCTYPE html><html><div id="cf-error-details">blocked</div></html>'),
    );
    const client = new KrystalClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBaseDelayMs: 0,
    });
    await expect(client.getJson('/x')).rejects.toThrow(/Cloudflare blocked/);
  });
});

// ---------------------------------------------------------------------------
// Calldata validation — the security boundary
// ---------------------------------------------------------------------------

describe('parseHexQuantity', () => {
  it('treats Krystal’s empty-string value as zero', () => {
    // compound / adjust_range / withdraw_and_swap really do send value: "".
    expect(parseHexQuantity('', 'value')).toBe(0n);
  });

  it('parses 0x0 and a real native zap-in value', () => {
    expect(parseHexQuantity('0x0', 'value')).toBe(0n);
    expect(parseHexQuantity(REAL_NATIVE_ZAP_VALUE, 'value')).toBe(1_000_000_000_000_000n);
  });

  it('rejects decimal, malformed and non-string quantities', () => {
    expect(() => parseHexQuantity('1000', 'value')).toThrow(CalldataValidationError);
    expect(() => parseHexQuantity('0xzz', 'value')).toThrow(CalldataValidationError);
    expect(() => parseHexQuantity(null, 'value')).toThrow(CalldataValidationError);
    expect(() => parseHexQuantity(1000, 'value')).toThrow(CalldataValidationError);
  });
});

describe('validateLpTxnResponse', () => {
  it('accepts the real swap_and_mint response', () => {
    const tx = validateLpTxnResponse(REAL_SWAP_AND_MINT, { kind: 'swap_and_mint', policy: POLICY });
    expect(tx.to).toBe('0xb4acbc082b5e7ded571c98ee4257778a9d784b36');
    expect(tx.value).toBe(0n);
    expect(tx.meta.selector).toBe('0x954543e6');
    expect(tx.meta.gasLimit).toBe(0xaae60n);
    expect(tx.meta.usedDefaultGas).toBe(true);
    expect(tx.meta.kind).toBe('swap_and_mint');
  });

  it('accepts the real compound response, including value: ""', () => {
    const tx = validateLpTxnResponse(REAL_COMPOUND, { kind: 'compound', policy: POLICY });
    expect(tx.to).toBe('0x73991a25c818bf1f1128deaab1492d45638de0d3');
    expect(tx.value).toBe(0n);
    expect(tx.meta.selector).toBe('0xb88d4fde');
    expect(tx.meta.estimateGas).toBe(0xa54fan);
    expect(tx.meta.gasLimit).toBe(0xd1f1en);
    expect(tx.meta.usedDefaultGas).toBe(false);
  });

  it('returns inert, frozen data — no methods that could send anything', () => {
    const tx = validateLpTxnResponse(REAL_COMPOUND, { kind: 'compound', policy: POLICY });
    expect(Object.isFrozen(tx)).toBe(true);
    for (const value of Object.values(tx)) expect(typeof value).not.toBe('function');
  });

  describe('destination allowlist', () => {
    it('rejects a `to` that is not allowlisted', () => {
      const hijacked = {
        ...REAL_SWAP_AND_MINT,
        txData: { ...REAL_SWAP_AND_MINT.txData, to: '0x000000000000000000000000000000000000dead' },
      };
      expect(() => validateLpTxnResponse(hijacked, { kind: 'swap_and_mint', policy: POLICY })).toThrow(
        /destination allowlist/,
      );
    });

    it('is case-insensitive about the allowlist match', () => {
      const checksummed = {
        ...REAL_SWAP_AND_MINT,
        txData: { ...REAL_SWAP_AND_MINT.txData, to: '0xB4ACBC082B5E7DED571C98EE4257778A9D784B36' },
      };
      const tx = validateLpTxnResponse(checksummed, { kind: 'swap_and_mint', policy: POLICY });
      expect(tx.to).toBe('0xb4acbc082b5e7ded571c98ee4257778a9d784b36');
    });

    it('rejects a malformed `to`', () => {
      for (const to of ['0xdead', '', null, 'not-hex', undefined]) {
        const bad = { ...REAL_COMPOUND, txData: { ...REAL_COMPOUND.txData, to } };
        expect(() => validateLpTxnResponse(bad, { kind: 'compound', policy: POLICY })).toThrow(
          CalldataValidationError,
        );
      }
    });
  });

  describe('account binding', () => {
    it('rejects calldata built for a different account', () => {
      const wrongFrom = {
        ...REAL_COMPOUND,
        txData: {
          ...REAL_COMPOUND.txData,
          from: '0x216f91ce3c1cb358e583441d6179c6c19c834a2e',
        },
      };
      expect(() => validateLpTxnResponse(wrongFrom, { kind: 'compound', policy: POLICY })).toThrow(
        /different account/,
      );
    });
  });

  describe('value bounds', () => {
    it('accepts a real native zap-in within the cap', () => {
      const native = {
        ...REAL_SWAP_AND_MINT,
        txData: { ...REAL_SWAP_AND_MINT.txData, value: REAL_NATIVE_ZAP_VALUE },
      };
      const tx = validateLpTxnResponse(native, { kind: 'swap_and_mint', policy: POLICY });
      expect(tx.value).toBe(1_000_000_000_000_000n);
    });

    it('rejects a value above the per-transaction cap', () => {
      const huge = {
        ...REAL_SWAP_AND_MINT,
        txData: { ...REAL_SWAP_AND_MINT.txData, value: '0x' + (10n ** 21n).toString(16) },
      };
      expect(() => validateLpTxnResponse(huge, { kind: 'swap_and_mint', policy: POLICY })).toThrow(
        /per-transaction cap/,
      );
    });
  });

  describe('calldata well-formedness', () => {
    const bad: Array<[string, unknown]> = [
      ['not hex', 'hello'],
      ['missing 0x prefix', 'b88d4fde00'],
      ['odd hex digit count', '0xb88d4fd'],
      ['shorter than a selector', '0xb88d'],
      ['empty', '0x'],
      ['not a string', 12345],
      ['null', null],
    ];
    for (const [label, data] of bad) {
      it(`rejects data that is ${label}`, () => {
        const payload = { ...REAL_COMPOUND, txData: { ...REAL_COMPOUND.txData, data } };
        expect(() => validateLpTxnResponse(payload, { kind: 'compound', policy: POLICY })).toThrow(
          CalldataValidationError,
        );
      });
    }

    it('rejects absurdly large calldata', () => {
      const payload = {
        ...REAL_COMPOUND,
        txData: { ...REAL_COMPOUND.txData, data: '0x' + 'ab'.repeat(20_000) },
      };
      expect(() => validateLpTxnResponse(payload, { kind: 'compound', policy: POLICY })).toThrow(
        /exceeds/,
      );
    });
  });

  describe('envelope', () => {
    it('rejects a response with no txData', () => {
      expect(() => validateLpTxnResponse({ prices: [] }, { kind: 'compound', policy: POLICY })).toThrow(
        /txData/,
      );
      expect(() => validateLpTxnResponse(null, { kind: 'compound', policy: POLICY })).toThrow(
        /is not an object/,
      );
      expect(() =>
        validateLpTxnResponse({ error: 'unsupported chain' }, { kind: 'compound', policy: POLICY }),
      ).toThrow(CalldataValidationError);
    });
  });

  describe('optional selector enforcement', () => {
    it('accepts the observed selector for each operation', () => {
      expect(
        validateLpTxnResponse(REAL_COMPOUND, {
          kind: 'compound',
          policy: POLICY,
          enforceSelector: true,
        }).meta.selector,
      ).toBe('0xb88d4fde');
    });

    it('rejects a response whose selector is for a different operation', () => {
      expect(() =>
        validateLpTxnResponse(REAL_COMPOUND, {
          kind: 'swap_and_mint',
          policy: POLICY,
          enforceSelector: true,
        }),
      ).toThrow(/selector observed for swap_and_mint/);
    });
  });
});

// ---------------------------------------------------------------------------
// Slippage units
// ---------------------------------------------------------------------------

describe('slippageFraction', () => {
  it('accepts fractions in the sane range', () => {
    // Verified live: Krystal accepts 0.005 and rejects >= 1 with
    // "slippage must be < 100 percent" — so the unit is a FRACTION.
    expect(slippageFraction(0.005, 'swapSlippage')).toBe(0.005);
    expect(slippageFraction(0.05, 'swapSlippage')).toBe(0.05);
  });

  it('rejects a bps-style value that would mean 5000%', () => {
    expect(() => slippageFraction(50, 'swapSlippage')).toThrow(/FRACTION/);
  });

  it('rejects 0.5, which silently means fifty percent', () => {
    expect(() => slippageFraction(0.5, 'swapSlippage')).toThrow(CalldataValidationError);
  });

  it('rejects non-positive and non-finite values', () => {
    expect(() => slippageFraction(0, 'swapSlippage')).toThrow(CalldataValidationError);
    expect(() => slippageFraction(-0.01, 'swapSlippage')).toThrow(CalldataValidationError);
    expect(() => slippageFraction(Number.NaN, 'swapSlippage')).toThrow(CalldataValidationError);
  });
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe('dryRun', () => {
  const tx: PreparedTransaction = validateLpTxnResponse(REAL_COMPOUND, {
    kind: 'compound',
    policy: POLICY,
  });

  it('simulates from the account the calldata was built for', async () => {
    const call = vi.fn(async () => ({ data: '0x01' as `0x${string}` }));
    const client: EthCallCapableClient = { call };
    const result = await dryRun(tx, client, { now: () => 1_000 });
    expect(result).toEqual({ ok: true, returnData: '0x01', simulatedAt: 1_000 });
    expect(call).toHaveBeenCalledWith({
      account: SAFE,
      to: tx.to,
      data: tx.data,
      value: 0n,
    });
  });

  it('reports a revert as a failed result rather than throwing', async () => {
    const err = Object.assign(new Error('execution reverted: STF'), {
      name: 'ContractFunctionExecutionError',
      shortMessage: 'execution reverted: STF',
    });
    const client: EthCallCapableClient = {
      call: async () => {
        throw err;
      },
    };
    const result = await dryRun(tx, client, { now: () => 2_000 });
    expect(result).toEqual({ ok: false, reason: 'execution reverted: STF', simulatedAt: 2_000 });
  });

  it('rethrows a transport failure — an unreachable RPC is not a passing simulation', async () => {
    const err = Object.assign(new Error('socket hang up'), { name: 'HttpRequestError' });
    const client: EthCallCapableClient = {
      call: async () => {
        throw err;
      },
    };
    await expect(dryRun(tx, client)).rejects.toThrow('socket hang up');
  });
});
