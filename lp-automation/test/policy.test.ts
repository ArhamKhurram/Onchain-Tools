import { describe, it, expect } from 'vitest';
import {
  DEFAULT_POLICY,
  validatePolicy,
  isValidPolicy,
  isPoolAllowed,
  poolMeetsCriteria,
  surfaceCandidates,
  resolvePolicyForPosition,
  currentDefaultPolicy,
  nextPolicyVersion,
  applyPolicyToAll,
} from '../src/policy/index.js';
import type { PolicyBinding } from '../src/policy/index.js';
import type { Address, AutomationPolicy, PoolCandidate } from '../src/types.js';
import { ROBINHOOD_CHAIN_ID } from '../src/types.js';

const POOL_A = '0x1111111111111111111111111111111111111111' as Address;
const POOL_B = '0x2222222222222222222222222222222222222222' as Address;
const POOL_MIXED = '0xAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAb' as Address;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const validPolicy = (): AutomationPolicy => clone(DEFAULT_POLICY);

/** Deep-ish override helper so a nested section can be replaced wholesale. */
function withPolicy(overrides: Record<string, unknown>): unknown {
  return { ...validPolicy(), ...overrides };
}

/** The set of `field` paths reported, for asserting exactly what was rejected. */
const fieldsOf = (input: unknown): string[] => validatePolicy(input).issues.map((i) => i.field);

function makePool(overrides: Partial<PoolCandidate> = {}): PoolCandidate {
  return {
    address: POOL_A,
    chainId: ROBINHOOD_CHAIN_ID,
    platform: 'uniswapv3',
    feeTierBps: 3000,
    token0: { address: POOL_B, symbol: 'AAA', decimals: 18 },
    token1: { address: POOL_B, symbol: 'BBB', decimals: 6 },
    tvlUsd: 1_000_000,
    volume24hUsd: 400_000,
    feeApr: 0.4,
    ...overrides,
  };
}

// ===========================================================================
// DEFAULT_POLICY
// ===========================================================================

describe('DEFAULT_POLICY', () => {
  it('is itself valid', () => {
    const result = validatePolicy(DEFAULT_POLICY);
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('ships with an EMPTY allowlist so the system can do nothing until a human picks a pool', () => {
    expect(DEFAULT_POLICY.allowedPools).toEqual([]);
    expect(isPoolAllowed(DEFAULT_POLICY, POOL_A)).toBe(false);
  });

  it('is conservative: caps are small and the buffer is slow', () => {
    // Guards against someone "temporarily" raising a default and forgetting.
    expect(DEFAULT_POLICY.maxPositionSizeUsd).toBeLessThanOrEqual(500);
    expect(DEFAULT_POLICY.dailySpendCapUsd).toBeLessThanOrEqual(1_000);
    expect(DEFAULT_POLICY.compoundTrigger.minFeesVsGasRatio).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_POLICY.switchingBuffer.sustainedDurationMinutes).toBeGreaterThanOrEqual(30);
    expect(DEFAULT_POLICY.switchingBuffer.minEfficiencyDeltaPercent).toBeGreaterThan(0);
  });

  it('has a daily cap that can actually fund one position', () => {
    expect(DEFAULT_POLICY.dailySpendCapUsd).toBeGreaterThanOrEqual(DEFAULT_POLICY.maxPositionSizeUsd);
  });
});

// ===========================================================================
// validatePolicy
// ===========================================================================

describe('validatePolicy', () => {
  it('accepts a valid policy with no issues', () => {
    expect(validatePolicy(validPolicy())).toEqual({ valid: true, issues: [] });
    expect(isValidPolicy(validPolicy())).toBe(true);
  });

  it('never throws, whatever it is handed', () => {
    for (const junk of [null, undefined, 42, 'policy', [], [validPolicy()], true]) {
      expect(() => validatePolicy(junk)).not.toThrow();
      expect(validatePolicy(junk).valid).toBe(false);
    }
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const broken = withPolicy({
      chain: 'base',
      maxPositionSizeUsd: -1,
      dailySpendCapUsd: 0,
      compoundTrigger: { minFeesVsGasRatio: 0.5, maxIntervalHours: 0 },
    });
    const fields = fieldsOf(broken);
    expect(fields).toContain('chain');
    expect(fields).toContain('maxPositionSizeUsd');
    expect(fields).toContain('dailySpendCapUsd');
    expect(fields).toContain('compoundTrigger.minFeesVsGasRatio');
    expect(fields).toContain('compoundTrigger.maxIntervalHours');
    expect(fields.length).toBeGreaterThanOrEqual(5);
  });

  it('rejects any chain other than robinhood', () => {
    for (const chain of ['base', 'ethereum', '', null, undefined, 4663]) {
      expect(fieldsOf(withPolicy({ chain }))).toContain('chain');
    }
  });

  it.each([0, -1, -0.0001])('rejects maxPositionSizeUsd = %s', (value) => {
    expect(fieldsOf(withPolicy({ maxPositionSizeUsd: value }))).toContain('maxPositionSizeUsd');
  });

  it.each([0, -50])('rejects dailySpendCapUsd = %s', (value) => {
    expect(fieldsOf(withPolicy({ dailySpendCapUsd: value }))).toContain('dailySpendCapUsd');
  });

  it('rejects NaN and Infinity caps (the "<= 0" check alone would pass NaN)', () => {
    // This is the whole reason every numeric check starts from Number.isFinite:
    // `NaN <= 0` is false, so a naive guard would treat a blank form field as an
    // acceptable position cap.
    expect(NaN <= 0).toBe(false); // documents the trap being defended against
    expect(fieldsOf(withPolicy({ maxPositionSizeUsd: NaN }))).toContain('maxPositionSizeUsd');
    expect(fieldsOf(withPolicy({ maxPositionSizeUsd: Infinity }))).toContain('maxPositionSizeUsd');
    expect(fieldsOf(withPolicy({ dailySpendCapUsd: NaN }))).toContain('dailySpendCapUsd');
  });

  it('rejects non-numeric caps', () => {
    expect(fieldsOf(withPolicy({ maxPositionSizeUsd: '250' }))).toContain('maxPositionSizeUsd');
    expect(fieldsOf(withPolicy({ maxPositionSizeUsd: null }))).toContain('maxPositionSizeUsd');
    expect(fieldsOf(withPolicy({ maxPositionSizeUsd: undefined }))).toContain('maxPositionSizeUsd');
  });

  it('rejects a daily cap that cannot fund a single position', () => {
    const fields = fieldsOf(withPolicy({ maxPositionSizeUsd: 1000, dailySpendCapUsd: 500 }));
    expect(fields).toContain('dailySpendCapUsd');
  });

  it('accepts a daily cap exactly equal to the position size', () => {
    expect(validatePolicy(withPolicy({ maxPositionSizeUsd: 500, dailySpendCapUsd: 500 })).valid).toBe(
      true,
    );
  });

  it('rejects minFeesVsGasRatio below 1 — compounding for less than gas is always wrong', () => {
    for (const ratio of [0.99, 0.5, 0, -2]) {
      expect(fieldsOf(withPolicy({ compoundTrigger: { minFeesVsGasRatio: ratio, maxIntervalHours: 6 } }))).toContain(
        'compoundTrigger.minFeesVsGasRatio',
      );
    }
  });

  it('accepts minFeesVsGasRatio of exactly 1 (break-even is the hard floor)', () => {
    expect(
      validatePolicy(withPolicy({ compoundTrigger: { minFeesVsGasRatio: 1, maxIntervalHours: 6 } }))
        .valid,
    ).toBe(true);
  });

  it.each([0, -1, NaN])('rejects sustainedDurationMinutes = %s', (value) => {
    // Zero duration removes the buffer entirely — a momentary crossover would move.
    expect(
      fieldsOf(
        withPolicy({ switchingBuffer: { minEfficiencyDeltaPercent: 5, sustainedDurationMinutes: value } }),
      ),
    ).toContain('switchingBuffer.sustainedDurationMinutes');
  });

  it('rejects a negative minEfficiencyDeltaPercent but allows zero', () => {
    expect(
      fieldsOf(
        withPolicy({ switchingBuffer: { minEfficiencyDeltaPercent: -1, sustainedDurationMinutes: 60 } }),
      ),
    ).toContain('switchingBuffer.minEfficiencyDeltaPercent');
    expect(
      validatePolicy(
        withPolicy({ switchingBuffer: { minEfficiencyDeltaPercent: 0, sustainedDurationMinutes: 60 } }),
      ).valid,
    ).toBe(true);
  });

  it.each([
    ['too short', '0x1234'],
    ['no 0x prefix', '1111111111111111111111111111111111111111'],
    ['non-hex characters', '0xzzzz111111111111111111111111111111111111'],
    ['41 hex digits', '0x11111111111111111111111111111111111111111'],
    ['empty string', ''],
  ])('rejects a malformed pool address (%s) and names its index', (_label, bad) => {
    const fields = fieldsOf(withPolicy({ allowedPools: [POOL_A, bad, POOL_B] }));
    expect(fields).toContain('allowedPools[1]');
    expect(fields).not.toContain('allowedPools[0]');
    expect(fields).not.toContain('allowedPools[2]');
  });

  it('rejects non-string allowlist entries and non-array allowlists', () => {
    expect(fieldsOf(withPolicy({ allowedPools: [null] }))).toContain('allowedPools[0]');
    expect(fieldsOf(withPolicy({ allowedPools: 'all' }))).toContain('allowedPools');
    expect(fieldsOf(withPolicy({ allowedPools: null }))).toContain('allowedPools');
  });

  it('accepts a checksummed (mixed-case) address', () => {
    expect(validatePolicy(withPolicy({ allowedPools: [POOL_MIXED] })).valid).toBe(true);
  });

  it('accepts an empty allowlist — "do nothing" is valid, not an error', () => {
    expect(validatePolicy(withPolicy({ allowedPools: [] })).valid).toBe(true);
  });

  it.each([-1, 101, NaN, 100.0001])('rejects maxIlRiskScore = %s (0-100 scale)', (value) => {
    expect(
      fieldsOf(
        withPolicy({
          poolSelectionCriteria: { minTvlUsd: 0, min24hVolumeUsd: 0, maxIlRiskScore: value },
        }),
      ),
    ).toContain('poolSelectionCriteria.maxIlRiskScore');
  });

  it.each([0, 100, 50])('accepts maxIlRiskScore = %s', (value) => {
    expect(
      validatePolicy(
        withPolicy({
          poolSelectionCriteria: { minTvlUsd: 0, min24hVolumeUsd: 0, maxIlRiskScore: value },
        }),
      ).valid,
    ).toBe(true);
  });

  it('rejects negative surfacing thresholds', () => {
    const fields = fieldsOf(
      withPolicy({
        poolSelectionCriteria: { minTvlUsd: -1, min24hVolumeUsd: -1, maxIlRiskScore: 40 },
      }),
    );
    expect(fields).toContain('poolSelectionCriteria.minTvlUsd');
    expect(fields).toContain('poolSelectionCriteria.min24hVolumeUsd');
  });

  it.each([0, -1, 1.5, NaN, '1'])('rejects version = %s', (value) => {
    expect(fieldsOf(withPolicy({ version: value }))).toContain('version');
  });

  it('reports a missing section once rather than crashing on its fields', () => {
    const fields = fieldsOf(withPolicy({ switchingBuffer: undefined }));
    expect(fields).toContain('switchingBuffer');
    expect(fields).not.toContain('switchingBuffer.sustainedDurationMinutes');
  });

  it('rejects an array as a section (arrays are not policy objects)', () => {
    expect(fieldsOf(withPolicy({ compoundTrigger: [] }))).toContain('compoundTrigger');
  });

  it('attaches a human-readable message to every issue', () => {
    for (const issue of validatePolicy({}).issues) {
      expect(typeof issue.message).toBe('string');
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// isPoolAllowed — the gate
// ===========================================================================

describe('isPoolAllowed', () => {
  const policy: AutomationPolicy = { ...validPolicy(), allowedPools: [POOL_A] };

  it('allows an explicitly listed pool', () => {
    expect(isPoolAllowed(policy, POOL_A)).toBe(true);
  });

  it('refuses a pool that is not listed', () => {
    expect(isPoolAllowed(policy, POOL_B)).toBe(false);
  });

  it('SAFETY: a pool meeting every criterion is still NOT allowed if it is absent from allowedPools', () => {
    // The core §9.2 property. This pool is on the right chain, has 4x the
    // required TVL, 8x the required volume, and a low IL risk score — and it is
    // still refused, because nobody ticked it.
    const perfect = makePool({
      address: POOL_B,
      tvlUsd: policy.poolSelectionCriteria.minTvlUsd * 4,
      volume24hUsd: policy.poolSelectionCriteria.min24hVolumeUsd * 8,
    });
    const criteria = poolMeetsCriteria(policy, perfect, 1);

    expect(criteria.meets).toBe(true); // shortlisted...
    expect(criteria.failures).toEqual([]);
    expect(isPoolAllowed(policy, perfect.address)).toBe(false); // ...but NOT admitted
    expect(criteria.alreadyAllowed).toBe(false);
  });

  it('SAFETY: an empty allowlist admits nothing, however good the pool', () => {
    const empty: AutomationPolicy = { ...validPolicy(), allowedPools: [] };
    const perfect = makePool({ tvlUsd: 1e12, volume24hUsd: 1e12 });
    expect(poolMeetsCriteria(empty, perfect, 0).meets).toBe(true);
    expect(isPoolAllowed(empty, perfect.address)).toBe(false);
  });

  it('is case-insensitive in both directions', () => {
    const mixed: AutomationPolicy = { ...validPolicy(), allowedPools: [POOL_MIXED] };
    expect(isPoolAllowed(mixed, POOL_MIXED.toLowerCase())).toBe(true);
    expect(isPoolAllowed(mixed, POOL_MIXED.toUpperCase().replace('0X', '0x'))).toBe(true);
  });

  it('refuses malformed input instead of throwing', () => {
    for (const junk of ['', '0x', 'not-an-address', POOL_A.slice(0, -1)]) {
      expect(() => isPoolAllowed(policy, junk)).not.toThrow();
      expect(isPoolAllowed(policy, junk)).toBe(false);
    }
  });

  it('refuses a substring or prefix match', () => {
    expect(isPoolAllowed(policy, `${POOL_A}00`)).toBe(false);
    expect(isPoolAllowed({ ...policy, allowedPools: [POOL_A] }, POOL_A.slice(0, 41) as Address)).toBe(
      false,
    );
  });
});

// ===========================================================================
// poolMeetsCriteria — the shortlist (no authority)
// ===========================================================================

describe('poolMeetsCriteria', () => {
  const policy: AutomationPolicy = {
    ...validPolicy(),
    allowedPools: [POOL_A],
    poolSelectionCriteria: { minTvlUsd: 250_000, min24hVolumeUsd: 50_000, maxIlRiskScore: 40 },
  };

  it('passes a pool clearing every criterion', () => {
    expect(poolMeetsCriteria(policy, makePool(), 10)).toMatchObject({
      meets: true,
      failures: [],
      alreadyAllowed: true,
    });
  });

  it('names each failing criterion', () => {
    const thin = makePool({ tvlUsd: 1_000, volume24hUsd: 100 });
    const result = poolMeetsCriteria(policy, thin, 90);
    expect(result.meets).toBe(false);
    expect(result.failures.sort()).toEqual(['maxIlRiskScore', 'min24hVolumeUsd', 'minTvlUsd']);
  });

  it('accepts a pool exactly at the TVL and volume thresholds', () => {
    const boundary = makePool({ tvlUsd: 250_000, volume24hUsd: 50_000 });
    expect(poolMeetsCriteria(policy, boundary, 40).meets).toBe(true);
  });

  it('rejects a pool one dollar below the TVL threshold', () => {
    expect(poolMeetsCriteria(policy, makePool({ tvlUsd: 249_999 }), 10).failures).toContain(
      'minTvlUsd',
    );
  });

  it('SAFETY: an unknown IL risk score fails the criterion — unknown is not safe', () => {
    const result = poolMeetsCriteria(policy, makePool(), null);
    expect(result.meets).toBe(false);
    expect(result.failures).toContain('maxIlRiskScore');
  });

  it('treats a non-finite IL risk score as unknown', () => {
    expect(poolMeetsCriteria(policy, makePool(), NaN).failures).toContain('maxIlRiskScore');
  });

  it('rejects a pool on the wrong chain', () => {
    expect(poolMeetsCriteria(policy, makePool({ chainId: 8453 }), 10).failures).toContain('chain');
  });

  it('treats missing TVL or volume data as a failure, not a pass', () => {
    expect(poolMeetsCriteria(policy, makePool({ tvlUsd: NaN }), 10).failures).toContain('minTvlUsd');
    expect(
      poolMeetsCriteria(policy, makePool({ volume24hUsd: NaN }), 10).failures,
    ).toContain('min24hVolumeUsd');
  });

  it('reports allowlist membership without granting it', () => {
    // A shortlisted-but-unlisted pool reports alreadyAllowed:false so the
    // dashboard renders it as an unticked checkbox.
    const unlisted = poolMeetsCriteria(policy, makePool({ address: POOL_B }), 10);
    expect(unlisted.meets).toBe(true);
    expect(unlisted.alreadyAllowed).toBe(false);
  });
});

describe('surfaceCandidates', () => {
  const policy: AutomationPolicy = {
    ...validPolicy(),
    allowedPools: [],
    poolSelectionCriteria: { minTvlUsd: 250_000, min24hVolumeUsd: 50_000, maxIlRiskScore: 40 },
  };

  it('returns only the pools worth showing, and grants none of them', () => {
    const good = makePool({ address: POOL_A });
    const thin = makePool({ address: POOL_B, tvlUsd: 100 });
    const scores = new Map<Address, number>([
      [POOL_A, 10],
      [POOL_B, 10],
    ]);

    const surfaced = surfaceCandidates(policy, [good, thin], scores);
    expect(surfaced.map((p) => p.address)).toEqual([POOL_A]);
    // Surfacing changed nothing about what is allowed.
    expect(policy.allowedPools).toEqual([]);
    expect(isPoolAllowed(policy, POOL_A)).toBe(false);
  });

  it('omits pools with no IL risk score at all', () => {
    expect(surfaceCandidates(policy, [makePool()], new Map())).toEqual([]);
  });
});

// ===========================================================================
// Versioning
// ===========================================================================

describe('policy versioning', () => {
  const v1: AutomationPolicy = { ...validPolicy(), version: 1, maxPositionSizeUsd: 250 };
  const v2: AutomationPolicy = { ...validPolicy(), version: 2, maxPositionSizeUsd: 1000 };
  const v3: AutomationPolicy = { ...validPolicy(), version: 3, maxPositionSizeUsd: 5000 };
  const policies = [v1, v2, v3];

  const binding = (tokenId: string, policyVersion: number): PolicyBinding => ({
    tokenId,
    policyVersion,
  });

  it('SAFETY: a position stays pinned to the version it was opened under', () => {
    // The whole point: v3 raising the cap to $5000 must not touch a position
    // opened under v1's $250 cap.
    const resolved = resolvePolicyForPosition(binding('42', 1), policies);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.policy.maxPositionSizeUsd).toBe(250);
  });

  it('resolves each open position to its own version independently', () => {
    const caps = [1, 2, 3].map((v) => {
      const r = resolvePolicyForPosition(binding(`t${v}`, v), policies);
      return r.ok ? r.policy.maxPositionSizeUsd : null;
    });
    expect(caps).toEqual([250, 1000, 5000]);
  });

  it('SAFETY: fails closed on an unknown version instead of falling back to the newest', () => {
    // Silently substituting the current default here is exactly the retroactive
    // application the versioning model exists to prevent.
    const resolved = resolvePolicyForPosition(binding('42', 99), policies);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.reason).toBe('unknown_version');
      expect(resolved.requestedVersion).toBe(99);
    }
  });

  it('fails closed on duplicate versions rather than guessing which is real', () => {
    const corrupt = [v1, { ...v2, maxPositionSizeUsd: 9_999 }, v2];
    const resolved = resolvePolicyForPosition(binding('42', 2), corrupt);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toBe('duplicate_version');
  });

  it('fails closed on an empty policy set', () => {
    const resolved = resolvePolicyForPosition(binding('42', 1), []);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toBe('no_policies');
  });

  it('picks the highest version as the current default, not the array order', () => {
    expect(currentDefaultPolicy([v3, v1, v2])?.version).toBe(3);
    expect(currentDefaultPolicy([])).toBeNull();
  });

  it('numbers the next version above the current default', () => {
    expect(nextPolicyVersion(policies)).toBe(4);
    expect(nextPolicyVersion([])).toBe(1);
  });

  it('applyPolicyToAll is the only path that re-pins an open position', () => {
    const bindings = [binding('a', 1), binding('b', 2), binding('c', 3)];
    const result = applyPolicyToAll(bindings, policies, 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bindings.map((b) => b.policyVersion)).toEqual([3, 3, 3]);
      expect(result.changed).toBe(2); // 'c' was already on v3
    }
  });

  it('applyPolicyToAll is pure — the input bindings are untouched', () => {
    const bindings = [binding('a', 1), binding('b', 2)];
    const snapshot = clone(bindings);
    applyPolicyToAll(bindings, policies, 3);
    expect(bindings).toEqual(snapshot);
  });

  it('applyPolicyToAll preserves extra fields on the caller\'s own row shape', () => {
    const rows = [{ tokenId: 'a', policyVersion: 1, note: 'opened by hand' }];
    const result = applyPolicyToAll(rows, policies, 2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bindings[0]).toEqual({ tokenId: 'a', policyVersion: 2, note: 'opened by hand' });
  });

  it('applyPolicyToAll refuses a target version that does not exist', () => {
    const result = applyPolicyToAll([binding('a', 1)], policies, 99);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_version');
  });

  it('applyPolicyToAll refuses an ambiguous target version', () => {
    const result = applyPolicyToAll([binding('a', 1)], [v1, v2, v2], 2);
    expect(result.ok).toBe(false);
  });

  it('reports zero changes when every position is already on the target', () => {
    const result = applyPolicyToAll([binding('a', 2), binding('b', 2)], policies, 2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changed).toBe(0);
  });
});
