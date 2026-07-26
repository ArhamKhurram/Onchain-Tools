// Reads the policy the OCT dashboard writes (LP_AUTOMATION_PLAN.md §9 point 1).
//
// This closes the seam between the two halves of the system: the dashboard
// PUTs a new version to `lp_automation_policies` via the backend, and this is
// how the signer process sees it. Without this the worker would read a local
// JSON file and dashboard edits would have no effect on what actually runs —
// the settings would look authoritative while changing nothing.
//
// READ-ONLY, deliberately and permanently. There is no write path in this file
// and there must never be one: §9.1 makes the signer process a consumer of
// policy, never a producer, so that the process holding the key cannot widen
// its own limits by editing the row that constrains it. That is the same
// principle the on-chain module enforces for the chain; this is its off-chain
// counterpart.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AutomationPolicy, ChainSlug, RangeStrategy } from '../types.js';
import type { PolicyBundle, PolicySource } from './types.js';

const TABLE = 'lp_automation_policies';

/** Row shape written by `supabase/migrations/*_lp_automation_policies.sql`. */
interface PolicyRow {
  version: number;
  is_active: boolean;
  chain: string;
  max_position_size_usd: string | number;
  daily_spend_cap_usd: string | number;
  allowed_pools: string[] | null;
  min_tvl_usd: string | number;
  min_24h_volume_usd: string | number;
  max_il_risk_score: string | number;
  min_fees_vs_gas_ratio: string | number;
  max_interval_hours: string | number;
  range_exit_percent: string | number;
  range_strategy: string | null;
  min_efficiency_delta_percent: string | number;
  sustained_duration_minutes: string | number;
}

export class PolicySourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicySourceError';
  }
}

/**
 * Postgres `numeric` arrives over PostgREST as a *string*, not a number —
 * numeric has more precision than a JS double, so the driver refuses to lose
 * it silently. `Number('12.5')` is fine, but `Number('')` is 0 and
 * `Number(null)` is 0, either of which would turn a missing spend cap into a
 * cap of zero (or, worse for a threshold, into a permissive value). Every
 * conversion is therefore explicit and throws rather than defaulting.
 */
function num(value: unknown, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PolicySourceError(`${field} is not a finite number.`);
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new PolicySourceError(`${field} is not a finite number: "${value}".`);
    return parsed;
  }
  throw new PolicySourceError(`${field} is missing or not numeric (received ${JSON.stringify(value)}).`);
}

/**
 * Map the stored `range_strategy`. Null/absent -> 'narrow': a row written
 * before the column existed predates the choice, and narrow is the shipped
 * default. An unrecognised non-null value is a corrupted row, not a default, so
 * it throws rather than silently redeploying funds under the wrong strategy.
 */
function rangeStrategyOf(value: string | null): RangeStrategy {
  if (value === null || value === undefined) return 'narrow';
  if (value === 'narrow' || value === 'wide' || value === 'full') return value;
  throw new PolicySourceError(`range_strategy is not a known strategy: "${value}".`);
}

/** Pure — exported for tests. Throws rather than producing a partial policy. */
export function rowToPolicy(row: PolicyRow): AutomationPolicy {
  if (row.chain !== 'robinhood') {
    throw new PolicySourceError(`Unsupported chain "${row.chain}" in policy version ${row.version}.`);
  }
  const pools = row.allowed_pools ?? [];
  if (!Array.isArray(pools)) {
    throw new PolicySourceError(`allowed_pools is not an array in policy version ${row.version}.`);
  }
  for (const pool of pools) {
    if (typeof pool !== 'string' || !/^0x[0-9a-f]{40}$/.test(pool)) {
      throw new PolicySourceError(`allowed_pools contains a malformed address in version ${row.version}: ${String(pool)}`);
    }
  }

  return {
    version: num(row.version, 'version'),
    chain: row.chain as ChainSlug,
    maxPositionSizeUsd: num(row.max_position_size_usd, 'max_position_size_usd'),
    allowedPools: pools as AutomationPolicy['allowedPools'],
    poolSelectionCriteria: {
      minTvlUsd: num(row.min_tvl_usd, 'min_tvl_usd'),
      min24hVolumeUsd: num(row.min_24h_volume_usd, 'min_24h_volume_usd'),
      maxIlRiskScore: num(row.max_il_risk_score, 'max_il_risk_score'),
    },
    compoundTrigger: {
      minFeesVsGasRatio: num(row.min_fees_vs_gas_ratio, 'min_fees_vs_gas_ratio'),
      maxIntervalHours: num(row.max_interval_hours, 'max_interval_hours'),
    },
    rebalanceTrigger: {
      rangeExitPercent: num(row.range_exit_percent, 'range_exit_percent'),
      rangeStrategy: rangeStrategyOf(row.range_strategy),
    },
    switchingBuffer: {
      minEfficiencyDeltaPercent: num(row.min_efficiency_delta_percent, 'min_efficiency_delta_percent'),
      sustainedDurationMinutes: num(row.sustained_duration_minutes, 'sustained_duration_minutes'),
    },
    dailySpendCapUsd: num(row.daily_spend_cap_usd, 'daily_spend_cap_usd'),
  };
}

/**
 * Every version is loaded, not just the active one. A position pins the version
 * it was opened under (§5), so retiring a version must not orphan the positions
 * still bound to it — `resolvePolicyForPosition` needs the historical row to
 * resolve them, and it fails closed if the row is missing.
 */
export function rowsToBundle(rows: PolicyRow[]): PolicyBundle {
  return { policies: rows.map(rowToPolicy), bindings: {} };
}

export interface SupabasePolicySourceOptions {
  url: string;
  serviceRoleKey: string;
  userId: string;
}

export class SupabasePolicySource implements PolicySource {
  private readonly client: SupabaseClient;

  constructor(private readonly options: SupabasePolicySourceOptions) {
    this.client = createClient(options.url, options.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async load(): Promise<PolicyBundle> {
    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('user_id', this.options.userId)
      .order('version', { ascending: true });

    // A read failure is NOT "no policy". Returning an empty bundle here would
    // silently drop the operator's configured caps and let the loop fall back
    // to defaults; throwing keeps the previously-loaded policy in place, which
    // is what the lifecycle loop does with a failed tick.
    if (error) throw new PolicySourceError(`Failed to read LP policies: ${error.message}`);
    if (!data) throw new PolicySourceError('LP policy read returned no data.');

    return rowsToBundle(data as PolicyRow[]);
  }
}

/**
 * Build a Supabase-backed source if configured, else null so the caller can
 * fall back. Returns null only when BOTH values are absent — a half-configured
 * source (url without key, or vice versa) throws, because it is far more likely
 * to be a deployment mistake than an intentional fallback.
 */
export function createSupabasePolicySource(
  env: NodeJS.ProcessEnv,
  userId: string,
): SupabasePolicySource | null {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url && !key) return null;
  if (!url || !key) {
    throw new PolicySourceError(
      'Supabase policy source is half-configured: set BOTH SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or neither.',
    );
  }
  if (!userId) {
    throw new PolicySourceError('LP_POLICY_USER_ID is required when reading the policy from Supabase.');
  }
  return new SupabasePolicySource({ url, serviceRoleKey: key, userId });
}
