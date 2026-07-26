import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isHostedMode } from '../../storage/index.js';
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
    minFeesVsGasRatio: number;
    maxIntervalHours: number;
  };
  rebalanceTrigger: {
    rangeExitPercent: number;
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
    checkNumber(issues, 'rebalanceTrigger.rangeExitPercent', rebalance.rangeExitPercent, {
      exclusiveMin: 0,
      because: 'a zero threshold rebalances on the first tick outside the range',
    });
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
  const compound = input.compoundTrigger as Record<string, number>;
  const rebalance = input.rebalanceTrigger as Record<string, number>;
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
      minFeesVsGasRatio: compound.minFeesVsGasRatio,
      maxIntervalHours: compound.maxIntervalHours,
    },
    rebalanceTrigger: { rangeExitPercent: rebalance.rangeExitPercent },
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
 * Krystal expresses fee tiers as PERCENT (`feeTier: 0.05` for a 0.05% pool,
 * whose on-chain `fee()` is 500) and APRs as percent (`apr: 8806.02`). Verified
 * against the pool contracts on chain 4663:
 *   feeTier 1 -> fee 10000 -> 100 bps · 0.3 -> 3000 -> 30 bps
 *   feeTier 0.05 -> fee 500 -> 5 bps · 0.01 -> 100 -> 1 bps
 *
 * Rounded through integer micro-percent so 0.05 * 100 does not land on
 * 5.000000000000001.
 */
export function percentToBps(percent: number): number {
  return Math.round(percent * 1e6) / 1e4;
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
    feeTierBps: percentToBps(feeTierPercent),
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

async function fetchTopPools(chainId: number, limit: number): Promise<unknown> {
  const query = buildKrystalQuery({ chainId, limit });
  const url = `${KRYSTAL_BASE_URL}${TOP_POOLS_PATH}?${query}`;

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
        `Krystal pool discovery failed (HTTP ${response.status}, content-type "${contentType}")`,
        response.status,
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof KrystalRequestError) throw error;
    if ((error as Error)?.name === 'AbortError') {
      throw new KrystalRequestError(
        `Krystal pool discovery timed out after ${KRYSTAL_TIMEOUT_MS}ms`,
        null,
      );
    }
    throw new KrystalRequestError(
      `Krystal pool discovery failed: ${(error as Error)?.message ?? 'unknown error'}`,
      null,
    );
  } finally {
    clearTimeout(timer);
  }
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

const POLICY_TABLE = 'lp_automation_policies';

let _client: SupabaseClient | null = null;

function getServiceClient(): SupabaseClient | null {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL?.trim();
  const key = (process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  if (!url || !key) return null;
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

interface PolicyRow {
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

function rowToStored(row: PolicyRow): StoredPolicy {
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
        minFeesVsGasRatio: num(row.min_fees_vs_gas_ratio, 'min_fees_vs_gas_ratio'),
        maxIntervalHours: num(row.max_interval_hours, 'max_interval_hours'),
      },
      rebalanceTrigger: { rangeExitPercent: num(row.range_exit_percent, 'range_exit_percent') },
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
function policyToRpcPayload(policy: AutomationPolicy): Record<string, unknown> {
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
    range_exit_percent: policy.rebalanceTrigger.rangeExitPercent,
    min_efficiency_delta_percent: policy.switchingBuffer.minEfficiencyDeltaPercent,
    sustained_duration_minutes: policy.switchingBuffer.sustainedDurationMinutes,
  };
}

// --- Local JSON store ------------------------------------------------------

type LocalFile = Record<string, StoredPolicy[]>;

function readLocalFile(): LocalFile {
  if (!existsSync(LOCAL_POLICY_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(LOCAL_POLICY_PATH, 'utf-8'));
    return isRecord(parsed) ? (parsed as LocalFile) : {};
  } catch (err) {
    // A corrupt file must not look like "no policy configured" — that would
    // silently reset the operator's caps back to nothing on the next write.
    throw new Error(`Could not read ${LOCAL_POLICY_PATH}: ${(err as Error).message}`);
  }
}

function writeLocalFile(file: LocalFile): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(LOCAL_POLICY_PATH, JSON.stringify(file, null, 2));
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

  const stored = readLocalFile()[userId] ?? [];
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

  const file = readLocalFile();
  const existing = file[userId] ?? [];
  const stored: StoredPolicy = {
    policy,
    isActive: true,
    createdAt: new Date().toISOString(),
  };
  file[userId] = [...existing.map((p) => ({ ...p, isActive: false })), stored];
  writeLocalFile(file);
  return stored;
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
