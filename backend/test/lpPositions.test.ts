import { describe, it, expect } from 'vitest';
import {
  KrystalFieldError,
  ROBINHOOD_CHAIN_ID,
  mapLpPositionView,
  mapPositionViewStatus,
  mapUserPositionViews,
  sumUsdQuotes,
  validateSettingsInput,
  type PositionViewContext,
} from '../src/api/routes/lp';

// Pure units only — no network, no database. Everything here is a function the
// LP positions API depends on being right before an operator reads a number off
// the dashboard and acts on it.
//
// NOTE ON WHAT IS *NOT* TESTED HERE: there is no tick assertion anywhere in this
// file, because `LpPositionView` carries no tick fields. That absence is the
// enforcement of the display/decision boundary (see the section header in
// `src/api/routes/lp.ts`) — Krystal's `pool.price` drifted up to 66 ticks from
// the pools' own `slot0()`, so any tick derived here would be decision-grade
// data of non-decision-grade accuracy. `noTickFieldsEscape` below pins that.

const POOL_A = '0xa06671d47e0b5b45f4144bf77149995f0bdb495d';
const POOL_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TOKEN_0 = '0x30db03a051205ccbeb1b6524ddf87fbc6c0127bc';
const TOKEN_1 = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

const context = (allowed: string[] = []): PositionViewContext => ({
  chainId: ROBINHOOD_CHAIN_ID,
  allowedPools: new Set(allowed),
});

/**
 * A row in the exact shape `/all/v1/lp/userPositions` returns on chain 4663
 * (tokenId 396426, trimmed to the fields the display mapper reads). Note the
 * embedded pool's shape differs from the discovery endpoint's: `projectKey` not
 * `protocol`, `fees: [1, 0]` not `feeTier`, numeric `tvl`, no 24h volume.
 */
const rawPosition = (over: Record<string, unknown> = {}) => ({
  chainId: ROBINHOOD_CHAIN_ID,
  tokenId: '396426',
  minPrice: 0.0006068511612384497,
  maxPrice: 0.001197809270454151,
  status: 'OUT_RANGE',
  currentPositionValue: 499.9687419061259,
  openedTime: 1785037650,
  feePending: [
    { token: { address: TOKEN_0, symbol: 'TA', decimals: 18 }, quotes: { usd: { value: 12.5 } } },
    { token: { address: TOKEN_1, symbol: 'USDG', decimals: 6 }, quotes: { usd: { value: 1.93 } } },
  ],
  pool: {
    poolAddress: POOL_A,
    price: 0.0012916112940996093,
    fees: [1, 0],
    tickSpacing: 200,
    project: 'Uniswap V3',
    projectKey: 'uniswapv3',
    tvl: 2945.8699046944894,
    tokenAmounts: [
      { token: { address: TOKEN_0, symbol: 'TA', decimals: 18 }, balance: '77498942556878492376' },
      { token: { address: TOKEN_1, symbol: 'USDG', decimals: 6 }, balance: '1022225752418' },
    ],
  },
  ...over,
});

/** The envelope a wallet holding positions comes back in. */
const envelope = (rows: unknown[]) => ({
  positions: rows,
  statsByChain: { '4663': { openPositionCount: rows.length } },
});

describe('mapLpPositionView', () => {
  it('maps a real Robinhood-chain position row', () => {
    const view = mapLpPositionView(rawPosition(), context());

    expect(view.tokenId).toBe('396426');
    expect(view.poolAddress).toBe(POOL_A);
    expect(view.platform).toBe('uniswapv3');
    expect(view.status).toBe('out_of_range');
    expect(view.valueUsd).toBeCloseTo(499.9687419061259, 10);
    expect(view.unclaimedFeesUsd).toBeCloseTo(14.43, 10);
    expect(view.token0).toEqual({ symbol: 'TA', address: TOKEN_0, decimals: 18 });
    expect(view.token1).toEqual({ symbol: 'USDG', address: TOKEN_1, decimals: 6 });
    expect(view.minPrice).toBeCloseTo(0.0006068511612384497, 12);
    expect(view.maxPrice).toBeCloseTo(0.001197809270454151, 12);
    expect(view.currentPrice).toBeCloseTo(0.0012916112940996093, 12);
  });

  it('coerces Krystal string numerics instead of leaving them as strings', () => {
    // Krystal ships numbers as strings on many fields and `decimals` as a
    // string almost everywhere. A string that reaches the dashboard would
    // format as text and silently break any client-side arithmetic.
    const view = mapLpPositionView(
      rawPosition({
        currentPositionValue: '499.9687419061259',
        minPrice: '0.0006068511612384497',
        maxPrice: '0.001197809270454151',
        pool: {
          ...rawPosition().pool,
          price: '0.0012916112940996093',
          tvl: '2945.86',
          tokenAmounts: [
            { token: { address: TOKEN_0, symbol: 'TA', decimals: '18' } },
            { token: { address: TOKEN_1, symbol: 'USDG', decimals: '6' } },
          ],
        },
      }),
      context(),
    );

    expect(view.valueUsd).toBeCloseTo(499.9687419061259, 10);
    expect(view.minPrice).toBeCloseTo(0.0006068511612384497, 12);
    expect(view.currentPrice).toBeCloseTo(0.0012916112940996093, 12);
    expect(view.token0.decimals).toBe(18);
    expect(view.token1.decimals).toBe(6);
    for (const value of [view.valueUsd, view.minPrice, view.maxPrice, view.currentPrice]) {
      expect(typeof value).toBe('number');
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('reads the embedded pool fee as a PERCENT: fees[0] = 1 is 100 bps', () => {
    // Same units as the discovery endpoint's `feeTier`, but reached through
    // `fees: [percent, …]` rather than a scalar — the two pool shapes differ.
    const feeOf = (fees: unknown[]) =>
      mapLpPositionView(
        rawPosition({ pool: { ...rawPosition().pool, fees } }),
        context(),
      ).feeTierBps;

    // Uniswap on-chain fee units (pool.fee()), not basis points.
    expect(feeOf([1, 0])).toBe(10000);
    expect(feeOf([0.3, 0])).toBe(3000);
    expect(feeOf([0.05, 0])).toBe(500);
    expect(feeOf([0.01, 0])).toBe(100);
  });

  it('lowercases addresses so allowlist comparison is plain equality', () => {
    const shouty = POOL_A.toUpperCase().replace('0X', '0x');
    const view = mapLpPositionView(
      rawPosition({ pool: { ...rawPosition().pool, poolAddress: shouty } }),
      context([POOL_A]),
    );
    expect(view.poolAddress).toBe(POOL_A);
    expect(view.isAllowlisted).toBe(true);
  });

  it('flags allowlist membership against the active policy', () => {
    expect(mapLpPositionView(rawPosition(), context([POOL_A])).isAllowlisted).toBe(true);
    expect(mapLpPositionView(rawPosition(), context([POOL_B])).isAllowlisted).toBe(false);
    // No policy at all -> nothing is allowlisted, rather than everything.
    expect(mapLpPositionView(rawPosition(), context()).isAllowlisted).toBe(false);
  });

  it('never reports a CLOSED position as managed, even when allowlisted', () => {
    // A closed position is history — the automation has nothing left to manage,
    // whatever the allowlist says. Showing "managed" beside a withdrawn NFT
    // would tell the operator the automation is watching something it is not.
    const closed = mapLpPositionView(rawPosition({ status: 'CLOSED' }), context([POOL_A]));
    expect(closed.status).toBe('closed');
    expect(closed.isAllowlisted).toBe(true);
    expect(closed.managedByAutomation).toBe(false);

    const open = mapLpPositionView(rawPosition({ status: 'IN_RANGE' }), context([POOL_A]));
    expect(open.managedByAutomation).toBe(true);

    // Out of range is still managed: leaving the range is exactly the condition
    // the rebalance trigger exists to act on.
    const outOfRange = mapLpPositionView(rawPosition({ status: 'OUT_RANGE' }), context([POOL_A]));
    expect(outOfRange.managedByAutomation).toBe(true);

    // Not allowlisted -> never managed, whatever the status.
    expect(mapLpPositionView(rawPosition({ status: 'IN_RANGE' }), context()).managedByAutomation)
      .toBe(false);
  });

  it('rejects a row from another chain', () => {
    expect(() => mapLpPositionView(rawPosition({ chainId: 8453 }), context())).toThrow(
      KrystalFieldError,
    );
  });

  it('throws rather than defaulting when a numeric field is missing or empty', () => {
    // Number('') === 0, Number(null) === 0: a $0.00 position value that came
    // from a missing field is indistinguishable on screen from a real zero.
    for (const junk of ['', null, undefined, '12abc', true, -1]) {
      expect(() => mapLpPositionView(rawPosition({ currentPositionValue: junk }), context()))
        .toThrow(KrystalFieldError);
    }
  });

  it('throws on an unreadable embedded pool rather than emitting a half-row', () => {
    const pool = rawPosition().pool;
    expect(() => mapLpPositionView(rawPosition({ pool: undefined }), context()))
      .toThrow(KrystalFieldError);
    expect(() => mapLpPositionView(rawPosition({ pool: { ...pool, fees: [] } }), context()))
      .toThrow(KrystalFieldError);
    expect(() => mapLpPositionView(rawPosition({ pool: { ...pool, fees: [0, 0] } }), context()))
      .toThrow(KrystalFieldError);
    expect(() => mapLpPositionView(rawPosition({ pool: { ...pool, price: '' } }), context()))
      .toThrow(KrystalFieldError);
    expect(() =>
      mapLpPositionView(
        rawPosition({ pool: { ...pool, tokenAmounts: [pool.tokenAmounts[0]] } }),
        context(),
      ),
    ).toThrow(/fewer than 2 tokens/);
    expect(() =>
      mapLpPositionView(
        rawPosition({ pool: { ...pool, poolAddress: 'not-an-address' } }),
        context(),
      ),
    ).toThrow(KrystalFieldError);
  });

  it('never produces NaN in any numeric field of a successful mapping', () => {
    const view = mapLpPositionView(rawPosition(), context([POOL_A]));
    for (const value of [
      view.feeTierBps,
      view.valueUsd,
      view.unclaimedFeesUsd,
      view.minPrice,
      view.maxPrice,
      view.currentPrice,
      view.token0.decimals,
      view.token1.decimals,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('emits no tick fields — their absence is the display/decision boundary', () => {
    // If this ever fails, someone has added decision-grade data to a DTO built
    // from Krystal's cached quotes, and a rule evaluator can now be written
    // against numbers that were measured up to 66 ticks wrong.
    const view = mapLpPositionView(rawPosition(), context());
    expect(Object.keys(view).sort()).toEqual([
      'currentPrice',
      'feeTierBps',
      'isAllowlisted',
      'managedByAutomation',
      'maxPrice',
      'minPrice',
      'platform',
      'poolAddress',
      'status',
      'token0',
      'token1',
      'tokenId',
      'unclaimedFeesUsd',
      'valueUsd',
    ]);
    for (const forbidden of ['tickLower', 'tickUpper', 'currentTick']) {
      expect(view).not.toHaveProperty(forbidden);
    }
  });
});

describe('mapPositionViewStatus', () => {
  it('maps the three statuses observed live', () => {
    expect(mapPositionViewStatus('IN_RANGE', 'status')).toBe('in_range');
    expect(mapPositionViewStatus('OUT_RANGE', 'status')).toBe('out_of_range');
    expect(mapPositionViewStatus('CLOSED', 'status')).toBe('closed');
    // Defensive: Krystal's own naming is inconsistent across endpoints.
    expect(mapPositionViewStatus('OUT_OF_RANGE', 'status')).toBe('out_of_range');
    expect(mapPositionViewStatus('in_range', 'status')).toBe('in_range');
  });

  it('throws on an unknown status rather than guessing a safe-looking one', () => {
    for (const junk of ['PENDING', '', null, 7]) {
      expect(() => mapPositionViewStatus(junk, 'status')).toThrow(KrystalFieldError);
    }
  });
});

describe('sumUsdQuotes', () => {
  it('adds the USD legs of a fee array', () => {
    expect(sumUsdQuotes(rawPosition().feePending, 'feePending')).toBeCloseTo(14.43, 10);
    expect(sumUsdQuotes([], 'feePending')).toBe(0);
  });

  it('throws on an unreadable quote instead of contributing zero', () => {
    // "$0.00 unclaimed" for fees we failed to read is a lie the operator cannot
    // detect; a skipped row with a reason is one they can.
    expect(() => sumUsdQuotes([{ quotes: { usd: { value: '' } } }], 'feePending'))
      .toThrow(KrystalFieldError);
    expect(() => sumUsdQuotes([{ quotes: {} }], 'feePending')).toThrow(KrystalFieldError);
    expect(() => sumUsdQuotes('nope', 'feePending')).toThrow(KrystalFieldError);
  });
});

describe('mapUserPositionViews', () => {
  it('maps every well-formed row', () => {
    const result = mapUserPositionViews(
      envelope([rawPosition(), rawPosition({ tokenId: '396427' })]),
      context([POOL_A]),
    );
    expect(result.positions.map((p) => p.tokenId)).toEqual(['396426', '396427']);
    expect(result.skipped).toEqual([]);
  });

  it('treats an OMITTED `positions` key as zero positions when statsByChain is present', () => {
    // Verified live: a funded Safe holding no LP positions returns
    // `{ statsByChain: { "4663": { openPositionCount: 0, … } } }` with no
    // `positions` key at all. Reading that as malformed would make a correctly
    // configured, brand-new Safe look broken on every refresh.
    const result = mapUserPositionViews(
      { statsByChain: { '4663': { openPositionCount: 0 } } },
      context(),
    );
    expect(result).toEqual({ positions: [], skipped: [] });
  });

  it('still throws when BOTH keys are absent — that is a genuinely bad payload', () => {
    // `statsByChain` is the discriminator. Without it, "no positions key" is not
    // evidence of an empty wallet, and answering with a confident empty table
    // would hide a broken upstream indefinitely.
    expect(() => mapUserPositionViews({}, context())).toThrow(KrystalFieldError);
    expect(() => mapUserPositionViews({ somethingElse: 1 }, context())).toThrow(KrystalFieldError);
    expect(() => mapUserPositionViews(null, context())).toThrow(KrystalFieldError);
    expect(() => mapUserPositionViews([], context())).toThrow(KrystalFieldError);
    expect(() => mapUserPositionViews({ positions: 'nope' }, context())).toThrow(KrystalFieldError);
  });

  it('handles an explicitly empty positions array', () => {
    expect(mapUserPositionViews(envelope([]), context())).toEqual({ positions: [], skipped: [] });
  });

  it('skips a malformed row with a reason instead of aborting the batch', () => {
    // One junk row on a four-week-old chain must not blank the whole table.
    const result = mapUserPositionViews(
      envelope([
        rawPosition(),
        rawPosition({ tokenId: '999', currentPositionValue: '' }),
        rawPosition({ tokenId: '396427' }),
      ]),
      context(),
    );

    expect(result.positions.map((p) => p.tokenId)).toEqual(['396426', '396427']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ index: 1, identifier: '999' });
    expect(result.skipped[0]!.reason).toContain('currentPositionValue');
  });

  it('reports an unidentifiable row rather than dropping it silently', () => {
    const result = mapUserPositionViews(envelope([{ garbage: true }, null]), context());
    expect(result.positions).toEqual([]);
    expect(result.skipped.map((s) => s.identifier)).toEqual(['<unknown>', '<unknown>']);
    expect(result.skipped.map((s) => s.index)).toEqual([0, 1]);
  });

  it('never yields a NaN field via the skip path', () => {
    const result = mapUserPositionViews(
      envelope([rawPosition({ minPrice: 'abc' }), rawPosition()]),
      context(),
    );
    expect(result.positions).toHaveLength(1);
    expect(Number.isNaN(result.positions[0]!.minPrice)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Deployment settings validation
// ---------------------------------------------------------------------------

describe('validateSettingsInput', () => {
  const SAFE = '0x216f91ce3c1cb358e583441d6179c6c19c834a2e';
  const MODULE = '0xb4acbc08e0e0a2d0e2ea9d1f0d4c0e0f0a0b0c0d';

  it('accepts a well-formed pair', () => {
    const result = validateSettingsInput({ safeAddress: SAFE, moduleAddress: MODULE });
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.patch).toEqual({ safeAddress: SAFE, moduleAddress: MODULE });
  });

  it('normalizes case — stored addresses are lowercase so comparison is equality', () => {
    const shouty = SAFE.toUpperCase().replace('0X', '0x');
    expect(validateSettingsInput({ safeAddress: shouty }).patch.safeAddress).toBe(SAFE);
    expect(validateSettingsInput({ safeAddress: `  ${shouty}  ` }).patch.safeAddress).toBe(SAFE);
  });

  it('rejects malformed addresses without throwing', () => {
    for (const junk of ['not-an-address', '0x123', SAFE.slice(0, -1), `${SAFE}00`, '0xzz', 42, {}, []]) {
      const result = validateSettingsInput({ safeAddress: junk });
      expect(result.valid).toBe(false);
      expect(result.issues.map((i) => i.field)).toEqual(['safeAddress']);
    }
  });

  it('rejects a non-object body without throwing', () => {
    for (const junk of [null, undefined, 'settings', 42, []]) {
      const result = validateSettingsInput(junk);
      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.patch).toEqual({});
    }
  });

  it('accumulates an issue per bad field rather than stopping at the first', () => {
    const result = validateSettingsInput({ safeAddress: 'nope', moduleAddress: 'also-nope' });
    expect(result.issues.map((i) => i.field)).toEqual(['safeAddress', 'moduleAddress']);
  });

  it('refuses the all-zero address — it also 403s every later Krystal call', () => {
    const zero = `0x${'0'.repeat(40)}`;
    const result = validateSettingsInput({ safeAddress: zero });
    expect(result.valid).toBe(false);
    expect(result.issues[0]!.message).toContain('all-zero');
    // Case-insensitively, too: the WAF does not care how it is spelled.
    expect(validateSettingsInput({ safeAddress: `0X${'0'.repeat(40)}` }).valid).toBe(false);
  });

  it('distinguishes "omitted" from "explicitly cleared"', () => {
    // The request type is `{ safeAddress?: string | null }` precisely because
    // these mean different things. If omission cleared the field, a pane that
    // only edits the Safe address would wipe the module address on every save.
    expect(validateSettingsInput({}).patch).toEqual({});
    expect(validateSettingsInput({ safeAddress: undefined }).patch).toEqual({});
    expect(validateSettingsInput({ moduleAddress: MODULE }).patch).toEqual({
      moduleAddress: MODULE,
    });

    expect(validateSettingsInput({ safeAddress: null }).patch).toEqual({ safeAddress: null });
    // A cleared form input arrives as "" — read it as "clear", not as invalid,
    // otherwise the operator has no way to unset the field from the UI.
    expect(validateSettingsInput({ safeAddress: '' }).patch).toEqual({ safeAddress: null });
    expect(validateSettingsInput({ safeAddress: '   ' }).patch).toEqual({ safeAddress: null });
  });

  it('drops unknown keys instead of persisting them', () => {
    const result = validateSettingsInput({ safeAddress: SAFE, sneakyFutureField: true });
    expect(result.valid).toBe(true);
    expect(Object.keys(result.patch)).toEqual(['safeAddress']);
  });
});
