import { describe, it, expect } from 'vitest';
import {
  KrystalFieldError,
  KrystalWafError,
  ROBINHOOD_CHAIN_ID,
  buildKrystalQuery,
  buildPolicy,
  currentDefaultPolicy,
  filterCandidates,
  mapPoolCandidate,
  mapTopPools,
  nextPolicyVersion,
  normalizeAllowedPools,
  feePercentToUnits,
  policyToRpcPayload,
  readNumberParam,
  rowToStored,
  validatePolicyInput,
  type AutomationPolicy,
  type PolicyRow,
  type StoredPolicy,
} from '../src/api/routes/lp';

// Pure units only — no network, no database. Everything here is a function the
// LP policy API depends on being right before anything signs a transaction.

const POOL_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const POOL_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** A valid PUT body: an AutomationPolicy without `version`. */
const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  chain: 'robinhood',
  maxPositionSizeUsd: 250,
  allowedPools: [],
  poolSelectionCriteria: { minTvlUsd: 250_000, min24hVolumeUsd: 50_000, maxIlRiskScore: 40 },
  compoundTrigger: { minFeesVsGasRatio: 3, maxIntervalHours: 24 },
  rebalanceTrigger: { rangeExitPercent: 5 },
  switchingBuffer: { minEfficiencyDeltaPercent: 5, sustainedDurationMinutes: 60 },
  dailySpendCapUsd: 500,
  ...over,
});

const fieldsOf = (input: unknown, version = 1): string[] =>
  validatePolicyInput(input, version).issues.map((issue) => issue.field);

describe('validatePolicyInput', () => {
  it('accepts the conservative default policy', () => {
    expect(validatePolicyInput(body(), 1)).toEqual({ valid: true, issues: [] });
  });

  it('rejects a non-object body without throwing', () => {
    for (const junk of [null, undefined, 'policy', 42, []]) {
      const result = validatePolicyInput(junk, 1);
      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
    }
  });

  it('accumulates every problem instead of stopping at the first', () => {
    const fields = fieldsOf(
      body({
        chain: 'base',
        maxPositionSizeUsd: 0,
        rebalanceTrigger: { rangeExitPercent: 0 },
      }),
    );
    expect(fields).toContain('chain');
    expect(fields).toContain('maxPositionSizeUsd');
    expect(fields).toContain('rebalanceTrigger.rangeExitPercent');
  });

  it('rejects NaN and Infinity, which a `<= 0` guard would silently pass', () => {
    expect(fieldsOf(body({ maxPositionSizeUsd: Number.NaN }))).toContain('maxPositionSizeUsd');
    expect(fieldsOf(body({ maxPositionSizeUsd: Number.POSITIVE_INFINITY }))).toContain(
      'maxPositionSizeUsd',
    );
  });

  it('rejects numeric strings — a form value must arrive as a number', () => {
    expect(fieldsOf(body({ maxPositionSizeUsd: '250' }))).toContain('maxPositionSizeUsd');
  });

  it('rejects any chain other than robinhood in phase 1', () => {
    expect(fieldsOf(body({ chain: 'base' }))).toContain('chain');
    expect(fieldsOf(body({ chain: undefined }))).toContain('chain');
  });

  it('rejects a daily cap that cannot fund a single position', () => {
    const result = validatePolicyInput(
      body({ maxPositionSizeUsd: 1000, dailySpendCapUsd: 500 }),
      1,
    );
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.field)).toContain('dailySpendCapUsd');
    expect(result.issues.find((i) => i.field === 'dailySpendCapUsd')?.message).toContain(
      'maxPositionSizeUsd',
    );
  });

  it('allows a daily cap exactly equal to one position', () => {
    expect(validatePolicyInput(body({ maxPositionSizeUsd: 500, dailySpendCapUsd: 500 }), 1).valid)
      .toBe(true);
  });

  it('rejects a compound ratio below 1 (paying more gas than the fees claimed)', () => {
    expect(fieldsOf(body({ compoundTrigger: { minFeesVsGasRatio: 0.9, maxIntervalHours: 24 } })))
      .toContain('compoundTrigger.minFeesVsGasRatio');
    expect(validatePolicyInput(
      body({ compoundTrigger: { minFeesVsGasRatio: 1, maxIntervalHours: 24 } }),
      1,
    ).valid).toBe(true);
  });

  it('permits a zero switching delta but not a zero sustained duration', () => {
    expect(validatePolicyInput(
      body({ switchingBuffer: { minEfficiencyDeltaPercent: 0, sustainedDurationMinutes: 60 } }),
      1,
    ).valid).toBe(true);

    // Zero duration removes the buffer that stops a momentary crossover from
    // triggering a move — an explicit acceptance criterion in the plan.
    expect(fieldsOf(
      body({ switchingBuffer: { minEfficiencyDeltaPercent: 5, sustainedDurationMinutes: 0 } }),
    )).toContain('switchingBuffer.sustainedDurationMinutes');

    expect(fieldsOf(
      body({ switchingBuffer: { minEfficiencyDeltaPercent: -1, sustainedDurationMinutes: 60 } }),
    )).toContain('switchingBuffer.minEfficiencyDeltaPercent');
  });

  it('bounds the IL risk score to 0-100', () => {
    const over = body({
      poolSelectionCriteria: { minTvlUsd: 0, min24hVolumeUsd: 0, maxIlRiskScore: 101 },
    });
    expect(fieldsOf(over)).toContain('poolSelectionCriteria.maxIlRiskScore');
  });

  it('reports the index of each malformed allowlist entry', () => {
    const fields = fieldsOf(body({ allowedPools: [POOL_A, 'not-an-address', 123] }));
    expect(fields).toContain('allowedPools[1]');
    expect(fields).toContain('allowedPools[2]');
    expect(fields).not.toContain('allowedPools[0]');
  });

  it('rejects an allowlist that is not an array', () => {
    expect(fieldsOf(body({ allowedPools: POOL_A }))).toContain('allowedPools');
  });

  it('flags a missing nested section as one issue rather than crashing', () => {
    expect(fieldsOf(body({ compoundTrigger: undefined }))).toContain('compoundTrigger');
    expect(fieldsOf(body({ poolSelectionCriteria: null }))).toContain('poolSelectionCriteria');
  });

  it('accepts each of the three range strategies', () => {
    for (const rangeStrategy of ['narrow', 'wide', 'full'] as const) {
      expect(
        validatePolicyInput(body({ rebalanceTrigger: { rangeExitPercent: 5, rangeStrategy } }), 1)
          .valid,
      ).toBe(true);
    }
  });

  it('rejects an unknown range strategy rather than silently coercing it', () => {
    expect(
      fieldsOf(body({ rebalanceTrigger: { rangeExitPercent: 5, rangeStrategy: 'tight' } })),
    ).toContain('rebalanceTrigger.rangeStrategy');
    expect(
      fieldsOf(body({ rebalanceTrigger: { rangeExitPercent: 5, rangeStrategy: 42 } })),
    ).toContain('rebalanceTrigger.rangeStrategy');
    expect(
      fieldsOf(body({ rebalanceTrigger: { rangeExitPercent: 5, rangeStrategy: null } })),
    ).toContain('rebalanceTrigger.rangeStrategy');
  });

  it('accepts an absent range strategy — an older client predates the field', () => {
    // The fixture omits rangeStrategy entirely; buildPolicy fills the default.
    expect(validatePolicyInput(body(), 1).valid).toBe(true);
    expect(
      fieldsOf(body({ rebalanceTrigger: { rangeExitPercent: 5 } })),
    ).not.toContain('rebalanceTrigger.rangeStrategy');
  });

  it('validates the SERVER-assigned version, not one supplied by the client', () => {
    // A client-sent version is ignored entirely: version 9999 in the body does
    // not make the server-assigned version 1 invalid.
    expect(validatePolicyInput(body({ version: 9999 }), 1).valid).toBe(true);
    // ...and a nonsensical server-side version is still caught.
    expect(fieldsOf(body(), 0)).toContain('version');
    expect(fieldsOf(body(), 1.5)).toContain('version');
  });
});

describe('buildPolicy', () => {
  it('stamps the server-assigned version and drops unknown keys', () => {
    const policy = buildPolicy(body({ version: 42, sneakyFutureField: true }), 7);
    expect(policy.version).toBe(7);
    expect(policy).not.toHaveProperty('sneakyFutureField');
    expect(Object.keys(policy).sort()).toEqual(
      [
        'allowedPools',
        'chain',
        'compoundTrigger',
        'dailySpendCapUsd',
        'maxPositionSizeUsd',
        'poolSelectionCriteria',
        'rebalanceTrigger',
        'switchingBuffer',
        'version',
      ],
    );
  });

  it('lowercases and de-duplicates the allowlist', () => {
    const policy = buildPolicy(
      body({ allowedPools: [POOL_A.toUpperCase().replace('0X', '0x'), POOL_A, POOL_B] }),
      1,
    );
    expect(policy.allowedPools).toEqual([POOL_A, POOL_B]);
  });

  it('defaults an absent range strategy to narrow', () => {
    const policy = buildPolicy(body({ rebalanceTrigger: { rangeExitPercent: 5 } }), 1);
    expect(policy.rebalanceTrigger.rangeStrategy).toBe('narrow');
  });

  it('carries an explicit range strategy through unchanged', () => {
    const policy = buildPolicy(
      body({ rebalanceTrigger: { rangeExitPercent: 5, rangeStrategy: 'wide' } }),
      1,
    );
    expect(policy.rebalanceTrigger.rangeStrategy).toBe('wide');
  });
});

// ---------------------------------------------------------------------------
// Persistence mappers — the field must survive the round trip to the database
// and back, or a saved strategy would silently revert on the next load.
// ---------------------------------------------------------------------------

/** Build a hosted PolicyRow from an RPC payload, as `lp_append_policy` would. */
const rowFromPayload = (payload: Record<string, unknown>, version = 1): PolicyRow => ({
  version,
  is_active: true,
  chain: payload.chain as string,
  max_position_size_usd: payload.max_position_size_usd as number,
  daily_spend_cap_usd: payload.daily_spend_cap_usd as number,
  allowed_pools: payload.allowed_pools as string[],
  min_tvl_usd: payload.min_tvl_usd as number,
  min_24h_volume_usd: payload.min_24h_volume_usd as number,
  max_il_risk_score: payload.max_il_risk_score as number,
  min_fees_vs_gas_ratio: payload.min_fees_vs_gas_ratio as number,
  max_interval_hours: payload.max_interval_hours as number,
  range_exit_percent: payload.range_exit_percent as number,
  range_strategy: payload.range_strategy as string,
  auto_compound: (payload.auto_compound as boolean | undefined) ?? true,
  auto_rebalance: (payload.auto_rebalance as boolean | undefined) ?? true,
  min_efficiency_delta_percent: payload.min_efficiency_delta_percent as number,
  sustained_duration_minutes: payload.sustained_duration_minutes as number,
  created_at: '2026-07-26T00:00:00.000Z',
});

describe('policy persistence round-trip', () => {
  it('preserves the range strategy through payload -> row -> policy', () => {
    for (const rangeStrategy of ['narrow', 'wide', 'full'] as const) {
      const original = buildPolicy(
        body({ rebalanceTrigger: { rangeExitPercent: 5, rangeStrategy } }),
        3,
      );
      const payload = policyToRpcPayload(original);
      expect(payload.range_strategy).toBe(rangeStrategy);

      const restored = rowToStored(rowFromPayload(payload, 3)).policy;
      expect(restored.rebalanceTrigger.rangeStrategy).toBe(rangeStrategy);
      expect(restored.rebalanceTrigger.rangeExitPercent).toBe(5);
    }
  });

  it('reads a legacy row with no range strategy as narrow', () => {
    // A row that predates the column would surface `range_strategy` as undefined;
    // the mapper must not emit an out-of-enum value.
    const payload = policyToRpcPayload(buildPolicy(body(), 1));
    const legacy = rowFromPayload(payload);
    delete (legacy as { range_strategy?: string }).range_strategy;
    expect(rowToStored(legacy).policy.rebalanceTrigger.rangeStrategy).toBe('narrow');
  });

  it('preserves auto-compound and auto-rebalance flags through payload -> row -> policy', () => {
    const original = buildPolicy(
      body({
        compoundTrigger: { enabled: false, minFeesVsGasRatio: 3, maxIntervalHours: 24 },
        rebalanceTrigger: { enabled: false, rangeExitPercent: 5, rangeStrategy: 'wide' },
      }),
      2,
    );
    const payload = policyToRpcPayload(original);
    expect(payload.auto_compound).toBe(false);
    expect(payload.auto_rebalance).toBe(false);

    const restored = rowToStored(rowFromPayload(payload, 2)).policy;
    expect(restored.compoundTrigger.enabled).toBe(false);
    expect(restored.rebalanceTrigger.enabled).toBe(false);
    expect(restored.rebalanceTrigger.rangeStrategy).toBe('wide');
  });

  it('rejects a non-boolean auto-compound flag', () => {
    expect(
      fieldsOf(body({ compoundTrigger: { enabled: 'yes', minFeesVsGasRatio: 3, maxIntervalHours: 24 } })),
    ).toContain('compoundTrigger.enabled');
  });
});

describe('normalizeAllowedPools', () => {
  it('preserves the operator ordering while collapsing duplicates', () => {
    expect(normalizeAllowedPools([POOL_B, POOL_A, POOL_B.toUpperCase().replace('0X', '0x')]))
      .toEqual([POOL_B, POOL_A]);
  });

  it('returns an empty array unchanged — an empty allowlist means "do nothing"', () => {
    expect(normalizeAllowedPools([])).toEqual([]);
  });
});

describe('nextPolicyVersion', () => {
  it('starts at 1 for the genesis policy', () => {
    expect(nextPolicyVersion([])).toBe(1);
  });

  it('bumps past the maximum, not the array length or the last element', () => {
    expect(nextPolicyVersion([1, 2, 3])).toBe(4);
    expect(nextPolicyVersion([3, 1, 2])).toBe(4);
    // A gap (a version deleted by hand) must not cause a number to be REUSED —
    // reuse would silently re-point positions pinned to it at different rules.
    expect(nextPolicyVersion([1, 5])).toBe(6);
  });

  it('ignores non-finite versions rather than producing NaN', () => {
    expect(nextPolicyVersion([1, Number.NaN, 2])).toBe(3);
  });
});

const stored = (version: number, over: Partial<AutomationPolicy> = {}): StoredPolicy => ({
  isActive: false,
  createdAt: '2026-07-26T00:00:00.000Z',
  policy: buildPolicy(body(over), version),
});

describe('currentDefaultPolicy', () => {
  it('returns null for an empty set rather than inventing one', () => {
    expect(currentDefaultPolicy([])).toBeNull();
  });

  it('picks the highest version regardless of array order', () => {
    const picked = currentDefaultPolicy([stored(2), stored(5), stored(3)]);
    expect(picked?.policy.version).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Krystal response mapper
// ---------------------------------------------------------------------------

/** A row in the exact shape chain 4663 returns: numbers as strings, fee as %. */
const rawPool = (over: Record<string, unknown> = {}) => ({
  chainId: ROBINHOOD_CHAIN_ID,
  protocol: 'uniswapv3',
  poolAddress: POOL_A,
  feeTier: 0.05,
  tvlUsd: '4791.63651',
  token0: { symbol: 'WETH', address: POOL_B, decimals: '18', usdPrice: '' },
  token1: { symbol: 'USDC', address: POOL_A, decimals: '6', usdPrice: '' },
  stat24h: { volumeUsd: '115603.48', feeUsd: '1156.03', apr: 8806.02 },
  ...over,
});

describe('mapPoolCandidate', () => {
  it('parses Krystal string numerics without going through Number()', () => {
    const pool = mapPoolCandidate(rawPool());
    expect(pool.tvlUsd).toBeCloseTo(4791.63651, 5);
    expect(pool.volume24hUsd).toBeCloseTo(115603.48, 2);
    expect(pool.token0.decimals).toBe(18);
    expect(pool.token1.decimals).toBe(6);
  });

  it('reads feeTier as a PERCENT and stores the on-chain fee unit: 0.05% -> 500', () => {
    // Uniswap on-chain fee units (what pool.fee() returns), not basis points —
    // the frontend divides by 10000 to display, and a 1% pool must read 10000
    // so its tick spacing resolves to 200 rather than the 0.01% tier's 1.
    expect(mapPoolCandidate(rawPool({ feeTier: 0.05 })).feeTierBps).toBe(500);
    expect(mapPoolCandidate(rawPool({ feeTier: 0.01 })).feeTierBps).toBe(100);
    expect(mapPoolCandidate(rawPool({ feeTier: 0.3 })).feeTierBps).toBe(3000);
    expect(mapPoolCandidate(rawPool({ feeTier: 1 })).feeTierBps).toBe(10000);
    // Krystal's own unit is kept alongside so the UI can show either.
    expect(mapPoolCandidate(rawPool({ feeTier: 0.05 })).feeTierPercent).toBe(0.05);
  });

  it('converts APR percent to a fraction', () => {
    const pool = mapPoolCandidate(rawPool({ stat24h: { volumeUsd: '1', apr: 234.15 } }));
    expect(pool.feeApr).toBeCloseTo(2.3415, 6);
  });

  it('lowercases addresses so allowlist comparison is plain equality', () => {
    const pool = mapPoolCandidate(
      rawPool({ poolAddress: POOL_A.toUpperCase().replace('0X', '0x') }),
    );
    expect(pool.address).toBe(POOL_A);
  });

  it('throws rather than defaulting when a numeric field is missing or empty', () => {
    // `Number('')`, `Number(null)` and `Number([])` are all 0 — a TVL of 0 from
    // a missing field is indistinguishable downstream from a real 0.
    expect(() => mapPoolCandidate(rawPool({ tvlUsd: '' }))).toThrow(KrystalFieldError);
    expect(() => mapPoolCandidate(rawPool({ tvlUsd: null }))).toThrow(KrystalFieldError);
    expect(() => mapPoolCandidate(rawPool({ tvlUsd: undefined }))).toThrow(KrystalFieldError);
    expect(() => mapPoolCandidate(rawPool({ tvlUsd: '12abc' }))).toThrow(KrystalFieldError);
    expect(() => mapPoolCandidate(rawPool({ tvlUsd: true }))).toThrow(KrystalFieldError);
    expect(() => mapPoolCandidate(rawPool({ tvlUsd: '-1' }))).toThrow(KrystalFieldError);
  });

  it('throws when stat24h or its fields are absent', () => {
    expect(() => mapPoolCandidate(rawPool({ stat24h: undefined }))).toThrow(KrystalFieldError);
    expect(() => mapPoolCandidate(rawPool({ stat24h: { apr: 1 } }))).toThrow(KrystalFieldError);
  });

  it('rejects a non-positive fee tier', () => {
    expect(() => mapPoolCandidate(rawPool({ feeTier: 0 }))).toThrow(KrystalFieldError);
    expect(() => mapPoolCandidate(rawPool({ feeTier: -1 }))).toThrow(KrystalFieldError);
  });

  it('reports a 32-byte v4 pool id as out of scope, not as a bad address', () => {
    const poolId = `0x${'1'.repeat(64)}`;
    expect(() => mapPoolCandidate(rawPool({ poolAddress: poolId, protocol: 'uniswapv4' })))
      .toThrow(/pool id/);
  });

  it('rejects an implausible decimals value', () => {
    expect(() =>
      mapPoolCandidate(rawPool({ token0: { symbol: 'X', address: POOL_B, decimals: '99' } })),
    ).toThrow(KrystalFieldError);
  });

  it('never produces NaN in any numeric field of a successful mapping', () => {
    const pool = mapPoolCandidate(rawPool());
    for (const value of [
      pool.tvlUsd,
      pool.volume24hUsd,
      pool.feeApr,
      pool.feeTierBps,
      pool.feeTierPercent,
      pool.chainId,
      pool.token0.decimals,
      pool.token1.decimals,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe('mapTopPools', () => {
  it('skips a malformed row with a recorded reason instead of aborting the batch', () => {
    const result = mapTopPools({
      result: [rawPool(), rawPool({ tvlUsd: '' }), rawPool({ poolAddress: POOL_B })],
    });
    expect(result.pools.map((p) => p.address)).toEqual([POOL_A, POOL_B]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ index: 1, identifier: POOL_A });
    expect(result.skipped[0]!.reason).toContain('tvlUsd');
  });

  it('throws on a malformed envelope — we are not looking at the right response', () => {
    expect(() => mapTopPools(null)).toThrow(KrystalFieldError);
    expect(() => mapTopPools({})).toThrow(KrystalFieldError);
    expect(() => mapTopPools({ result: 'nope' })).toThrow(KrystalFieldError);
  });

  it('handles an empty result set', () => {
    expect(mapTopPools({ result: [] })).toEqual({ pools: [], skipped: [] });
  });
});

describe('filterCandidates', () => {
  const pools = [
    mapPoolCandidate(rawPool({ poolAddress: POOL_A, tvlUsd: '500000', stat24h: { volumeUsd: '90000', apr: 10 } })),
    mapPoolCandidate(rawPool({ poolAddress: POOL_B, tvlUsd: '900000', stat24h: { volumeUsd: '10', apr: 10 } })),
    mapPoolCandidate(rawPool({ poolAddress: `0x${'c'.repeat(40)}`, tvlUsd: '10', stat24h: { volumeUsd: '90000', apr: 10 } })),
  ];

  it('applies both thresholds and sorts by TVL descending', () => {
    const result = filterCandidates(pools, ROBINHOOD_CHAIN_ID, {
      minTvlUsd: 0,
      min24hVolumeUsd: 0,
      limit: 10,
    });
    expect(result.map((p) => p.tvlUsd)).toEqual([900000, 500000, 10]);

    const gated = filterCandidates(pools, ROBINHOOD_CHAIN_ID, {
      minTvlUsd: 250_000,
      min24hVolumeUsd: 50_000,
      limit: 10,
    });
    expect(gated.map((p) => p.address)).toEqual([POOL_A]);
  });

  it('drops pools on another chain or another protocol', () => {
    const foreign = mapPoolCandidate(rawPool({ chainId: 8453 }));
    const v2 = mapPoolCandidate(rawPool({ protocol: 'uniswapv2' }));
    const result = filterCandidates([foreign, v2, ...pools], ROBINHOOD_CHAIN_ID, {
      minTvlUsd: 0,
      min24hVolumeUsd: 0,
      limit: 10,
    });
    expect(result.every((p) => p.chainId === ROBINHOOD_CHAIN_ID)).toBe(true);
    expect(result.every((p) => p.platform === 'uniswapv3')).toBe(true);
  });

  it('honours the limit', () => {
    const result = filterCandidates(pools, ROBINHOOD_CHAIN_ID, {
      minTvlUsd: 0,
      min24hVolumeUsd: 0,
      limit: 2,
    });
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Cloudflare zero-address tripwire
// ---------------------------------------------------------------------------

describe('buildKrystalQuery', () => {
  it('builds an ordinary query string', () => {
    expect(buildKrystalQuery({ chainId: ROBINHOOD_CHAIN_ID, limit: 500 }))
      .toBe('chainId=4663&limit=500');
  });

  it('omits undefined values instead of serializing "undefined"', () => {
    expect(buildKrystalQuery({ chainId: 4663, limit: undefined })).toBe('chainId=4663');
  });

  it('refuses the all-zero address — Cloudflare 403s such requests with HTML', () => {
    const zero = `0x${'0'.repeat(40)}`;
    expect(() => buildKrystalQuery({ chainId: 4663, platformWallet: zero }))
      .toThrow(KrystalWafError);
    // Case-insensitive and substring-based: the tripwire fires on the value
    // appearing anywhere in the query string, not only as the whole value.
    expect(() => buildKrystalQuery({ chainId: 4663, x: `0X${'0'.repeat(40)}` }))
      .toThrow(KrystalWafError);
    expect(() => buildKrystalQuery({ chainId: 4663, x: `prefix-${zero}-suffix` }))
      .toThrow(KrystalWafError);
  });

  it('names the offending parameter so the cause is obvious', () => {
    try {
      buildKrystalQuery({ platformWallet: `0x${'0'.repeat(40)}` });
      throw new Error('expected a KrystalWafError');
    } catch (err) {
      expect(err).toBeInstanceOf(KrystalWafError);
      expect((err as KrystalWafError).parameter).toBe('platformWallet');
    }
  });

  it('allows a non-zero address', () => {
    expect(buildKrystalQuery({ platformWallet: POOL_A })).toContain(POOL_A);
  });
});

describe('feePercentToUnits', () => {
  it('converts to on-chain fee units without float error (0.05% must be exactly 500)', () => {
    expect(feePercentToUnits(0.05)).toBe(500);
    expect(feePercentToUnits(0.3)).toBe(3000);
    expect(feePercentToUnits(1)).toBe(10000);
  });

  it('keeps fractional tiers fractional rather than rounding to a whole unit', () => {
    expect(feePercentToUnits(3.995)).toBeCloseTo(39950, 6);
  });
});

describe('readNumberParam', () => {
  it('reads well-formed numeric strings', () => {
    expect(readNumberParam('250000')).toBe(250_000);
    expect(readNumberParam(' 1.5 ')).toBe(1.5);
    expect(readNumberParam('0')).toBe(0);
  });

  it('returns undefined (never NaN) for absent or malformed input', () => {
    // NaN would compare false against every threshold and silently empty the
    // candidate list, which reads as "no pools qualify" rather than "bad input".
    for (const junk of [undefined, null, '', '   ', 'abc', '12abc', ['1'], {}]) {
      expect(readNumberParam(junk)).toBeUndefined();
    }
  });
});
