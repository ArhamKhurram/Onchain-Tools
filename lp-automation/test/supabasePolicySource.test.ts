import { describe, it, expect } from 'vitest';
import {
  PolicySourceError,
  createSupabasePolicySource,
  rowToPolicy,
  rowsToBundle,
} from '../src/lifecycle/supabasePolicySource.js';

// Postgres `numeric` arrives over PostgREST as a STRING. Every fixture below
// uses strings for numerics on purpose — if the mapper is ever "simplified" to
// assume numbers, these tests are what catches it.
const row = (over: Record<string, unknown> = {}) => ({
  version: 3,
  is_active: true,
  chain: 'robinhood',
  max_position_size_usd: '250',
  daily_spend_cap_usd: '500',
  allowed_pools: ['0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a'],
  min_tvl_usd: '100000',
  min_24h_volume_usd: '50000',
  max_il_risk_score: '40',
  min_fees_vs_gas_ratio: '3',
  max_interval_hours: '24',
  range_exit_percent: '5',
  min_efficiency_delta_percent: '5',
  sustained_duration_minutes: '60',
  ...over,
}) as any;

describe('rowToPolicy — range strategy', () => {
  it('reads an explicit strategy', () => {
    expect(rowToPolicy(row({ range_strategy: 'wide' })).rebalanceTrigger.rangeStrategy).toBe('wide');
    expect(rowToPolicy(row({ range_strategy: 'full' })).rebalanceTrigger.rangeStrategy).toBe('full');
  });

  it('defaults a null/absent strategy to narrow — a row predating the column', () => {
    expect(rowToPolicy(row({ range_strategy: null })).rebalanceTrigger.rangeStrategy).toBe('narrow');
  });

  it('THROWS on an unrecognised strategy rather than redeploying under the wrong one', () => {
    // A corrupted value is not a default. Silently treating "aggressive" as
    // narrow would place funds in a band nobody chose.
    expect(() => rowToPolicy(row({ range_strategy: 'aggressive' }))).toThrow(/range_strategy/);
  });
});

describe('rowToPolicy', () => {
  it('parses Postgres numeric strings into numbers', () => {
    const policy = rowToPolicy(row());
    expect(policy.maxPositionSizeUsd).toBe(250);
    expect(policy.dailySpendCapUsd).toBe(500);
    expect(policy.compoundTrigger.minFeesVsGasRatio).toBe(3);
    expect(policy.switchingBuffer.sustainedDurationMinutes).toBe(60);
  });

  it('maps the flattened columns back into the nested policy shape', () => {
    const policy = rowToPolicy(row());
    expect(policy.poolSelectionCriteria).toEqual({
      minTvlUsd: 100000, min24hVolumeUsd: 50000, maxIlRiskScore: 40,
    });
    expect(policy.rebalanceTrigger).toEqual({
      enabled: true,
      rangeExitPercent: 5,
      rangeStrategy: 'narrow',
    });
  });

  it('maps auto flags from the database columns', () => {
    expect(rowToPolicy(row({ auto_compound: false })).compoundTrigger.enabled).toBe(false);
    expect(rowToPolicy(row({ auto_rebalance: false })).rebalanceTrigger.enabled).toBe(false);
    expect(rowToPolicy(row({ auto_compound: null })).compoundTrigger.enabled).toBe(true);
    expect(rowToPolicy(row({ auto_rebalance: null })).rebalanceTrigger.enabled).toBe(true);
  });

  it('accepts real numbers as well as strings', () => {
    expect(rowToPolicy(row({ max_position_size_usd: 250 })).maxPositionSizeUsd).toBe(250);
  });

  // The whole point of the explicit coercion: Number('') and Number(null) are
  // both 0, which would turn a missing cap into a cap of zero.
  it.each([
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
  ])('throws rather than reading %s as 0', (_label, value) => {
    expect(() => rowToPolicy(row({ daily_spend_cap_usd: value }))).toThrow(PolicySourceError);
  });

  it('throws on a non-finite numeric', () => {
    expect(() => rowToPolicy(row({ max_interval_hours: 'not-a-number' }))).toThrow(PolicySourceError);
  });

  it('rejects an unsupported chain rather than coercing it', () => {
    expect(() => rowToPolicy(row({ chain: 'base' }))).toThrow(/Unsupported chain/);
  });

  it('treats a null allowlist as empty — which means the system does nothing', () => {
    expect(rowToPolicy(row({ allowed_pools: null })).allowedPools).toEqual([]);
  });

  it('rejects a malformed pool address instead of passing it to the signer', () => {
    expect(() => rowToPolicy(row({ allowed_pools: ['0xnope'] }))).toThrow(/malformed address/);
  });

  it('rejects a non-lowercase pool address (the column stores lowercase)', () => {
    expect(() => rowToPolicy(row({ allowed_pools: ['0x69BFAF19C9F377BB306A89AED9F6B07E2C1A8D9A'] })))
      .toThrow(/malformed address/);
  });
});

describe('rowsToBundle', () => {
  it('keeps every version, not just the active one', () => {
    // A position pins the version it opened under; dropping retired versions
    // would orphan those positions.
    const bundle = rowsToBundle([row({ version: 1, is_active: false }), row({ version: 2 })]);
    expect(bundle.policies.map((p) => p.version)).toEqual([1, 2]);
  });

  it('returns an empty bundle for no rows', () => {
    expect(rowsToBundle([])).toEqual({ policies: [], bindings: {} });
  });
});

describe('createSupabasePolicySource', () => {
  it('returns null when neither variable is set, so the caller can fall back', () => {
    expect(createSupabasePolicySource({}, 'user-1')).toBeNull();
  });

  it.each([
    ['url without key', { SUPABASE_URL: 'https://x.supabase.co' }],
    ['key without url', { SUPABASE_SERVICE_ROLE_KEY: 'service-key' }],
  ])('throws on a half-configured source (%s) rather than silently falling back', (_l, env) => {
    expect(() => createSupabasePolicySource(env as any, 'user-1')).toThrow(/half-configured/);
  });

  it('requires a user id when Supabase is configured', () => {
    expect(() =>
      createSupabasePolicySource(
        { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' } as any,
        '',
      ),
    ).toThrow(/LP_POLICY_USER_ID/);
  });

  it('ignores whitespace-only values as unset', () => {
    expect(createSupabasePolicySource({ SUPABASE_URL: '   ', SUPABASE_SERVICE_ROLE_KEY: '  ' } as any, 'u'))
      .toBeNull();
  });
});

describe('read-only guarantee', () => {
  it('exposes no write method — the signer process must never author policy', () => {
    const src = createSupabasePolicySource(
      { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' } as any,
      'user-1',
    )!;
    const names = new Set([
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(src)),
      ...Object.getOwnPropertyNames(src),
    ]);
    for (const forbidden of ['save', 'write', 'update', 'insert', 'upsert', 'delete']) {
      expect(names.has(forbidden)).toBe(false);
    }
    expect(names.has('load')).toBe(true);
  });
});
