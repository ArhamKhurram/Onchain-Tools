import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isHostedMode } from '../../storage/index.js';
import { auditLogPathFromEnv, nativeTokenUsdFromEnv, readAuditLog } from '../../lp/auditReader.js';
import { buildLineagePnlInputs } from '../../lp/lineagePnl.js';
import { deriveAllLineagePnl, extractLineageLinks, type LineageLink, type LineagePnl } from '../../lp/pnl.js';
import { getUserId, safeError } from '../shared.js';

// LP automation policy + pool-candidate API (LP_AUTOMATION_PLAN.md §5, §9.1-2).
//
// The policy is configured here, in the dashboard, and only ever READ by the
// signer process in `lp-automation/` (§9.1). Two invariants from the plan are
// enforced on this side of the wire:
//
//   * Editing a policy creates a NEW VERSION. An open position pins a version,
//     so changing the default must not retroactively re-price it (§5). Nothing
//     in this file rewrites a stored policy's contents.
//   * Pools are ADMITTED ONLY BY A HUMAN. `poolSelectionCriteria` and the
//     Krystal candidate feed exist to SURFACE pools for manual selection; they
//     never write to `allowedPools` (§9.2). The candidate endpoint is read-only
//     by construction.
//
// DELIBERATE DUPLICATION — `lp-automation/src/policy/validate.ts`,
// `.../policy/versioning.ts` and `.../ingest/krystal/{coerce,pools}.ts` already
// implement the validation rules, the version-bump rule and the Krystal mapper.
// They are NOT imported: `lp-automation` is a separate process/workspace that
// must not be pulled into the backend's dependency graph (it is deployed
// standalone with as little third-party code as possible). The rules below are
// a faithful restatement — bounds, messages and coercion semantics are kept
// identical on purpose. The eventual fix is to lift the policy schema and the
// Krystal mappers into `packages/shared` (@oct/shared) and have both sides
// import them; until then, a change to either copy must be mirrored in the
// other.

// ---------------------------------------------------------------------------
// Policy shape — mirrors `AutomationPolicy` in lp-automation/src/types.ts.
// ---------------------------------------------------------------------------

export const ROBINHOOD_CHAIN_ID = 4663;

export type Address = `0x${string}`;

/**
 * Where a rebalance places the new range — mirrors `RangeStrategy` in
 * lp-automation/src/types.ts. Narrow is the tightest band (most fees, most
 * rebalances); full is a whole-range position that never rebalances. Default is
 * 'narrow'. Kept in sync with the DB CHECK in the range-strategy migration.
 */
export type RangeStrategy = 'narrow' | 'wide' | 'full';

export const RANGE_STRATEGIES = ['narrow', 'wide', 'full'] as const;

/** Filled in for a client (older, or predating the field) that omits the value. */
export const DEFAULT_RANGE_STRATEGY: RangeStrategy = 'narrow';

export interface AutomationPolicy {
  version: number;
  chain: 'robinhood';
  maxPositionSizeUsd: number;
  /** Explicit pool addresses, manually ticked in the dashboard (plan §9.2). */
  allowedPools: Address[];
  /** Used to SURFACE candidates for manual selection — never to auto-admit. */
  poolSelectionCriteria: {
    minTvlUsd: number;
    min24hVolumeUsd: number;
    maxIlRiskScore: number;
  };
  compoundTrigger: {
    enabled: boolean;
    minFeesVsGasRatio: number;
    maxIntervalHours: number;
  };
  rebalanceTrigger: {
    enabled: boolean;
    rangeExitPercent: number;
    /** Where a rebalance places the new range. Defaults to 'narrow'. */
    rangeStrategy: RangeStrategy;
  };
  switchingBuffer: {
    minEfficiencyDeltaPercent: number;
    sustainedDurationMinutes: number;
  };
  /** Mirrored on-chain in the Safe module — this value alone enforces nothing. */
  dailySpendCapUsd: number;
}

export interface StoredPolicy {
  policy: AutomationPolicy;
  isActive: boolean;
  createdAt: string;
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

// ---------------------------------------------------------------------------
// Validation (mirror of lp-automation/src/policy/validate.ts)
// ---------------------------------------------------------------------------
//
// Two rules govern this section, both inherited verbatim from that module:
//
//   1. It NEVER throws. The dashboard must be able to render every problem at
//      once, so issues accumulate rather than short-circuiting.
//   2. It fails closed. The obvious `value <= 0` guard silently PASSES NaN,
//      which is how a blank form field becomes an uncapped position size — so
//      every numeric check starts from `Number.isFinite`.
//
// This runs on EVERY write. The client having validated first is irrelevant;
// the request body is untrusted input.

export interface PolicyValidationIssue {
  /** Dotted path to the offending field, e.g. `compoundTrigger.minFeesVsGasRatio`. */
  field: string;
  /** Operator-facing explanation. Safe to render verbatim in the dashboard. */
  message: string;
}

export interface PolicyValidationResult {
  valid: boolean;
  issues: PolicyValidationIssue[];
}

interface NumberRule {
  min?: number;
  max?: number;
  /** Exclusive lower bound — use for "must be strictly positive". */
  exclusiveMin?: number;
  integer?: boolean;
  /** Extra context appended to the message, explaining WHY the bound exists. */
  because?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkNumber(
  issues: PolicyValidationIssue[],
  field: string,
  value: unknown,
  rule: NumberRule,
): number | null {
  const suffix = rule.because ? ` (${rule.because})` : '';

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    // Catches undefined, null, strings, NaN and ±Infinity in one gate.
    issues.push({ field, message: `must be a finite number${suffix}` });
    return null;
  }
  if (rule.integer && !Number.isInteger(value)) {
    issues.push({ field, message: `must be a whole number${suffix}` });
    return null;
  }
  if (rule.exclusiveMin !== undefined && value <= rule.exclusiveMin) {
    issues.push({ field, message: `must be greater than ${rule.exclusiveMin}${suffix}` });
    return null;
  }
  if (rule.min !== undefined && value < rule.min) {
    issues.push({ field, message: `must be at least ${rule.min}${suffix}` });
    return null;
  }
  if (rule.max !== undefined && value > rule.max) {
    issues.push({ field, message: `must be at most ${rule.max}${suffix}` });
    return null;
  }
  return value;
}

function checkSection(
  issues: PolicyValidationIssue[],
  field: string,
  value: unknown,
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    issues.push({ field, message: 'must be an object' });
    return null;
  }
  return value;
}

function checkBoolean(
  issues: PolicyValidationIssue[],
  field: string,
  value: unknown,
  because?: string,
): void {
  const suffix = because ? ` (${because})` : '';
  if (value === undefined) return;
  if (typeof value !== 'boolean') {
    issues.push({ field, message: `must be true or false${suffix}` });
  }
}

/**
 * Validate the `rangeStrategy` enum.
 *
 * ABSENT is accepted — a client predating the field sends no value and
 * `buildPolicy` fills in the 'narrow' default. A PRESENT value must be exactly
 * one of the three strategies; anything else is rejected rather than silently
 * coerced, so a typo cannot quietly land a rebalance in the wrong range band.
 */
function checkRangeStrategy(
  issues: PolicyValidationIssue[],
  field: string,
  value: unknown,
): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !(RANGE_STRATEGIES as readonly string[]).includes(value)) {
    issues.push({ field, message: `must be one of ${RANGE_STRATEGIES.join(', ')}` });
  }
}

/**
 * Coerce an already-validated-or-absent strategy to a concrete value. `undefined`
 * (older client) and any unexpected value fall back to the 'narrow' default; a
 * value that reached here from `validatePolicyInput` is already known-good.
 */
function normalizeRangeStrategy(value: unknown): RangeStrategy {
  return value === 'narrow' || value === 'wide' || value === 'full'
    ? value
    : DEFAULT_RANGE_STRATEGY;
}

function normalizeEnabled(value: unknown, defaultValue = true): boolean {
  return typeof value === 'boolean' ? value : defaultValue;
}

/**
 * Validate an untrusted request body as an `AutomationPolicy`.
 *
 * `version` is supplied by the SERVER, not the body — the client never picks a
 * version number (see `nextPolicyVersion`). It is still range-checked here so
 * the same rule set covers every field of the resulting policy.
 *
 * Never throws. `issues` is empty if and only if `valid` is true.
 */
export function validatePolicyInput(input: unknown, version: number): PolicyValidationResult {
  const issues: PolicyValidationIssue[] = [];

  if (!isRecord(input)) {
    return { valid: false, issues: [{ field: '', message: 'policy must be an object' }] };
  }

  checkNumber(issues, 'version', version, {
    exclusiveMin: 0,
    integer: true,
    because: 'versions are positive integers assigned in order',
  });

  // Phase 1 is single-chain by decision (plan §1/§10). The Safe module's
  // destination allowlist is chain-specific, so a policy naming a chain we have
  // no module for could only ever fail on-chain.
  if (input.chain !== 'robinhood') {
    issues.push({
      field: 'chain',
      message: "must be 'robinhood' (phase 1 supports no other chain)",
    });
  }

  const maxPositionSizeUsd = checkNumber(issues, 'maxPositionSizeUsd', input.maxPositionSizeUsd, {
    exclusiveMin: 0,
    because: 'a zero or negative cap can never authorize a position',
  });

  const dailySpendCapUsd = checkNumber(issues, 'dailySpendCapUsd', input.dailySpendCapUsd, {
    exclusiveMin: 0,
    because: 'a zero or negative cap can never authorize a position',
  });

  // Cross-field: a daily cap below one position's size is self-contradictory —
  // every entry would be refused, on-chain, after paying gas to find out.
  if (
    maxPositionSizeUsd !== null &&
    dailySpendCapUsd !== null &&
    dailySpendCapUsd < maxPositionSizeUsd
  ) {
    issues.push({
      field: 'dailySpendCapUsd',
      message: `must be at least maxPositionSizeUsd (${maxPositionSizeUsd}) — a smaller daily cap can never fund a single position`,
    });
  }

  if (!Array.isArray(input.allowedPools)) {
    issues.push({ field: 'allowedPools', message: 'must be an array of pool addresses' });
  } else {
    input.allowedPools.forEach((entry, index) => {
      if (typeof entry !== 'string' || !ADDRESS_PATTERN.test(entry)) {
        issues.push({
          field: `allowedPools[${index}]`,
          message: 'must be a 0x-prefixed 20-byte hex address',
        });
      }
    });
  }

  const criteria = checkSection(issues, 'poolSelectionCriteria', input.poolSelectionCriteria);
  if (criteria) {
    checkNumber(issues, 'poolSelectionCriteria.minTvlUsd', criteria.minTvlUsd, { min: 0 });
    checkNumber(issues, 'poolSelectionCriteria.min24hVolumeUsd', criteria.min24hVolumeUsd, {
      min: 0,
    });
    checkNumber(issues, 'poolSelectionCriteria.maxIlRiskScore', criteria.maxIlRiskScore, {
      min: 0,
      max: 100,
      because: 'the IL risk score is defined on a 0-100 scale',
    });
  }

  const compound = checkSection(issues, 'compoundTrigger', input.compoundTrigger);
  if (compound) {
    checkBoolean(issues, 'compoundTrigger.enabled', compound.enabled);
    // Hard floor of 1.0 — below 1 the policy instructs us to spend more on gas
    // than the fees being claimed are worth. Always wrong, in every market
    // condition, so it is a validation error rather than a tuning choice.
    checkNumber(issues, 'compoundTrigger.minFeesVsGasRatio', compound.minFeesVsGasRatio, {
      min: 1,
      because: 'compounding for less than the gas it costs is always a net loss',
    });
    checkNumber(issues, 'compoundTrigger.maxIntervalHours', compound.maxIntervalHours, {
      exclusiveMin: 0,
      because: 'a zero interval would compound on every single tick',
    });
  }

  const rebalance = checkSection(issues, 'rebalanceTrigger', input.rebalanceTrigger);
  if (rebalance) {
    checkBoolean(issues, 'rebalanceTrigger.enabled', rebalance.enabled);
    checkNumber(issues, 'rebalanceTrigger.rangeExitPercent', rebalance.rangeExitPercent, {
      exclusiveMin: 0,
      because: 'a zero threshold rebalances on the first tick outside the range',
    });
    checkRangeStrategy(issues, 'rebalanceTrigger.rangeStrategy', rebalance.rangeStrategy);
  }

  const buffer = checkSection(issues, 'switchingBuffer', input.switchingBuffer);
  if (buffer) {
    // Zero is permitted (it means "any positive advantage counts") because the
    // sustained-duration half of the buffer still gates the move. Negative is
    // not: it would authorize switching into a strictly worse pool.
    checkNumber(
      issues,
      'switchingBuffer.minEfficiencyDeltaPercent',
      buffer.minEfficiencyDeltaPercent,
      { min: 0, because: 'a negative delta would authorize switching into a worse pool' },
    );
    checkNumber(
      issues,
      'switchingBuffer.sustainedDurationMinutes',
      buffer.sustainedDurationMinutes,
      {
        exclusiveMin: 0,
        because:
          'zero duration removes the buffer entirely, allowing a momentary crossover to trigger a move',
      },
    );
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Build the policy that will actually be stored from an already-validated body.
 *
 * Reads only the known fields — an unrecognized key in the request body is
 * dropped rather than persisted, so a future field cannot arrive early and be
 * read back as if this version had been configured with it.
 *
 * Addresses are lowercased on the way in (types.ts: "Lowercase 0x-prefixed
 * address") so allowlist comparisons downstream are plain string equality, and
 * de-duplicated so a double-tick in the dashboard cannot inflate the list.
 */
export function buildPolicy(input: Record<string, unknown>, version: number): AutomationPolicy {
  const criteria = input.poolSelectionCriteria as Record<string, number>;
  const compound = input.compoundTrigger as Record<string, unknown>;
  const rebalance = input.rebalanceTrigger as {
    enabled?: unknown;
    rangeExitPercent: number;
    rangeStrategy?: unknown;
  };
  const buffer = input.switchingBuffer as Record<string, number>;

  return {
    version,
    chain: 'robinhood',
    maxPositionSizeUsd: input.maxPositionSizeUsd as number,
    allowedPools: normalizeAllowedPools(input.allowedPools as string[]),
    poolSelectionCriteria: {
      minTvlUsd: criteria.minTvlUsd,
      min24hVolumeUsd: criteria.min24hVolumeUsd,
      maxIlRiskScore: criteria.maxIlRiskScore,
    },
    compoundTrigger: {
      enabled: normalizeEnabled(compound.enabled),
      minFeesVsGasRatio: compound.minFeesVsGasRatio as number,
      maxIntervalHours: compound.maxIntervalHours as number,
    },
    rebalanceTrigger: {
      enabled: normalizeEnabled(rebalance.enabled),
      rangeExitPercent: rebalance.rangeExitPercent,
      rangeStrategy: normalizeRangeStrategy(rebalance.rangeStrategy),
    },
    switchingBuffer: {
      minEfficiencyDeltaPercent: buffer.minEfficiencyDeltaPercent,
      sustainedDurationMinutes: buffer.sustainedDurationMinutes,
    },
    dailySpendCapUsd: input.dailySpendCapUsd as number,
  };
}

/** Lowercase + de-duplicate, preserving the operator's ordering. */
export function normalizeAllowedPools(pools: readonly string[]): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const pool of pools) {
    const lower = pool.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower as Address);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Versioning (mirror of lp-automation/src/policy/versioning.ts)
// ---------------------------------------------------------------------------

/**
 * The version a newly edited policy is saved under: one past the highest
 * existing version, or 1 for the genesis policy.
 *
 * Derived from the max, never from `rows.length` or `rows.at(-1)` — array
 * order is not trusted, and a gap in the sequence (a version deleted by hand)
 * must not cause a number to be REUSED. A reused version would silently
 * re-point every open position pinned to it at different rules, which is the
 * exact retroactive change plan §5 forbids.
 */
export function nextPolicyVersion(versions: readonly number[]): number {
  let max = 0;
  for (const version of versions) {
    if (!Number.isFinite(version)) continue;
    if (version > max) max = version;
  }
  return max + 1;
}

/** Highest version wins; array order is not trusted. Null for an empty set. */
export function currentDefaultPolicy(policies: readonly StoredPolicy[]): StoredPolicy | null {
  let best: StoredPolicy | null = null;
  for (const stored of policies) {
    if (!Number.isFinite(stored.policy.version)) continue;
    if (best === null || stored.policy.version > best.policy.version) best = stored;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Krystal pool discovery (plan §3)
// ---------------------------------------------------------------------------
//
// The v1 pool endpoints named in the plan's earlier sessions are DEAD — they
// fail identically on chains 1, 8453 and 4663 (500 / 400 "chain id N not
// supported"). The only working route is the UNDOCUMENTED v2 one below, which
// is absent from Krystal's published OpenAPI spec: observed, not contracted.
// Keep the mapper defensive and treat a discovery failure as "surface no new
// candidates" (safe), never as anything that could stall an open position.

const KRYSTAL_BASE_URL = 'https://api.krystal.app';
export const TOP_POOLS_PATH = '/all/v2/lp_explorer/top_pools';

/** Phase 1 only ever surfaces Uniswap V3 pools (plan §3, verified live). */
export const KRYSTAL_PLATFORM = 'uniswapv3';

const KRYSTAL_TIMEOUT_MS = 12_000;

/**
 * Cloudflare sits in front of api.krystal.app and returns a 403 HTML block page
 * for ANY request whose query string contains the all-zero address (plan §3,
 * confirmed by bisection). It fails as HTML rather than JSON, so a naive client
 * reports a parse error instead of the real cause.
 *
 * The natural way to decline referral attribution on `platformWallet` is to
 * pass the zero address — i.e. the failure is reached by doing the obvious
 * thing — so the guard lives in the query builder rather than at one call site.
 */
const ZERO_ADDRESS_PATTERN = /0x0{40}/i;

export class KrystalWafError extends Error {
  constructor(public readonly parameter: string) {
    super(
      `Refusing to send the all-zero address in query parameter "${parameter}": ` +
        'Cloudflare answers such requests with a 403 HTML block page (LP_AUTOMATION_PLAN.md §3).',
    );
    this.name = 'KrystalWafError';
  }
}

export class KrystalRequestError extends Error {
  constructor(message: string, public readonly status: number | null) {
    super(message);
    this.name = 'KrystalRequestError';
  }
}

/**
 * Build a Krystal query string, refusing the Cloudflare tripwire.
 *
 * `undefined` values are omitted entirely rather than serialized as the string
 * "undefined".
 */
export function buildKrystalQuery(
  params: Record<string, string | number | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const encoded = String(value);
    if (ZERO_ADDRESS_PATTERN.test(encoded)) throw new KrystalWafError(key);
    search.set(key, encoded);
  }
  return search.toString();
}

// --- Defensive coercion ----------------------------------------------------
//
// Krystal returns numbers as strings ("4791.63651"), decimals as strings
// ("18"), and legitimately-absent fields as "" (`token0.usdPrice` was "" on
// every sampled row). JavaScript turns every one of those into a plausible
// number — Number('') === 0, Number(null) === 0, parseFloat('12abc') === 12 —
// and a TVL of 0 that came from a missing field is indistinguishable
// downstream from a real 0. So nothing below uses Number()/parseFloat()/+x
// directly.

export class KrystalFieldError extends Error {
  constructor(
    public readonly path: string,
    public readonly received: unknown,
    detail: string,
  ) {
    super(`Krystal field "${path}" ${detail} (received: ${describe(received)})`);
    this.name = 'KrystalFieldError';
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object') return Array.isArray(value) ? `array(${value.length})` : 'object';
  return String(value);
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KrystalFieldError(path, value, 'is not an object');
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new KrystalFieldError(path, value, 'is not an array');
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new KrystalFieldError(path, value, 'is not a string');
  if (value.length === 0) throw new KrystalFieldError(path, value, 'is an empty string');
  return value;
}

const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new KrystalFieldError(path, value, 'is not finite');
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) throw new KrystalFieldError(path, value, 'is an empty string');
    if (!NUMERIC.test(trimmed)) {
      throw new KrystalFieldError(path, value, 'is not a well-formed number');
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) throw new KrystalFieldError(path, value, 'is not finite');
    return parsed;
  }
  throw new KrystalFieldError(path, value, 'is not a number');
}

function requireNonNegativeNumber(value: unknown, path: string): number {
  const n = requireFiniteNumber(value, path);
  if (n < 0) throw new KrystalFieldError(path, value, 'is negative');
  return n;
}

function requireInteger(value: unknown, path: string): number {
  const n = requireFiniteNumber(value, path);
  if (!Number.isInteger(n)) throw new KrystalFieldError(path, value, 'is not an integer');
  if (!Number.isSafeInteger(n)) {
    throw new KrystalFieldError(path, value, 'exceeds safe integer range');
  }
  return n;
}

/** ERC-20 decimals: an integer in [0, 36]. Anything else is a data bug. */
function requireDecimals(value: unknown, path: string): number {
  const n = requireInteger(value, path);
  if (n < 0 || n > 36) throw new KrystalFieldError(path, value, 'is not a plausible decimals value');
  return n;
}

function requireAddress(value: unknown, path: string): Address {
  if (typeof value !== 'string') throw new KrystalFieldError(path, value, 'is not a string');
  if (!ADDRESS_PATTERN.test(value)) {
    throw new KrystalFieldError(path, value, 'is not a 20-byte hex address');
  }
  return value.toLowerCase() as Address;
}

function prop(source: Record<string, unknown>, key: string, path: string): unknown {
  const value = source[key];
  if (value === undefined) throw new KrystalFieldError(`${path}.${key}`, undefined, 'is missing');
  return value;
}

/**
 * Krystal expresses fee tiers as PERCENT (`feeTier: 0.05` for a 0.05% pool).
 * We store the **Uniswap on-chain fee unit** (`pool.fee()`), which is the unit
 * the frontend's `formatFeeTier` divides by 10000 to show a percent:
 *   feeTier 1 -> 10000 · 0.3 -> 3000 · 0.05 -> 500 · 0.01 -> 100
 *
 * NOT basis points — a 1% fee is 100 bps but on-chain unit 10000. The old
 * `* 100` produced 100 for a 1% pool, which the UI then rendered as "0.01%".
 * Rounded through integer micro-percent so 0.05 * 10000 stays exact.
 */
export function feePercentToUnits(percent: number): number {
  return Math.round(percent * 1e8) / 1e4;
}

/** Percent (234.15) -> annualized fraction (2.3415). */
export function percentToFraction(percent: number): number {
  return percent / 100;
}

export interface TokenRef {
  address: Address;
  symbol: string;
  decimals: number;
}

export interface PoolCandidate {
  address: Address;
  chainId: number;
  platform: string;
  feeTierBps: number;
  /** Kept alongside the bps value so the dashboard can show Krystal's own units. */
  feeTierPercent: number;
  token0: TokenRef;
  token1: TokenRef;
  tvlUsd: number;
  volume24hUsd: number;
  /** Fee APR as a fraction, not a percentage: 0.42 means 42%. */
  feeApr: number;
}

/** An entry the mapper refused to trust, with the reason. Never silently dropped. */
export interface SkippedEntry {
  index: number;
  identifier: string;
  reason: string;
}

export interface MappedPools {
  pools: PoolCandidate[];
  skipped: SkippedEntry[];
}

/**
 * Map one raw row from `/all/v2/lp_explorer/top_pools`. Pure — no network, no
 * clock. Throws `KrystalFieldError` on any field it cannot read unambiguously.
 *
 * Observed raw shape (chain 4663, real response):
 *   { chainId: 4663, protocol: "uniswapv3", poolAddress: "0x4c00…",
 *     feeTier: 1,                    // PERCENT, not bps
 *     tvlUsd: "4791.63651",          // string
 *     token0: { symbol, address, decimals: "18", usdPrice: "" },
 *     stat24h: { volumeUsd: "115603.48", feeUsd: "1156.03", apr: 8806.02 }, … }
 */
export function mapPoolCandidate(raw: unknown, path = 'pool'): PoolCandidate {
  const row = requireObject(raw, path);

  const chainId = requireInteger(prop(row, 'chainId', path), `${path}.chainId`);
  const platform = requireString(prop(row, 'protocol', path), `${path}.protocol`);

  // Uniswap V4 pools are identified by a 32-byte poolId, not a contract address
  // — `PoolCandidate.address` cannot represent one. Called out explicitly so
  // these surface as "structurally out of scope" rather than as dozens of
  // malformed-address warnings a reader would learn to ignore.
  const rawAddress = row.poolAddress;
  if (typeof rawAddress === 'string' && /^0x[0-9a-fA-F]{64}$/.test(rawAddress)) {
    throw new KrystalFieldError(
      `${path}.poolAddress`,
      rawAddress,
      `is a 32-byte pool id (${platform}), not a pool contract address; ` +
        'v4-style pools are out of scope for Phase 1',
    );
  }

  const address = requireAddress(rawAddress, `${path}.poolAddress`);

  const feeTierPercent = requireFiniteNumber(prop(row, 'feeTier', path), `${path}.feeTier`);
  if (feeTierPercent <= 0) {
    throw new KrystalFieldError(`${path}.feeTier`, feeTierPercent, 'is not a positive fee tier');
  }

  const tvlUsd = requireNonNegativeNumber(prop(row, 'tvlUsd', path), `${path}.tvlUsd`);

  const stat24h = requireObject(prop(row, 'stat24h', path), `${path}.stat24h`);
  const volume24hUsd = requireNonNegativeNumber(
    prop(stat24h, 'volumeUsd', `${path}.stat24h`),
    `${path}.stat24h.volumeUsd`,
  );
  const aprPercent = requireFiniteNumber(
    prop(stat24h, 'apr', `${path}.stat24h`),
    `${path}.stat24h.apr`,
  );

  return {
    address,
    chainId,
    platform,
    feeTierBps: feePercentToUnits(feeTierPercent),
    feeTierPercent,
    token0: mapTokenRef(prop(row, 'token0', path), `${path}.token0`),
    token1: mapTokenRef(prop(row, 'token1', path), `${path}.token1`),
    tvlUsd,
    volume24hUsd,
    feeApr: percentToFraction(aprPercent),
  };
}

function mapTokenRef(raw: unknown, path: string): TokenRef {
  const token = requireObject(raw, path);
  return {
    address: requireAddress(prop(token, 'address', path), `${path}.address`),
    symbol: requireString(prop(token, 'symbol', path), `${path}.symbol`),
    decimals: requireDecimals(prop(token, 'decimals', path), `${path}.decimals`),
  };
}

/**
 * Map a whole `top_pools` payload.
 *
 * A malformed ROW is skipped with a recorded reason rather than aborting the
 * batch — one junk listing on a four-week-old chain must not blind the operator
 * to every other pool. A malformed ENVELOPE still throws, because that means we
 * are not looking at the response we think we are.
 */
export function mapTopPools(raw: unknown): MappedPools {
  const envelope = requireObject(raw, 'topPools');
  const rows = requireArray(prop(envelope, 'result', 'topPools'), 'topPools.result');

  const pools: PoolCandidate[] = [];
  const skipped: SkippedEntry[] = [];

  rows.forEach((row, index) => {
    try {
      pools.push(mapPoolCandidate(row, `topPools.result[${index}]`));
    } catch (error) {
      skipped.push({
        index,
        identifier: readIdentifier(row, 'poolAddress'),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return { pools, skipped };
}

function readIdentifier(row: unknown, key: string): string {
  if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
    const value = (row as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '<unknown>';
}

/** Filters applied client-side: Krystal accepts these params but ignores them. */
export interface CandidateFilters {
  minTvlUsd: number;
  min24hVolumeUsd: number;
  limit: number;
}

/**
 * Apply the surfacing filters. This produces a SHORTLIST for a human to review
 * — it admits nothing (plan §9.2). `maxIlRiskScore` is deliberately not applied:
 * there is no IL risk model yet, and inventing one here would silently hide
 * pools on a number nobody chose.
 */
export function filterCandidates(
  pools: readonly PoolCandidate[],
  chainId: number,
  filters: CandidateFilters,
): PoolCandidate[] {
  return pools
    .filter(
      (pool) =>
        pool.chainId === chainId &&
        pool.platform === KRYSTAL_PLATFORM &&
        pool.tvlUsd >= filters.minTvlUsd &&
        pool.volume24hUsd >= filters.min24hVolumeUsd,
    )
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, filters.limit);
}

/**
 * GET a Krystal endpoint as JSON.
 *
 * `label` names the operation in every error message, so a failure says which
 * call broke rather than just "Krystal failed".
 *
 * The query is built OUTSIDE the try: `buildKrystalQuery` throws
 * `KrystalWafError` for the zero-address tripwire, and that is a bug in our
 * request, not a transport failure — it must not be re-wrapped as a
 * `KrystalRequestError` and reported as "Krystal is down".
 */
async function fetchKrystalJson(
  path: string,
  params: Record<string, string | number | undefined>,
  label: string,
): Promise<unknown> {
  const query = buildKrystalQuery(params);
  const url = `${KRYSTAL_BASE_URL}${path}?${query}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KRYSTAL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });

    // Cloudflare's block page is HTML with a 403. Report the real cause rather
    // than letting response.json() surface it as a parse error.
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || !contentType.includes('json')) {
      throw new KrystalRequestError(
        `${label} failed (HTTP ${response.status}, content-type "${contentType}")`,
        response.status,
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof KrystalRequestError) throw error;
    if ((error as Error)?.name === 'AbortError') {
      throw new KrystalRequestError(`${label} timed out after ${KRYSTAL_TIMEOUT_MS}ms`, null);
    }
    throw new KrystalRequestError(
      `${label} failed: ${(error as Error)?.message ?? 'unknown error'}`,
      null,
    );
  } finally {
    clearTimeout(timer);
  }
}

function fetchTopPools(chainId: number, limit: number): Promise<unknown> {
  return fetchKrystalJson(TOP_POOLS_PATH, { chainId, limit }, 'Krystal pool discovery');
}

// ===========================================================================
// User LP positions — DISPLAY ONLY (plan §3, "Position state")
// ===========================================================================
//
// ####################################################################
// #  THE OUTPUT OF THIS SECTION MUST NEVER FEED A SPEND DECISION.    #
// ####################################################################
//
// Everything below exists to render a table for a human. It is NOT the data
// path the automation uses, and it deliberately cannot become one.
//
// WHY. Krystal returns no tick data on any endpoint. Its `status` and
// `pool.price` are cached/aggregated quotes, and when measured against the
// pools' own `slot0()` on 2026-07-26 the tick derived from `pool.price` was off
// by up to **66 ticks**. That is negligible for a "roughly here" price label and
// fatal for `rebalanceTrigger.rangeExitPercent`, which is precisely the question
// "has this position left its range?". So `lp-automation` refuses to decide from
// these fields: `mapLpPosition` there REQUIRES an RPC-supplied `currentTick` and
// skips any position lacking one. See the header of
// `lp-automation/src/ingest/krystal/positions.ts`.
//
// HOW THAT IS ENFORCED HERE, rather than just documented:
//
//   * `LpPositionView` carries NO `tickLower`, `tickUpper` or `currentTick`.
//     Their absence is the enforcement — a rule evaluator physically cannot be
//     written against this type without first going and getting real tick data.
//   * The type is named `LpPositionView`, never `LpPosition`, so a decision-grade
//     value and a display value cannot be confused at a call site.
//   * `lp-automation`'s `mapUserPositions` is NOT imported or replicated. It
//     requires the tick context this endpoint does not have, and its output is
//     decision-grade. The mapper below is a separate, lighter one that reads
//     only fields safe to look at.
//
// `status`, `currentPrice`, `minPrice` and `maxPrice` are passed through as
// Krystal reported them. They are honest enough to LOOK at and not accurate
// enough to ACT on.

export const USER_POSITIONS_PATH = '/all/v1/lp/userPositions';

export type LpPositionViewStatus = 'in_range' | 'out_of_range' | 'closed';

/** Display shape of a token in `LpPositionView`. Addresses are lowercased. */
export interface TokenView {
  symbol: string;
  address: string;
  decimals: number;
}

/**
 * A position as SHOWN IN THE DASHBOARD. Display DTO — see the section header.
 * Not `LpPosition`; not usable as an input to any spend decision.
 */
export interface LpPositionView {
  tokenId: string;
  poolAddress: string;
  platform: string;
  feeTierBps: number;
  token0: TokenView;
  token1: TokenView;
  status: LpPositionViewStatus;
  valueUsd: number;
  unclaimedFeesUsd: number;
  /** Krystal's human-readable range bounds, as reported. */
  minPrice: number;
  maxPrice: number;
  /** Krystal's cached pool quote — indicative, drifts from spot. Never a tick. */
  currentPrice: number;
  /** Pool address is on the active policy's `allowedPools`. */
  isAllowlisted: boolean;
  /** Allowlisted and still open — i.e. the automation would consider it. */
  managedByAutomation: boolean;
}

export interface MappedPositionViews {
  positions: LpPositionView[];
  skipped: SkippedEntry[];
}

/** Lineage-keyed lifetime PnL — derived from the worker audit log. */
export type { LineageLink, LineagePnl };

export interface LpPositionsPnlPayload {
  /** Keyed by `positionKey` (`{pool}:{tokenId}`) — one entry per grid row. */
  pnlByLineage: Record<string, LineagePnl>;
  /** Explicit mint→burn links from rebalance audit entries. */
  lineageLinks: LineageLink[];
  /** False when LP_AUDIT_LOG_PATH is unset or the file does not exist yet. */
  auditLogAvailable: boolean;
}

async function loadLineagePnl(positions: LpPositionView[]): Promise<LpPositionsPnlPayload> {
  const auditPath = auditLogPathFromEnv();
  if (!auditPath) {
    return { pnlByLineage: {}, lineageLinks: [], auditLogAvailable: false };
  }

  const { records, available } = await readAuditLog(auditPath);
  const lineageLinks = extractLineageLinks(records);
  const inputs = buildLineagePnlInputs(positions, lineageLinks);
  const rows = deriveAllLineagePnl(records, inputs, {
    fallbackNativeTokenUsd: nativeTokenUsdFromEnv(),
  });
  const pnlByLineage: Record<string, LineagePnl> = {};
  for (const row of rows) {
    pnlByLineage[row.lineageKey] = row;
  }
  return { pnlByLineage, lineageLinks, auditLogAvailable: available };
}

export interface PositionViewContext {
  chainId: number;
  /** Active policy's allowlist, lowercased. Empty when no policy exists yet. */
  allowedPools: ReadonlySet<string>;
}

/** Krystal's status strings, observed live: IN_RANGE, OUT_RANGE, CLOSED. */
export function mapPositionViewStatus(raw: unknown, path: string): LpPositionViewStatus {
  const status = requireString(raw, path).toUpperCase();
  switch (status) {
    case 'IN_RANGE':
      return 'in_range';
    case 'OUT_RANGE':
    case 'OUT_OF_RANGE':
      return 'out_of_range';
    case 'CLOSED':
      return 'closed';
    default:
      throw new KrystalFieldError(path, raw, 'is not a recognised position status');
  }
}

/**
 * Sum the USD quotes of a Krystal token-amount array (`feePending`).
 *
 * An entry whose `quotes.usd.value` is unreadable throws rather than
 * contributing 0. Displaying "$0.00 unclaimed" for fees we simply failed to read
 * is a lie the operator cannot detect; a skipped row with a reason is one they
 * can.
 */
export function sumUsdQuotes(raw: unknown, path: string): number {
  const entries = requireArray(raw, path);
  let total = 0;
  entries.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const row = requireObject(entry, entryPath);
    const quotes = requireObject(prop(row, 'quotes', entryPath), `${entryPath}.quotes`);
    const usd = requireObject(prop(quotes, 'usd', `${entryPath}.quotes`), `${entryPath}.quotes.usd`);
    total += requireNonNegativeNumber(
      prop(usd, 'value', `${entryPath}.quotes.usd`),
      `${entryPath}.quotes.usd.value`,
    );
  });
  return total;
}

/**
 * Read the `pool` object embedded in a position row.
 *
 * DIFFERENT SHAPE from `/all/v2/lp_explorer/top_pools` — `projectKey` not
 * `protocol`, `fees: [1, 0]` not `feeTier`, numeric `tvl` not string `tvlUsd`,
 * and no 24h volume at all. `mapPoolCandidate` cannot read it, which is why this
 * is a separate reader rather than a reuse.
 *
 *   { poolAddress, projectKey: "uniswapv3", projectAddress, tickSpacing: 200,
 *     fees: [1, 0],          // PERCENT, same units as v2 `feeTier`
 *     tvl: 134724.36,        // number, not a string
 *     price: 1437266.38,     // cached quote — display only
 *     tokenAmounts: [ { token: { address, symbol, decimals } }, ... ] }
 */
function mapEmbeddedPoolView(
  raw: unknown,
  path: string,
): { address: string; platform: string; feeTierBps: number; token0: TokenView; token1: TokenView; currentPrice: number } {
  const pool = requireObject(raw, path);

  const address = requireAddress(prop(pool, 'poolAddress', path), `${path}.poolAddress`);
  const platform = requireString(prop(pool, 'projectKey', path), `${path}.projectKey`);

  const tokenAmounts = requireArray(prop(pool, 'tokenAmounts', path), `${path}.tokenAmounts`);
  if (tokenAmounts.length < 2) {
    throw new KrystalFieldError(
      `${path}.tokenAmounts`,
      tokenAmounts.length,
      'has fewer than 2 tokens',
    );
  }

  const fees = requireArray(prop(pool, 'fees', path), `${path}.fees`);
  if (fees.length === 0) throw new KrystalFieldError(`${path}.fees`, fees, 'is empty');
  const feeTierPercent = requireFiniteNumber(fees[0], `${path}.fees[0]`);
  if (feeTierPercent <= 0) {
    throw new KrystalFieldError(`${path}.fees[0]`, feeTierPercent, 'is not a positive fee tier');
  }

  return {
    address,
    platform,
    // Percent -> bps, same conversion as the discovery endpoint: 0.05 -> 5.
    feeTierBps: feePercentToUnits(feeTierPercent),
    token0: mapEmbeddedTokenView(tokenAmounts[0], `${path}.tokenAmounts[0]`),
    token1: mapEmbeddedTokenView(tokenAmounts[1], `${path}.tokenAmounts[1]`),
    currentPrice: requireFiniteNumber(prop(pool, 'price', path), `${path}.price`),
  };
}

function mapEmbeddedTokenView(raw: unknown, path: string): TokenView {
  const entry = requireObject(raw, path);
  const token = requireObject(prop(entry, 'token', path), `${path}.token`);
  return {
    symbol: requireString(prop(token, 'symbol', `${path}.token`), `${path}.token.symbol`),
    address: requireAddress(prop(token, 'address', `${path}.token`), `${path}.token.address`),
    decimals: requireDecimals(prop(token, 'decimals', `${path}.token`), `${path}.token.decimals`),
  };
}

/**
 * Map one raw position row to its DISPLAY shape. Pure — no network, no clock.
 * Throws `KrystalFieldError` on anything it cannot read unambiguously, so a
 * malformed row becomes a reported skip rather than a row of NaNs.
 *
 * DISPLAY ONLY — see the section header. Emits no tick data by construction.
 */
export function mapLpPositionView(
  raw: unknown,
  context: PositionViewContext,
  path = 'position',
): LpPositionView {
  const row = requireObject(raw, path);

  const chainId = requireInteger(prop(row, 'chainId', path), `${path}.chainId`);
  if (chainId !== context.chainId) {
    throw new KrystalFieldError(
      `${path}.chainId`,
      chainId,
      `is not the requested chain ${context.chainId}`,
    );
  }

  const tokenId = requireString(prop(row, 'tokenId', path), `${path}.tokenId`);
  const pool = mapEmbeddedPoolView(prop(row, 'pool', path), `${path}.pool`);

  const status = mapPositionViewStatus(prop(row, 'status', path), `${path}.status`);
  const isAllowlisted = context.allowedPools.has(pool.address);

  return {
    tokenId,
    poolAddress: pool.address,
    platform: pool.platform,
    feeTierBps: pool.feeTierBps,
    token0: pool.token0,
    token1: pool.token1,
    status,
    valueUsd: requireNonNegativeNumber(
      prop(row, 'currentPositionValue', path),
      `${path}.currentPositionValue`,
    ),
    unclaimedFeesUsd: sumUsdQuotes(prop(row, 'feePending', path), `${path}.feePending`),
    minPrice: requireFiniteNumber(prop(row, 'minPrice', path), `${path}.minPrice`),
    maxPrice: requireFiniteNumber(prop(row, 'maxPrice', path), `${path}.maxPrice`),
    currentPrice: pool.currentPrice,
    isAllowlisted,
    // A closed position is history: the automation has nothing left to manage,
    // whatever the allowlist says. Computed here so the dashboard cannot get the
    // rule subtly wrong (e.g. by showing "managed" next to a withdrawn NFT).
    managedByAutomation: isAllowlisted && status !== 'closed',
  };
}

/**
 * Map a whole `/all/v1/lp/userPositions` payload to display rows. Pure.
 *
 * A malformed ROW is skipped with a reason; a malformed ENVELOPE throws, because
 * that means we are not looking at the response we think we are.
 */
export function mapUserPositionViews(
  raw: unknown,
  context: PositionViewContext,
): MappedPositionViews {
  const envelope = requireObject(raw, 'userPositions');

  // A wallet with no LP positions gets `positions` OMITTED ENTIRELY, not an
  // empty array — verified live against a funded Safe holding zero positions,
  // which returned `{ statsByChain: { "4663": { openPositionCount: 0, … } } }`
  // and no `positions` key at all. Treating that as malformed would make a
  // brand-new, correctly-configured Safe look broken.
  //
  // But "absent" must not become a blanket "no positions" either — that would
  // turn a genuinely broken response into a confident, empty table.
  // `statsByChain` is the discriminator: its presence proves we received a
  // well-formed envelope that simply has nothing in it. Same reasoning as
  // `mapUserPositions` in lp-automation; both keys are read directly rather than
  // via `prop`, which throws on absence — absence is the case being told apart.
  const rawRows = envelope['positions'];
  const isEmptyButValid = rawRows === undefined && envelope['statsByChain'] !== undefined;
  const rows = isEmptyButValid
    ? []
    : requireArray(prop(envelope, 'positions', 'userPositions'), 'userPositions.positions');

  const positions: LpPositionView[] = [];
  const skipped: SkippedEntry[] = [];

  rows.forEach((row, index) => {
    try {
      positions.push(mapLpPositionView(row, context, `userPositions.positions[${index}]`));
    } catch (error) {
      skipped.push({
        index,
        identifier: readIdentifier(row, 'tokenId'),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return { positions, skipped };
}

/**
 * Fetch a Safe's positions on `chainId`.
 *
 * `positionStatus: 'all'` — closed positions are returned too, and the DTO
 * carries `status` so the dashboard can filter. Asking for only open ones would
 * make `status: 'closed'` unreachable and hide a just-withdrawn position the
 * operator is probably looking for.
 */
function fetchUserPositionsRaw(chainId: number, safeAddress: string): Promise<unknown> {
  return fetchKrystalJson(
    USER_POSITIONS_PATH,
    { chainIds: chainId, addresses: safeAddress, positionStatus: 'all' },
    'Krystal position lookup',
  );
}

// ---------------------------------------------------------------------------
// Deployment settings — Safe + module address
// ---------------------------------------------------------------------------
//
// Mutable, unversioned, one row per user. See the migration
// `20260726170000_lp_automation_settings.sql` for why this is not two more
// columns on the append-only policy table.

export interface LpSettings {
  safeAddress: string | null;
  moduleAddress: string | null;
  updatedAt: string | null;
}

/** A field the client actually sent. `null` clears it; absent leaves it alone. */
export type SettingsPatch = Partial<Record<'safeAddress' | 'moduleAddress', string | null>>;

export interface SettingsValidationResult {
  valid: boolean;
  issues: PolicyValidationIssue[];
  /** Normalized, lowercased patch. Only meaningful when `valid`. */
  patch: SettingsPatch;
}

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

/**
 * Validate a `PUT /settings` body. Never throws; accumulates issues like
 * `validatePolicyInput`, so the form can mark every bad field at once.
 *
 * PATCH SEMANTICS, deliberately: an OMITTED key is left unchanged, an explicit
 * `null` clears the field. That distinction is why the request type is
 * `{ safeAddress?: string | null }` rather than plain optional — if omission
 * meant "clear", `| null` would be redundant, and a dashboard pane that only
 * edits the Safe address would silently wipe the module address every save.
 */
export function validateSettingsInput(input: unknown): SettingsValidationResult {
  const issues: PolicyValidationIssue[] = [];

  if (!isRecord(input)) {
    return {
      valid: false,
      issues: [{ field: '', message: 'settings must be an object' }],
      patch: {},
    };
  }

  const patch: SettingsPatch = {};
  for (const field of ['safeAddress', 'moduleAddress'] as const) {
    if (!(field in input) || input[field] === undefined) continue;

    const value = input[field];
    if (value === null) {
      patch[field] = null;
      continue;
    }
    if (typeof value !== 'string') {
      issues.push({ field, message: 'must be a 0x-prefixed 20-byte hex address, or null' });
      continue;
    }

    const trimmed = value.trim();
    // An empty string is what a cleared form input sends. Read it as "clear"
    // rather than rejecting it, so the operator can actually unset the field.
    if (trimmed.length === 0) {
      patch[field] = null;
      continue;
    }
    if (!ADDRESS_PATTERN.test(trimmed)) {
      issues.push({ field, message: 'must be a 0x-prefixed 20-byte hex address' });
      continue;
    }

    const lower = trimmed.toLowerCase();
    // The zero address is never a real Safe or module, and stored here it would
    // additionally poison every Krystal call: Cloudflare answers any query
    // string containing it with a 403 HTML block page (plan §3). Refuse it at
    // the point of entry rather than at the point of confusing failure.
    if (lower === ZERO_ADDRESS) {
      issues.push({
        field,
        message:
          'must not be the all-zero address (it is not a real deployment, and Krystal’s WAF 403s any request containing it)',
      });
      continue;
    }

    patch[field] = lower;
  }

  return { valid: issues.length === 0, issues, patch };
}

// ---------------------------------------------------------------------------
// Manual command queue — the dashboard's only way to ASK for an action
// ---------------------------------------------------------------------------
//
// See `supabase/migrations/20260726180000_lp_automation_commands.sql` for the
// architectural reasoning. The short version, because it governs everything in
// this section:
//
//   THIS ENDPOINT ENQUEUES AN INTENT. IT DOES NOT PERFORM AN ACTION.
//
// The backend holds no key and the signer process has no inbound surface, so a
// manual compound is a row the worker polls for — and when the worker picks it
// up it runs the identical `ActionExecutor` ladder an automatic action runs:
// quarantine check, allowlist re-checked at execution time, dry run, audit
// intent before broadcast, per-position lock, the on-chain module's caps, and
// the `LP_ARMED` gate. A queued command is a TRIGGER, never a new authority.
//
// The validation below is therefore not a security boundary — the worker's is.
// It exists so the operator gets an immediate, legible refusal instead of a row
// that sits `pending` for a few seconds and then comes back `failed` for a
// reason the dashboard could have told them straight away.

export const LP_COMMAND_ACTIONS = [
  'compound',
  'rebalance',
  'exit',
  'compound_rebalance',
  'enter',
  'increase',
] as const;
export type LpCommandAction = (typeof LP_COMMAND_ACTIONS)[number];

// The actions that operate on an EXISTING position — everything except `enter`.
// These carry a tokenId and go through `POST /positions/:tokenId/actions`. An
// `enter` opens a brand-new position: it has no tokenId and a different body
// shape (pool + input token + amount + range), so it has its own route
// (`POST /enter`) and its own validator. `validateCommandInput` below checks the
// tokenId-actions against this narrower set, not against `LP_COMMAND_ACTIONS`.
export const POSITION_COMMAND_ACTIONS = [
  'compound',
  'rebalance',
  'exit',
  'compound_rebalance',
] as const satisfies readonly LpCommandAction[];

/** The range strategy an enter re-centers around; ticks are computed worker-side. */
export const LP_RANGE_STRATEGIES = ['narrow', 'wide', 'full'] as const;
export type LpRangeStrategy = (typeof LP_RANGE_STRATEGIES)[number];

/** pending -> claimed -> done | failed. Only the worker moves a command along. */
export type LpCommandStatus = 'pending' | 'claimed' | 'done' | 'failed';

/** A command is OPEN while it may still execute — it blocks a second one. */
const OPEN_COMMAND_STATUSES: readonly LpCommandStatus[] = ['pending', 'claimed'];

export interface LpCommand {
  id: string;
  /**
   * Null for an `enter` — the position does not exist yet, so there is no NFT id
   * to carry. Every other action operates on an existing position and has one.
   */
  tokenId: string | null;
  poolAddress: string;
  action: LpCommandAction;
  status: LpCommandStatus;
  requestedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  txHash: string | null;
  error: string | null;
}

export interface CommandRequest {
  tokenId: string;
  action: LpCommandAction;
  /** Lowercased. Re-checked by the worker against the live position. */
  poolAddress: string;
}

export interface CommandValidationResult {
  valid: boolean;
  issues: PolicyValidationIssue[];
  /** Normalized request. Only meaningful when `valid`. */
  request: CommandRequest | null;
}

/**
 * Uniswap V3 position NFT ids are positive integers with no leading zero.
 * Matched as text because that is what they are everywhere else in this system:
 * an identifier that happens to look like a number, only ever compared for
 * equality. Bounded at 78 digits — a uint256 cannot be longer — so a pathological
 * path segment cannot become a pathological database write.
 */
const TOKEN_ID_PATTERN = /^[1-9][0-9]{0,77}$/;

/**
 * Validate a `POST /positions/:tokenId/actions` request. Never throws;
 * accumulates issues like the other validators so the UI can mark every bad
 * field at once.
 *
 * The pool address is normalized (trimmed, lowercased) rather than merely
 * accepted, because the allowlist check immediately downstream — and the
 * worker's re-check at execution time — are plain string equality against
 * lowercase addresses. A checksummed address from a wallet UI must not read as
 * "not allowlisted" purely because of its capitalisation.
 */
export function validateCommandInput(tokenId: unknown, input: unknown): CommandValidationResult {
  const issues: PolicyValidationIssue[] = [];

  if (typeof tokenId !== 'string' || !TOKEN_ID_PATTERN.test(tokenId)) {
    issues.push({ field: 'tokenId', message: 'must be a positive integer position id' });
  }

  if (!isRecord(input)) {
    return {
      valid: false,
      issues: [...issues, { field: '', message: 'the request body must be an object' }],
      request: null,
    };
  }

  const action = input.action;
  // `enter` is intentionally excluded: it has no tokenId and cannot travel this
  // route (see POSITION_COMMAND_ACTIONS above / `POST /enter` below).
  if (
    typeof action !== 'string' ||
    !(POSITION_COMMAND_ACTIONS as readonly string[]).includes(action)
  ) {
    issues.push({
      field: 'action',
      message: `must be one of ${POSITION_COMMAND_ACTIONS.join(', ')}`,
    });
  }

  let poolAddress: string | null = null;
  if (typeof input.poolAddress !== 'string') {
    issues.push({ field: 'poolAddress', message: 'must be a 0x-prefixed 20-byte hex address' });
  } else {
    const trimmed = input.poolAddress.trim();
    if (!ADDRESS_PATTERN.test(trimmed)) {
      issues.push({ field: 'poolAddress', message: 'must be a 0x-prefixed 20-byte hex address' });
    } else if (trimmed.toLowerCase() === ZERO_ADDRESS) {
      // Same reasoning as the settings validator: never a real pool, and it
      // poisons every Krystal call it reaches (plan §3).
      issues.push({
        field: 'poolAddress',
        message: 'must not be the all-zero address',
      });
    } else {
      poolAddress = trimmed.toLowerCase();
    }
  }

  if (issues.length > 0) return { valid: false, issues, request: null };

  return {
    valid: true,
    issues,
    request: {
      tokenId: tokenId as string,
      action: action as LpCommandAction,
      poolAddress: poolAddress as string,
    },
  };
}

// ---------------------------------------------------------------------------
// Enter (Zap In) — open a BRAND-NEW position
// ---------------------------------------------------------------------------
//
// An enter is a command with a different shape: no tokenId (the position does
// not exist yet), and instead a pool, an input token, an amount and a range
// strategy. It rides the SAME queue as the tokenId actions — one worker poll,
// one History list — so `action='enter'` lands in `lp_automation_commands` with
// `token_id=null` and the enter-only columns filled. See LP_DASHBOARD_PLAN.md §5
// and the `20260727150000_lp_command_enter.sql` migration, whose CHECKs are the
// real boundary — the validation here just gives the operator an immediate,
// legible refusal instead of a row that fails a few seconds later.

/** Base units, as a positive-integer decimal string. Never a float, never zero. */
const AMOUNT_IN_PATTERN = /^[1-9][0-9]*$/;

/** Our slippage ceiling. Krystal expects a FRACTION, so 0.05 is 5%. */
const MAX_SWAP_SLIPPAGE = 0.05;

export interface EnterCommandRequest {
  /** Lowercased. Re-checked by the worker against the saved allowlist. */
  poolAddress: string;
  /** Lowercased. One of the pool's two tokens (the worker enforces which). */
  tokenInAddress: string;
  /** Base-units integer string. The worker resolves decimals; we only shape-check. */
  amountIn: string;
  /** Null lets the worker fall back to the policy default. */
  rangeStrategy: LpRangeStrategy | null;
  /** Null lets the worker fall back to its default. Fraction in (0, 0.05]. */
  swapSlippage: number | null;
}

export interface EnterValidationResult {
  valid: boolean;
  issues: PolicyValidationIssue[];
  /** Normalized request. Only meaningful when `valid`. */
  request: EnterCommandRequest | null;
}

/**
 * Validate a `POST /enter` request. Never throws; accumulates issues like the
 * other validators so the form can mark every bad field at once.
 *
 * A SEPARATE validator from `validateCommandInput` on purpose: the two command
 * kinds have different bodies (an enter has no tokenId and carries the pool,
 * token, amount and range instead), and welding them into one branchy validator
 * would only make each harder to read. Addresses are normalized (trimmed,
 * lowercased) so the downstream allowlist check — and the DB's lowercase-only
 * regex CHECK — see plain equality, exactly as the tokenId-actions validator does.
 */
export function validateEnterInput(input: unknown): EnterValidationResult {
  if (!isRecord(input)) {
    return {
      valid: false,
      issues: [{ field: '', message: 'the request body must be an object' }],
      request: null,
    };
  }

  const issues: PolicyValidationIssue[] = [];

  // Both addresses go through the same shape: a well-formed 20-byte hex address
  // that is not the all-zero address (never a real pool or token, and it 403s
  // every Krystal call it reaches — same reasoning as the settings validator).
  const normalizeAddress = (
    raw: unknown,
    field: 'poolAddress' | 'tokenInAddress',
  ): string | null => {
    if (typeof raw !== 'string') {
      issues.push({ field, message: 'must be a 0x-prefixed 20-byte hex address' });
      return null;
    }
    const trimmed = raw.trim();
    if (!ADDRESS_PATTERN.test(trimmed)) {
      issues.push({ field, message: 'must be a 0x-prefixed 20-byte hex address' });
      return null;
    }
    if (trimmed.toLowerCase() === ZERO_ADDRESS) {
      issues.push({ field, message: 'must not be the all-zero address' });
      return null;
    }
    return trimmed.toLowerCase();
  };

  const poolAddress = normalizeAddress(input.poolAddress, 'poolAddress');
  const tokenInAddress = normalizeAddress(input.tokenInAddress, 'tokenInAddress');

  // Amount is a base-units integer STRING, deliberately not a number: a JS number
  // cannot carry a uint256 without losing precision, and a float here would be a
  // wrong amount on-chain, not a rejected request. The DB CHECK matches this.
  let amountIn: string | null = null;
  if (typeof input.amountIn !== 'string' || !AMOUNT_IN_PATTERN.test(input.amountIn)) {
    issues.push({
      field: 'amountIn',
      message: 'must be a positive-integer base-units string (no decimal point, no leading zero)',
    });
  } else {
    amountIn = input.amountIn;
  }

  // Optional. Omitted -> null -> the worker uses the policy default range.
  let rangeStrategy: LpRangeStrategy | null = null;
  if (input.rangeStrategy !== undefined && input.rangeStrategy !== null) {
    if (
      typeof input.rangeStrategy !== 'string' ||
      !(LP_RANGE_STRATEGIES as readonly string[]).includes(input.rangeStrategy)
    ) {
      issues.push({
        field: 'rangeStrategy',
        message: `must be one of ${LP_RANGE_STRATEGIES.join(', ')}`,
      });
    } else {
      rangeStrategy = input.rangeStrategy as LpRangeStrategy;
    }
  }

  // Optional. Omitted -> null -> the worker uses its default slippage. When
  // present it must be a finite fraction in (0, 0.05]; `Number.isFinite` first so
  // a blank or garbage value fails closed rather than sailing through as NaN.
  let swapSlippage: number | null = null;
  if (input.swapSlippage !== undefined && input.swapSlippage !== null) {
    const value = input.swapSlippage;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value > MAX_SWAP_SLIPPAGE
    ) {
      issues.push({
        field: 'swapSlippage',
        message: `must be a fraction greater than 0 and at most ${MAX_SWAP_SLIPPAGE} (5%)`,
      });
    } else {
      swapSlippage = value;
    }
  }

  if (issues.length > 0) return { valid: false, issues, request: null };

  return {
    valid: true,
    issues,
    request: {
      poolAddress: poolAddress as string,
      tokenInAddress: tokenInAddress as string,
      amountIn: amountIn as string,
      rangeStrategy,
      swapSlippage,
    },
  };
}

// ---------------------------------------------------------------------------
// Increase — add liquidity to an EXISTING position
// ---------------------------------------------------------------------------

export interface IncreaseCommandRequest {
  tokenId: string;
  poolAddress: string;
  tokenInAddress: string;
  amountIn: string;
  swapSlippage: number | null;
}

export interface IncreaseValidationResult {
  valid: boolean;
  issues: PolicyValidationIssue[];
  request: IncreaseCommandRequest | null;
}

/**
 * Validate `POST /positions/:tokenId/increase`. Mirrors enter amount rules;
 * the position id comes from the path.
 */
export function validateIncreaseInput(
  tokenId: unknown,
  input: unknown,
): IncreaseValidationResult {
  const issues: PolicyValidationIssue[] = [];

  if (typeof tokenId !== 'string' || !TOKEN_ID_PATTERN.test(tokenId)) {
    issues.push({ field: 'tokenId', message: 'must be a positive integer position id' });
  }

  if (!isRecord(input)) {
    return {
      valid: false,
      issues: [...issues, { field: '', message: 'the request body must be an object' }],
      request: null,
    };
  }

  const normalizeAddress = (raw: unknown, field: 'poolAddress' | 'tokenInAddress'): string | null => {
    if (typeof raw !== 'string') {
      issues.push({ field, message: 'must be a 0x-prefixed 20-byte hex address' });
      return null;
    }
    const trimmed = raw.trim();
    if (!ADDRESS_PATTERN.test(trimmed)) {
      issues.push({ field, message: 'must be a 0x-prefixed 20-byte hex address' });
      return null;
    }
    if (trimmed.toLowerCase() === ZERO_ADDRESS) {
      issues.push({ field, message: 'must not be the all-zero address' });
      return null;
    }
    return trimmed.toLowerCase();
  };

  const poolAddress = normalizeAddress(input.poolAddress, 'poolAddress');
  const tokenInAddress = normalizeAddress(input.tokenInAddress, 'tokenInAddress');

  let amountIn: string | null = null;
  if (typeof input.amountIn !== 'string' || !AMOUNT_IN_PATTERN.test(input.amountIn)) {
    issues.push({
      field: 'amountIn',
      message: 'must be a positive-integer base-units string (no decimal point, no leading zero)',
    });
  } else {
    amountIn = input.amountIn;
  }

  let swapSlippage: number | null = null;
  if (input.swapSlippage !== undefined && input.swapSlippage !== null) {
    const value = input.swapSlippage;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value > MAX_SWAP_SLIPPAGE
    ) {
      issues.push({
        field: 'swapSlippage',
        message: `must be a fraction greater than 0 and at most ${MAX_SWAP_SLIPPAGE} (5%)`,
      });
    } else {
      swapSlippage = value;
    }
  }

  if (issues.length > 0) return { valid: false, issues, request: null };

  return {
    valid: true,
    issues,
    request: {
      tokenId: tokenId as string,
      poolAddress: poolAddress as string,
      tokenInAddress: tokenInAddress as string,
      amountIn: amountIn as string,
      swapSlippage,
    },
  };
}

/**
 * Is this pool on the active policy's allowlist?
 *
 * Enqueuing a command for a pool the worker will refuse is work nobody asked
 * for: it costs a round trip, a row, and — because at most one command may be
 * open per position — the position's only queue slot until the worker gets to
 * it and fails it. Refusing here turns that into an immediate, explicable "no".
 *
 * This is a convenience, NOT the gate. The gate is `checkGuards` in the worker's
 * `ActionExecutor`, which re-reads the allowlist at the moment of execution — a
 * pool removed from the policy between enqueue and execution must still stop the
 * broadcast, and only a check at execution time can see that.
 */
export function isPoolOnAllowlist(policy: AutomationPolicy | null, poolAddress: string): boolean {
  if (policy === null) return false;
  return policy.allowedPools.includes(poolAddress.toLowerCase() as Address);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
//
// MODE SPLIT, per CLAUDE.md: hosted writes to Supabase (service role, RLS-scoped
// by an explicit user_id filter on every query), local writes a JSON file under
// the data dir. The generic `StorageProvider` interface is not extended here
// because these tables are hosted-only in nature and single-feature — the same
// call the fomo_* tables made (`backend/src/fomo/store.ts`). If LP grows more
// tables, promoting this to a repo under `storage/` is the right next step.

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DATA_DIR = join(__dirname, '../../../data');
const DATA_DIR = process.env.OCT_DATA_DIR || process.env.TRENCHCORD_DATA_DIR || BUNDLED_DATA_DIR;
const LOCAL_POLICY_PATH = join(DATA_DIR, 'lp-policies.json');
const LOCAL_SETTINGS_PATH = join(DATA_DIR, 'lp-settings.json');
const LOCAL_COMMANDS_PATH = join(DATA_DIR, 'lp-commands.json');

const POLICY_TABLE = 'lp_automation_policies';
const SETTINGS_TABLE = 'lp_automation_settings';
const COMMANDS_TABLE = 'lp_automation_commands';

let _client: SupabaseClient | null = null;

function getServiceClient(): SupabaseClient | null {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL?.trim();
  const key = (process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  if (!url || !key) return null;
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

export interface PolicyRow {
  version: number;
  is_active: boolean;
  chain: string;
  max_position_size_usd: number | string;
  daily_spend_cap_usd: number | string;
  allowed_pools: string[] | null;
  min_tvl_usd: number | string;
  min_24h_volume_usd: number | string;
  max_il_risk_score: number | string;
  min_fees_vs_gas_ratio: number | string;
  max_interval_hours: number | string;
  range_exit_percent: number | string;
  range_strategy: string;
  auto_compound: boolean;
  auto_rebalance: boolean;
  min_efficiency_delta_percent: number | string;
  sustained_duration_minutes: number | string;
  created_at: string;
}

/**
 * Postgres `numeric` can arrive as a JSON string depending on the driver, so
 * every numeric column goes through here. NaN would be a silent uncapped limit,
 * so a value that cannot be read is a hard error rather than a default.
 */
function num(value: number | string, column: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`lp_automation_policies.${column} is not a finite number`);
  }
  return parsed;
}

export function rowToStored(row: PolicyRow): StoredPolicy {
  return {
    isActive: row.is_active,
    createdAt: row.created_at,
    policy: {
      version: row.version,
      chain: 'robinhood',
      maxPositionSizeUsd: num(row.max_position_size_usd, 'max_position_size_usd'),
      allowedPools: normalizeAllowedPools(row.allowed_pools ?? []),
      poolSelectionCriteria: {
        minTvlUsd: num(row.min_tvl_usd, 'min_tvl_usd'),
        min24hVolumeUsd: num(row.min_24h_volume_usd, 'min_24h_volume_usd'),
        maxIlRiskScore: num(row.max_il_risk_score, 'max_il_risk_score'),
      },
      compoundTrigger: {
        enabled: row.auto_compound ?? true,
        minFeesVsGasRatio: num(row.min_fees_vs_gas_ratio, 'min_fees_vs_gas_ratio'),
        maxIntervalHours: num(row.max_interval_hours, 'max_interval_hours'),
      },
      rebalanceTrigger: {
        enabled: row.auto_rebalance ?? true,
        rangeExitPercent: num(row.range_exit_percent, 'range_exit_percent'),
        rangeStrategy: normalizeRangeStrategy(row.range_strategy),
      },
      switchingBuffer: {
        minEfficiencyDeltaPercent: num(
          row.min_efficiency_delta_percent,
          'min_efficiency_delta_percent',
        ),
        sustainedDurationMinutes: num(row.sustained_duration_minutes, 'sustained_duration_minutes'),
      },
      dailySpendCapUsd: num(row.daily_spend_cap_usd, 'daily_spend_cap_usd'),
    },
  };
}

/**
 * Payload for the `lp_append_policy` RPC.
 *
 * Deliberately carries neither `user_id`, `version` nor `is_active`: the
 * function assigns all three inside its transaction. `version` in particular
 * must be server-assigned under a row lock — a value computed here would be
 * read outside the lock and could collide with a concurrent save.
 */
export function policyToRpcPayload(policy: AutomationPolicy): Record<string, unknown> {
  return {
    chain: policy.chain,
    max_position_size_usd: policy.maxPositionSizeUsd,
    daily_spend_cap_usd: policy.dailySpendCapUsd,
    allowed_pools: policy.allowedPools,
    min_tvl_usd: policy.poolSelectionCriteria.minTvlUsd,
    min_24h_volume_usd: policy.poolSelectionCriteria.min24hVolumeUsd,
    max_il_risk_score: policy.poolSelectionCriteria.maxIlRiskScore,
    min_fees_vs_gas_ratio: policy.compoundTrigger.minFeesVsGasRatio,
    max_interval_hours: policy.compoundTrigger.maxIntervalHours,
    auto_compound: policy.compoundTrigger.enabled,
    range_exit_percent: policy.rebalanceTrigger.rangeExitPercent,
    range_strategy: policy.rebalanceTrigger.rangeStrategy,
    auto_rebalance: policy.rebalanceTrigger.enabled,
    min_efficiency_delta_percent: policy.switchingBuffer.minEfficiencyDeltaPercent,
    sustained_duration_minutes: policy.switchingBuffer.sustainedDurationMinutes,
  };
}

// --- Local JSON store ------------------------------------------------------

/** Both local stores are keyed by user id; only the value type differs. */
type LocalFile<T> = Record<string, T>;

function readLocalFile<T>(path: string): LocalFile<T> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return isRecord(parsed) ? (parsed as LocalFile<T>) : {};
  } catch (err) {
    // A corrupt file must not look like "nothing configured" — that would
    // silently reset the operator's caps back to nothing on the next write.
    throw new Error(`Could not read ${path}: ${(err as Error).message}`);
  }
}

function writeLocalFile<T>(path: string, file: LocalFile<T>): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2));
}

// --- Provider-agnostic operations ------------------------------------------

async function listPolicies(userId: string): Promise<StoredPolicy[]> {
  if (isHostedMode()) {
    const db = getServiceClient();
    if (!db) throw new Error('Supabase is not configured.');
    const { data, error } = await db
      .from(POLICY_TABLE)
      .select('*')
      .eq('user_id', userId)
      .order('version', { ascending: true });
    if (error) throw new Error(`Failed to load LP policies: ${error.message}`);
    return (data as PolicyRow[] | null ?? []).map(rowToStored);
  }

  const stored = readLocalFile<StoredPolicy[]>(LOCAL_POLICY_PATH)[userId] ?? [];
  return [...stored].sort((a, b) => a.policy.version - b.policy.version);
}

/**
 * Append a new version and make it the active one.
 *
 * Appending is the ONLY write path. Older versions are retained (deactivated,
 * never deleted) so a position pinned to one always resolves — see
 * `resolvePolicyForPosition` in lp-automation, which fails closed rather than
 * substituting a newer policy.
 */
async function appendPolicy(userId: string, policy: AutomationPolicy): Promise<StoredPolicy> {
  if (isHostedMode()) {
    const db = getServiceClient();
    if (!db) throw new Error('Supabase is not configured.');

    // Retire-then-insert happens inside ONE transaction, in Postgres. Doing it
    // as two client round-trips means a failure between them leaves the user
    // with no active version — which silently disables the automation until
    // they next save. That is a safe failure (the signer does nothing without
    // an active policy) but an invisible one, and the row holding the spend
    // caps is the wrong place for invisible state.
    //
    // The function also assigns `version` under a row lock, so two concurrent
    // saves cannot read the same max(version).
    const { data, error } = await db
      .rpc('lp_append_policy', {
        p_user_id: userId,
        p_policy: policyToRpcPayload(policy),
      })
      .single();
    if (error) throw new Error(`Failed to save LP policy: ${error.message}`);
    return rowToStored(data as PolicyRow);
  }

  const file = readLocalFile<StoredPolicy[]>(LOCAL_POLICY_PATH);
  const existing = file[userId] ?? [];
  const stored: StoredPolicy = {
    policy,
    isActive: true,
    createdAt: new Date().toISOString(),
  };
  file[userId] = [...existing.map((p) => ({ ...p, isActive: false })), stored];
  writeLocalFile(LOCAL_POLICY_PATH, file);
  return stored;
}

// --- Settings --------------------------------------------------------------

interface SettingsRow {
  safe_address: string | null;
  module_address: string | null;
  updated_at: string | null;
}

const EMPTY_SETTINGS: LpSettings = { safeAddress: null, moduleAddress: null, updatedAt: null };

function rowToSettings(row: SettingsRow): LpSettings {
  return {
    safeAddress: row.safe_address,
    moduleAddress: row.module_address,
    updatedAt: row.updated_at,
  };
}

/** No row yet is a normal state — an account that has not deployed a Safe. */
async function readSettings(userId: string): Promise<LpSettings> {
  if (isHostedMode()) {
    const db = getServiceClient();
    if (!db) throw new Error('Supabase is not configured.');
    const { data, error } = await db
      .from(SETTINGS_TABLE)
      .select('safe_address, module_address, updated_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(`Failed to load LP settings: ${error.message}`);
    return data ? rowToSettings(data as SettingsRow) : { ...EMPTY_SETTINGS };
  }

  return readLocalFile<LpSettings>(LOCAL_SETTINGS_PATH)[userId] ?? { ...EMPTY_SETTINGS };
}

/**
 * Apply a validated patch. Unlike the policy, this is a plain in-place upsert:
 * the Safe address is deployment identity, not a rule, so correcting it must not
 * mint a policy version (see the migration's header).
 *
 * The patch is merged against the CURRENT row rather than sent whole, so keys
 * the client omitted keep their stored value.
 */
async function writeSettings(userId: string, patch: SettingsPatch): Promise<LpSettings> {
  const current = await readSettings(userId);
  const merged = {
    safeAddress: 'safeAddress' in patch ? patch.safeAddress ?? null : current.safeAddress,
    moduleAddress: 'moduleAddress' in patch ? patch.moduleAddress ?? null : current.moduleAddress,
  };

  if (isHostedMode()) {
    const db = getServiceClient();
    if (!db) throw new Error('Supabase is not configured.');
    // `updated_at` is deliberately not sent: the table's default fills it on
    // insert and its trigger refreshes it on update, so the timestamp comes from
    // the database clock rather than from whichever server handled the request.
    const { data, error } = await db
      .from(SETTINGS_TABLE)
      .upsert(
        { user_id: userId, safe_address: merged.safeAddress, module_address: merged.moduleAddress },
        { onConflict: 'user_id' },
      )
      .select('safe_address, module_address, updated_at')
      .single();
    if (error) throw new Error(`Failed to save LP settings: ${error.message}`);
    return rowToSettings(data as SettingsRow);
  }

  const file = readLocalFile<LpSettings>(LOCAL_SETTINGS_PATH);
  const stored: LpSettings = { ...merged, updatedAt: new Date().toISOString() };
  file[userId] = stored;
  writeLocalFile(LOCAL_SETTINGS_PATH, file);
  return stored;
}

// --- Commands --------------------------------------------------------------

interface CommandRow {
  id: string;
  /** Null for an `enter` row — the position does not exist yet. */
  token_id: string | null;
  pool_address: string;
  action: string;
  status: string;
  requested_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  tx_hash: string | null;
  error: string | null;
}

const COMMAND_COLUMNS =
  'id, token_id, pool_address, action, status, requested_at, claimed_at, completed_at, tx_hash, error';

/** Most recent commands returned to the dashboard. Enough for a history panel. */
const COMMAND_HISTORY_LIMIT = 50;

export function rowToCommand(row: CommandRow): LpCommand {
  return {
    id: row.id,
    // Passed through as-is: an `enter` row's null stays null rather than being
    // coerced to "" — the History view distinguishes "opens a new position"
    // from a real tokenId on exactly this field.
    tokenId: row.token_id,
    poolAddress: row.pool_address,
    action: row.action as LpCommandAction,
    status: row.status as LpCommandStatus,
    requestedAt: row.requested_at,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
    txHash: row.tx_hash,
    error: row.error,
  };
}

/**
 * Raised when a position already has a command the worker has not finished
 * with. Carried as a type rather than a string so the route can answer 409
 * without pattern-matching an error message.
 */
export class DuplicateCommandError extends Error {
  constructor(public readonly tokenId: string) {
    super(
      `position ${tokenId} already has a queued or running command; ` +
        'wait for it to finish before requesting another',
    );
    this.name = 'DuplicateCommandError';
  }
}

/** Postgres unique-violation. The partial index is the real duplicate check. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Queue one command.
 *
 * Hosted mode leans on the partial unique index for the duplicate rule rather
 * than on the read below it: a read-then-write check loses to two clicks
 * arriving at two server instances at once, and "at most one open command per
 * position" is not a rule worth losing that race on. The pre-read exists only to
 * produce the friendlier message in the common, uncontended case.
 */
async function insertCommand(userId: string, request: CommandRequest): Promise<LpCommand> {
  if (isHostedMode()) {
    const db = getServiceClient();
    if (!db) throw new Error('Supabase is not configured.');

    const { data, error } = await db
      .from(COMMANDS_TABLE)
      .insert({
        user_id: userId,
        token_id: request.tokenId,
        pool_address: request.poolAddress,
        action: request.action,
      })
      .select(COMMAND_COLUMNS)
      .single();

    if (error) {
      if (error.code === PG_UNIQUE_VIOLATION) throw new DuplicateCommandError(request.tokenId);
      throw new Error(`Failed to queue the LP command: ${error.message}`);
    }
    return rowToCommand(data as CommandRow);
  }

  const file = readLocalFile<LpCommand[]>(LOCAL_COMMANDS_PATH);
  const existing = file[userId] ?? [];
  if (
    existing.some(
      (command) =>
        command.tokenId === request.tokenId && OPEN_COMMAND_STATUSES.includes(command.status),
    )
  ) {
    throw new DuplicateCommandError(request.tokenId);
  }

  const command: LpCommand = {
    id: globalThis.crypto.randomUUID(),
    tokenId: request.tokenId,
    poolAddress: request.poolAddress,
    action: request.action,
    status: 'pending',
    requestedAt: new Date().toISOString(),
    claimedAt: null,
    completedAt: null,
    txHash: null,
    error: null,
  };
  file[userId] = [...existing, command];
  writeLocalFile(LOCAL_COMMANDS_PATH, file);
  return command;
}

/**
 * Queue one `enter` (Zap In) command.
 *
 * Separate from `insertCommand` because the row shape differs: `token_id` is
 * null and the enter-only columns carry the pool, input token, amount and range.
 * There is deliberately no duplicate check — the "one open command per position"
 * rule is keyed on tokenId, and an enter has none (the DB's partial unique index
 * is likewise on `token_id`, so a null never collides). Two enters for the same
 * pool are a legitimate thing to queue; the worker serializes them.
 */
async function insertEnterCommand(userId: string, request: EnterCommandRequest): Promise<LpCommand> {
  if (isHostedMode()) {
    const db = getServiceClient();
    if (!db) throw new Error('Supabase is not configured.');

    const { data, error } = await db
      .from(COMMANDS_TABLE)
      .insert({
        user_id: userId,
        token_id: null,
        pool_address: request.poolAddress,
        token_in_address: request.tokenInAddress,
        amount_in: request.amountIn,
        range_strategy: request.rangeStrategy,
        swap_slippage: request.swapSlippage,
        action: 'enter',
      })
      .select(COMMAND_COLUMNS)
      .single();

    if (error) throw new Error(`Failed to queue the LP command: ${error.message}`);
    return rowToCommand(data as CommandRow);
  }

  const file = readLocalFile<LpCommand[]>(LOCAL_COMMANDS_PATH);
  const existing = file[userId] ?? [];
  const command: LpCommand = {
    id: globalThis.crypto.randomUUID(),
    tokenId: null,
    poolAddress: request.poolAddress,
    action: 'enter',
    status: 'pending',
    requestedAt: new Date().toISOString(),
    claimedAt: null,
    completedAt: null,
    txHash: null,
    error: null,
  };
  file[userId] = [...existing, command];
  writeLocalFile(LOCAL_COMMANDS_PATH, file);
  return command;
}

async function insertIncreaseCommand(userId: string, request: IncreaseCommandRequest): Promise<LpCommand> {
  if (isHostedMode()) {
    const db = getServiceClient();
    if (!db) throw new Error('Supabase is not configured.');

    const { data, error } = await db
      .from(COMMANDS_TABLE)
      .insert({
        user_id: userId,
        token_id: request.tokenId,
        pool_address: request.poolAddress,
        token_in_address: request.tokenInAddress,
        amount_in: request.amountIn,
        range_strategy: null,
        swap_slippage: request.swapSlippage,
        action: 'increase',
      })
      .select(COMMAND_COLUMNS)
      .single();

    if (error) throw new Error(`Failed to queue the LP command: ${error.message}`);
    return rowToCommand(data as CommandRow);
  }

  const file = readLocalFile<LpCommand[]>(LOCAL_COMMANDS_PATH);
  const existing = file[userId] ?? [];
  const command: LpCommand = {
    id: globalThis.crypto.randomUUID(),
    tokenId: request.tokenId,
    poolAddress: request.poolAddress,
    action: 'increase',
    status: 'pending',
    requestedAt: new Date().toISOString(),
    claimedAt: null,
    completedAt: null,
    txHash: null,
    error: null,
  };
  file[userId] = [...existing, command];
  writeLocalFile(LOCAL_COMMANDS_PATH, file);
  return command;
}

/** Does this position already have a command in flight? Advisory — see above. */
async function findOpenCommand(userId: string, tokenId: string): Promise<LpCommand | null> {
  if (isHostedMode()) {
    const db = getServiceClient();
    if (!db) throw new Error('Supabase is not configured.');
    const { data, error } = await db
      .from(COMMANDS_TABLE)
      .select(COMMAND_COLUMNS)
      .eq('user_id', userId)
      .eq('token_id', tokenId)
      .in('status', OPEN_COMMAND_STATUSES as string[])
      .limit(1);
    if (error) throw new Error(`Failed to check for a queued LP command: ${error.message}`);
    const rows = (data as CommandRow[] | null) ?? [];
    return rows.length > 0 ? rowToCommand(rows[0]!) : null;
  }

  const stored = readLocalFile<LpCommand[]>(LOCAL_COMMANDS_PATH)[userId] ?? [];
  return (
    stored.find(
      (command) => command.tokenId === tokenId && OPEN_COMMAND_STATUSES.includes(command.status),
    ) ?? null
  );
}

/** Recent commands, newest first, optionally narrowed to one position. */
async function listCommands(userId: string, tokenId: string | null): Promise<LpCommand[]> {
  if (isHostedMode()) {
    const db = getServiceClient();
    if (!db) throw new Error('Supabase is not configured.');
    let query = db
      .from(COMMANDS_TABLE)
      .select(COMMAND_COLUMNS)
      .eq('user_id', userId)
      .order('requested_at', { ascending: false })
      .limit(COMMAND_HISTORY_LIMIT);
    if (tokenId !== null) query = query.eq('token_id', tokenId);
    const { data, error } = await query;
    if (error) throw new Error(`Failed to load LP commands: ${error.message}`);
    return ((data as CommandRow[] | null) ?? []).map(rowToCommand);
  }

  const stored = readLocalFile<LpCommand[]>(LOCAL_COMMANDS_PATH)[userId] ?? [];
  return stored
    .filter((command) => tokenId === null || command.tokenId === tokenId)
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
    .slice(0, COMMAND_HISTORY_LIMIT);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createLpRoutes(): Router {
  const router = Router();

  // The candidates route reaches out to a third party on every call, so it is
  // rate-limited per user independently of the policy CRUD.
  const candidatesLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.userId ?? req.ip ?? 'unknown',
    message: { error: 'Too many pool-discovery requests — wait a minute and try again.' },
  });

  // GET /api/lp/policy -> { policy, versions }
  // `policy` is the active (highest) version, or null when nothing is
  // configured yet. `versions` is every version ever written, ascending, so the
  // dashboard can show the history without a second round trip.
  router.get('/policy', async (req, res) => {
    try {
      const policies = await listPolicies(getUserId(req));
      const current = currentDefaultPolicy(policies);
      res.json({
        policy: current?.policy ?? null,
        versions: policies.map((p) => p.policy.version),
      });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to load the LP policy') });
    }
  });

  // PUT /api/lp/policy — body is an AutomationPolicy WITHOUT `version`.
  //
  // Always creates a new version; it never mutates an existing one, because an
  // open position pins a version and §5 requires that changing the default not
  // retroactively affect it. A `version` sent by the client is ignored — the
  // server assigns it.
  //
  // Validation runs here regardless of what the client did. Structured field
  // errors come back so the form can mark every bad input at once.
  router.put('/policy', async (req, res) => {
    try {
      const userId = getUserId(req);
      const existing = await listPolicies(userId);
      const version = nextPolicyVersion(existing.map((p) => p.policy.version));

      const result = validatePolicyInput(req.body, version);
      if (!result.valid) {
        return res.status(400).json({
          error: 'The policy is not valid.',
          issues: result.issues,
        });
      }

      const stored = await appendPolicy(
        userId,
        buildPolicy(req.body as Record<string, unknown>, version),
      );
      res.json({ policy: stored.policy, createdAt: stored.createdAt });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to save the LP policy') });
    }
  });

  // GET /api/lp/pools/candidates?minTvlUsd=&min24hVolumeUsd=&limit=
  //
  // SURFACES pools for manual selection. It admits nothing: the response is
  // advisory, and a pool only becomes usable once a human ticks it and the
  // resulting allowlist is saved through PUT /policy (plan §9.2).
  //
  // Thresholds default to the active policy's poolSelectionCriteria, then to 0
  // (surface everything) — never to a hard-coded floor that could hide pools
  // the operator's own policy would have shown.
  router.get('/pools/candidates', candidatesLimiter, async (req, res) => {
    try {
      const userId = getUserId(req);
      const policies = await listPolicies(userId).catch(() => [] as StoredPolicy[]);
      const current = currentDefaultPolicy(policies);
      const criteria = current?.policy.poolSelectionCriteria;

      const minTvlUsd = readNumberParam(req.query.minTvlUsd) ?? criteria?.minTvlUsd ?? 0;
      const min24hVolumeUsd =
        readNumberParam(req.query.min24hVolumeUsd) ?? criteria?.min24hVolumeUsd ?? 0;
      if (minTvlUsd < 0 || min24hVolumeUsd < 0) {
        return res
          .status(400)
          .json({ error: 'minTvlUsd and min24hVolumeUsd must not be negative.' });
      }

      const limit = clamp(readNumberParam(req.query.limit) ?? 50, 1, 200);

      // Ask Krystal for a generous page and filter client-side: its `protocol`
      // and `minTvl` query params are accepted but ignored (byte-identical
      // responses), so relying on them would silently disable these criteria.
      const raw = await fetchTopPools(ROBINHOOD_CHAIN_ID, 500);
      const { pools, skipped } = mapTopPools(raw);
      const filtered = filterCandidates(pools, ROBINHOOD_CHAIN_ID, {
        minTvlUsd,
        min24hVolumeUsd,
        limit,
      });

      const allowed = new Set(current?.policy.allowedPools ?? []);
      res.json({
        chainId: ROBINHOOD_CHAIN_ID,
        platform: KRYSTAL_PLATFORM,
        filters: {
          minTvlUsd,
          min24hVolumeUsd,
          limit,
          source: criteria ? 'policy' : 'default',
        },
        pools: filtered.map((pool) => ({ ...pool, alreadyAllowed: allowed.has(pool.address) })),
        totalReturned: pools.length,
        // Surfaced, not swallowed: a growing skip list is how a Krystal schema
        // change becomes visible instead of quietly shrinking the shortlist.
        skipped,
      });
    } catch (err) {
      if (err instanceof KrystalWafError) {
        return res.status(500).json({ error: err.message });
      }
      if (err instanceof KrystalRequestError) {
        // A discovery failure surfaces no new candidates. That is the safe
        // degradation (plan §3) — it can never stall an open position.
        return res.status(502).json({ error: err.message, pools: [], skipped: [] });
      }
      res.status(500).json({ error: safeError(err, 'Failed to load pool candidates') });
    }
  });

  // The positions route also reaches a third party on every call. It gets its
  // OWN bucket rather than sharing the candidates one: a dashboard polling
  // positions must not be able to exhaust the operator's ability to look up
  // pools, or vice versa.
  const positionsLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.userId ?? req.ip ?? 'unknown',
    message: { error: 'Too many position requests — wait a minute and try again.' },
  });

  // GET /api/lp/settings -> { safeAddress, moduleAddress, updatedAt }
  // All-null is the correct answer for an account that has not deployed a Safe.
  router.get('/settings', async (req, res) => {
    try {
      res.json(await readSettings(getUserId(req)));
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to load the LP settings') });
    }
  });

  // PUT /api/lp/settings — body { safeAddress?, moduleAddress? }.
  //
  // Plain upsert, NOT a new version: the Safe address identifies a deployment,
  // it is not a rule, and re-versioning the policy because a typo was corrected
  // would repoint nothing while polluting the history that open positions pin.
  //
  // An omitted key is left unchanged; an explicit null (or "") clears it.
  router.put('/settings', async (req, res) => {
    try {
      const result = validateSettingsInput(req.body);
      if (!result.valid) {
        return res.status(400).json({
          error: 'The LP settings are not valid.',
          issues: result.issues,
        });
      }
      res.json(await writeSettings(getUserId(req), result.patch));
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to save the LP settings') });
    }
  });

  // GET /api/lp/positions — the operator's open positions, FOR DISPLAY ONLY.
  //
  // See the "User LP positions" section header: the values here come from
  // Krystal's cached view and must never feed a spend decision. The response
  // carries no tick data at all, which is what stops that from happening.
  //
  // With no Safe configured this returns 200 with `configured: false` and an
  // empty list. That is a not-yet-set-up account, not a failure, and rendering
  // an error for it would make the normal first-run state look broken.
  router.get('/positions', positionsLimiter, async (req, res) => {
    const fetchedAt = () => new Date().toISOString();
    try {
      const userId = getUserId(req);
      const settings = await readSettings(userId);
      const safeAddress = settings.safeAddress;

      if (!safeAddress) {
        return res.json({
          safeAddress: null,
          configured: false,
          positions: [],
          skipped: [],
          pnlByLineage: {},
          lineageLinks: [],
          auditLogAvailable: false,
          fetchedAt: fetchedAt(),
        });
      }

      // A missing/failed policy read must not hide the positions themselves —
      // it only means we cannot say which are allowlisted, so the flags fall
      // back to false rather than the whole request failing.
      //
      // But "false" here means two very different things, and the client cannot
      // tell them apart without help: a genuinely empty allowlist (this position
      // really is unmanaged) versus a policy read that FAILED (we have no idea).
      // Reporting the second as the first tells the operator their money is
      // unprotected when it may be perfectly well covered — alarming, and
      // actionable in the wrong direction. `policyReadFailed` lets the dashboard
      // say "coverage unknown" instead of asserting a gap it cannot see.
      let policyReadFailed = false;
      const policies = await listPolicies(userId).catch(() => {
        policyReadFailed = true;
        return [] as StoredPolicy[];
      });
      const current = currentDefaultPolicy(policies);
      const allowedPools = new Set<string>(current?.policy.allowedPools ?? []);

      const raw = await fetchUserPositionsRaw(ROBINHOOD_CHAIN_ID, safeAddress);
      const { positions, skipped } = mapUserPositionViews(raw, {
        chainId: ROBINHOOD_CHAIN_ID,
        allowedPools,
      });

      const pnl = await loadLineagePnl(positions).catch(() => ({
        pnlByLineage: {},
        lineageLinks: [],
        auditLogAvailable: false,
      }));

      res.json({
        safeAddress,
        configured: true,
        positions,
        // Surfaced, not swallowed: a growing skip list is how a Krystal schema
        // change becomes visible instead of quietly shrinking the table.
        skipped,
        // True => every `isAllowlisted`/`managedByAutomation` flag above is
        // unknown, not false. See the comment at the policy read.
        policyReadFailed,
        ...pnl,
        fetchedAt: fetchedAt(),
      });
    } catch (err) {
      if (err instanceof KrystalWafError) {
        return res.status(500).json({ error: err.message });
      }
      if (err instanceof KrystalRequestError) {
        // Upstream is unreachable. The shape is kept identical to the success
        // case so the dashboard renders "couldn't refresh" rather than having to
        // special-case a differently-shaped error body.
        return res.status(502).json({
          error: err.message,
          safeAddress: null,
          configured: true,
          positions: [],
          skipped: [],
          pnlByLineage: {},
          lineageLinks: [],
          auditLogAvailable: false,
          // Same key as the success shape so the client never has to branch on
          // its presence. There are no positions to caveat here, but a response
          // that sometimes omits a field is how optional-chaining bugs start.
          policyReadFailed: false,
          fetchedAt: fetchedAt(),
        });
      }
      res.status(500).json({ error: safeError(err, 'Failed to load LP positions') });
    }
  });

  // Queuing an action is a write, and at most one command may be open per
  // position, so the realistic abuse here is churn rather than volume. Its own
  // bucket, separate from the read-heavy position/candidate routes.
  const commandsLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.userId ?? req.ip ?? 'unknown',
    message: { error: 'Too many manual action requests — wait a minute and try again.' },
  });

  // POST /api/lp/positions/:tokenId/actions — body { action, poolAddress }.
  //
  // ENQUEUES AN INTENT. Nothing here signs, simulates, or contacts a chain: the
  // backend holds no key and the signer process has no inbound surface (plan §9
  // point 1). The row this writes is polled by `lp-automation`, which then runs
  // the SAME `ActionExecutor` ladder an automatic action runs — quarantine
  // check, allowlist re-checked at execution time, dry run, audit intent before
  // broadcast, per-position lock, on-chain module caps, LP_ARMED gate.
  //
  // Two refusals happen here rather than being left to the worker:
  //
  //   * A pool that is not on the active policy's allowlist (409). The worker
  //     would refuse it anyway; queuing it would burn the position's single
  //     command slot to deliver that same answer several seconds later.
  //   * A position that already has a command queued or running (409). The
  //     database enforces this with a partial unique index — the check below is
  //     only there to phrase it better in the uncontended case.
  //
  // Neither is a security boundary. `checkGuards` in the worker is.
  router.post('/positions/:tokenId/actions', commandsLimiter, async (req, res) => {
    try {
      const userId = getUserId(req);
      const result = validateCommandInput(req.params.tokenId, req.body);
      if (!result.valid || result.request === null) {
        return res.status(400).json({
          error: 'The requested action is not valid.',
          issues: result.issues,
        });
      }
      const request = result.request;

      // A policy read failure must NOT fall through to "not allowlisted" — that
      // would report a temporary outage as a permission problem and send the
      // operator off to edit an allowlist that is already correct.
      let policies: StoredPolicy[];
      try {
        policies = await listPolicies(userId);
      } catch (err) {
        return res.status(503).json({
          error: safeError(
            err,
            'Could not read the LP policy, so the pool allowlist could not be checked. Nothing was queued.',
          ),
        });
      }

      const current = currentDefaultPolicy(policies);
      if (!isPoolOnAllowlist(current?.policy ?? null, request.poolAddress)) {
        return res.status(409).json({
          error:
            current === null
              ? 'No LP policy is configured yet, so no pool is approved. Save a policy with this pool allowlisted first.'
              : `Pool ${request.poolAddress} is not on policy v${current.policy.version}'s allowlist ` +
                `(${current.policy.allowedPools.length} pool(s)). The worker would refuse this action, so it was not queued.`,
          poolAddress: request.poolAddress,
          activeVersion: current?.policy.version ?? null,
        });
      }

      const open = await findOpenCommand(userId, request.tokenId);
      if (open !== null) {
        return res.status(409).json({
          error: new DuplicateCommandError(request.tokenId).message,
          command: open,
        });
      }

      const command = await insertCommand(userId, request);
      res.status(201).json({ command });
    } catch (err) {
      if (err instanceof DuplicateCommandError) {
        return res.status(409).json({ error: err.message });
      }
      res.status(500).json({ error: safeError(err, 'Failed to queue the requested action') });
    }
  });

  // POST /api/lp/enter — body { poolAddress, tokenInAddress, amountIn,
  //                            rangeStrategy?, swapSlippage? }.
  //
  // ENQUEUES AN INTENT to open a BRAND-NEW position (Zap In). Same contract as
  // the tokenId-actions route above — nothing here signs, simulates, or contacts
  // a chain — but the body carries a pool + input token + amount + range instead
  // of a tokenId, because the position does not exist yet. The row it writes
  // (`action='enter'`, `token_id=null`) is polled by `lp-automation`, which reads
  // the pool's live tick, computes the range and runs the same `ActionExecutor`
  // ladder (allowlist re-check, dry run, audit intent, module caps, LP_ARMED).
  //
  // The same two refusals happen here as for a manual action: a pool that is not
  // on the SAVED allowlist (409, the worker would refuse it anyway) and a policy
  // that cannot be read (503, so an outage is not mis-reported as "not
  // allowlisted"). There is no duplicate-command refusal — that rule is per
  // tokenId, and an enter has none.
  router.post('/enter', commandsLimiter, async (req, res) => {
    try {
      const userId = getUserId(req);
      const result = validateEnterInput(req.body);
      if (!result.valid || result.request === null) {
        return res.status(400).json({
          error: 'The requested action is not valid.',
          issues: result.issues,
        });
      }
      const request = result.request;

      // A policy read failure must NOT fall through to "not allowlisted" — that
      // would report a temporary outage as a permission problem and send the
      // operator off to edit an allowlist that is already correct.
      let policies: StoredPolicy[];
      try {
        policies = await listPolicies(userId);
      } catch (err) {
        return res.status(503).json({
          error: safeError(
            err,
            'Could not read the LP policy, so the pool allowlist could not be checked. Nothing was queued.',
          ),
        });
      }

      const current = currentDefaultPolicy(policies);
      if (!isPoolOnAllowlist(current?.policy ?? null, request.poolAddress)) {
        return res.status(409).json({
          error:
            current === null
              ? 'No LP policy is configured yet, so no pool is approved. Save a policy with this pool allowlisted first.'
              : `Pool ${request.poolAddress} is not on policy v${current.policy.version}'s allowlist ` +
                `(${current.policy.allowedPools.length} pool(s)). The worker would refuse this action, so it was not queued.`,
          poolAddress: request.poolAddress,
          activeVersion: current?.policy.version ?? null,
        });
      }

      const command = await insertEnterCommand(userId, request);
      res.status(201).json({ command });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to queue the requested action') });
    }
  });

  // POST /api/lp/positions/:tokenId/increase — body { poolAddress, tokenInAddress,
  // amountIn, swapSlippage? }. Adds liquidity to an existing position via the worker.
  router.post('/positions/:tokenId/increase', commandsLimiter, async (req, res) => {
    try {
      const userId = getUserId(req);
      const result = validateIncreaseInput(req.params.tokenId, req.body);
      if (!result.valid || result.request === null) {
        return res.status(400).json({
          error: 'The requested action is not valid.',
          issues: result.issues,
        });
      }
      const request = result.request;

      let policies: StoredPolicy[];
      try {
        policies = await listPolicies(userId);
      } catch (err) {
        return res.status(503).json({
          error: safeError(
            err,
            'Could not read the LP policy, so the pool allowlist could not be checked. Nothing was queued.',
          ),
        });
      }

      const current = currentDefaultPolicy(policies);
      if (!isPoolOnAllowlist(current?.policy ?? null, request.poolAddress)) {
        return res.status(409).json({
          error:
            current === null
              ? 'No LP policy is configured yet, so no pool is approved. Save a policy with this pool allowlisted first.'
              : `Pool ${request.poolAddress} is not on policy v${current.policy.version}'s allowlist ` +
                `(${current.policy.allowedPools.length} pool(s)). The worker would refuse this action, so it was not queued.`,
          poolAddress: request.poolAddress,
          activeVersion: current?.policy.version ?? null,
        });
      }

      const open = await findOpenCommand(userId, request.tokenId);
      if (open !== null) {
        return res.status(409).json({
          error: new DuplicateCommandError(request.tokenId).message,
          command: open,
        });
      }

      const command = await insertIncreaseCommand(userId, request);
      res.status(201).json({ command });
    } catch (err) {
      if (err instanceof DuplicateCommandError) {
        return res.status(409).json({ error: err.message });
      }
      res.status(500).json({ error: safeError(err, 'Failed to queue the requested action') });
    }
  });

  // GET /api/lp/commands?tokenId= — recent commands, newest first.
  //
  // How the dashboard renders "queued / running / done / failed" without
  // holding any state of its own. `tokenId` narrows it to one position;
  // omitting it returns the account's recent commands across all positions.
  router.get('/commands', async (req, res) => {
    try {
      const tokenId = typeof req.query.tokenId === 'string' ? req.query.tokenId.trim() : '';
      if (tokenId.length > 0 && !TOKEN_ID_PATTERN.test(tokenId)) {
        return res.status(400).json({
          error: 'The tokenId filter is not valid.',
          issues: [{ field: 'tokenId', message: 'must be a positive integer position id' }],
        });
      }
      const commands = await listCommands(getUserId(req), tokenId.length > 0 ? tokenId : null);
      res.json({ commands });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to load LP commands') });
    }
  });

  // GET /api/lp/status — cheap health/summary for the dashboard. No secrets.
  router.get('/status', async (req, res) => {
    try {
      const policies = await listPolicies(getUserId(req));
      const current = currentDefaultPolicy(policies);
      res.json({
        hasPolicy: current !== null,
        activeVersion: current?.policy.version ?? null,
        versions: policies.map((p) => p.policy.version),
        allowlistSize: current?.policy.allowedPools.length ?? 0,
        chain: current?.policy.chain ?? null,
        chainId: ROBINHOOD_CHAIN_ID,
        updatedAt: current?.createdAt ?? null,
        mode: isHostedMode() ? 'hosted' : 'local',
      });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to load LP status') });
    }
  });

  return router;
}

/**
 * Read a numeric query parameter. Returns undefined for absent/blank so the
 * caller can fall back; returns undefined for garbage too rather than NaN,
 * which would compare false against everything and silently empty the list.
 */
export function readNumberParam(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (!NUMERIC.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
