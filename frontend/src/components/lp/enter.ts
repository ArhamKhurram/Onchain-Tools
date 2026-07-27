// Add liquidity / Zap In — the pure logic behind LpEnterForm.
//
// Opens a NEW LP position from OCT: the same queue → worker → module path the
// manual compound/rebalance actions use, never a browser wallet. This module
// owns the two things that must be right regardless of how the form is drawn:
//
//   1. Human amount → base units, scaled with BigInt-safe math. Floating point
//      on a token amount is exactly how "1.1" turns into 1099999999999999 base
//      units; here the decimal string is scaled by string manipulation and
//      parsed once as a BigInt, so no value is ever routed through a float.
//   2. Client-side pre-flight validation. Mirrors the documented 400 rules of
//      `POST /api/lp/enter` (pool + token required, positive-integer amount,
//      range in the closed set, 0 < slippage ≤ 0.05). The server's 400 is
//      authoritative; this only catches a typo before a round trip.
//
// Keep in sync with `POST /api/lp/enter` — `lp-automation/` is a separate
// workspace the console does not depend on, so the contract is restated here.

import type { LpPositionView } from './positions';
import { normalizeAddress } from './selection';
import { RANGE_STRATEGIES } from './policyDraft';
import type { PoolCandidate, RangeStrategy } from './types';

/** Default swap slippage as a fraction (0.5%). */
export const DEFAULT_SWAP_SLIPPAGE = 0.005;
/** Hard cap enforced by the backend — 5%. */
export const MAX_SWAP_SLIPPAGE = 0.05;

/** Krystal native-token sentinel — pay with ETH instead of WETH. */
export const NATIVE_ETH_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export function isNativeEthTokenIn(address: string): boolean {
  return address.toLowerCase() === NATIVE_ETH_ADDRESS;
}

export interface LpEnterPoolToken {
  symbol: string;
  address: string;
  decimals: number;
}

export interface LpEnterPool {
  /** Normalized (lowercase) pool address — what the saved allowlist stores. */
  address: string;
  token0: LpEnterPoolToken;
  token1: LpEnterPoolToken;
  feeTierBps: number | null;
  pairLabel: string;
  /** True when a live position already sits in this pool (metadata came from it). */
  held: boolean;
}

/** The `POST /api/lp/enter` body. */
export interface LpEnterRequest {
  poolAddress: string;
  tokenInAddress: string;
  /** Base-units integer string (`^[1-9][0-9]*$`). */
  amountIn: string;
  rangeStrategy: RangeStrategy;
  swapSlippage: number;
}

export interface LpEnterFieldIssue {
  field: string;
  message: string;
}

/** The created command view. `tokenId` is null for an enter, so it is ignored. */
export interface LpEnterCommand {
  id: string;
  status: 'pending' | 'claimed' | 'done' | 'failed' | 'skipped' | 'unknown';
  requestedAt: string | null;
  txHash: string | null;
  error: string | null;
}

// --- Amount conversion ------------------------------------------------------

export type BaseUnitsResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * Human decimal string → base-units integer string, scaled by `decimals`.
 *
 * BigInt-safe: the decimal string is split, the fractional part is right-padded
 * (or rejected if it carries more places than the token allows), the two halves
 * are concatenated, and the result is parsed once as a BigInt. No floating point
 * touches the value at any point.
 */
export function toBaseUnits(human: string, decimals: number): BaseUnitsResult {
  const trimmed = human.trim();
  if (trimmed === '') return { ok: false, error: 'Enter an amount.' };
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 60) {
    return { ok: false, error: 'This token’s decimals are unknown, so the amount cannot be scaled.' };
  }
  // Digits with at most one decimal point. No sign, no exponent, no separators —
  // anything else is a typo to reject before scaling.
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '.') {
    return { ok: false, error: 'Amount must be a plain decimal number, e.g. 1.5.' };
  }

  const [whole, frac = ''] = trimmed.split('.');
  if (frac.length > decimals) {
    return {
      ok: false,
      error:
        decimals === 0
          ? 'This token has no decimal places — enter a whole number.'
          : `This token allows at most ${decimals} decimal place${decimals === 1 ? '' : 's'}.`,
    };
  }

  const digits = `${whole}${frac.padEnd(decimals, '0')}`;
  let base: bigint;
  try {
    // BigInt tolerates leading zeros and its toString() drops them, so the
    // result already matches the backend's `^[1-9][0-9]*$` for any positive value.
    base = BigInt(digits === '' ? '0' : digits);
  } catch {
    return { ok: false, error: 'Amount must be a plain decimal number, e.g. 1.5.' };
  }
  if (base <= 0n) return { ok: false, error: 'Amount must be greater than zero.' };
  return { ok: true, value: base.toString() };
}

export type SlippageResult = { ok: true; fraction: number } | { ok: false; error: string };

/**
 * Percent string → fraction (`"0.5"` → `0.005`). Blank falls back to the
 * default. Enforces the same `0 < s ≤ 0.05` bound the backend does.
 */
export function parseSlippagePercent(raw: string): SlippageResult {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, fraction: DEFAULT_SWAP_SLIPPAGE };
  const pct = Number(trimmed);
  if (!Number.isFinite(pct)) return { ok: false, error: 'Slippage must be a number.' };
  const fraction = pct / 100;
  if (fraction <= 0) return { ok: false, error: 'Slippage must be greater than 0%.' };
  if (fraction > MAX_SWAP_SLIPPAGE) {
    return { ok: false, error: `Slippage is capped at ${MAX_SWAP_SLIPPAGE * 100}%.` };
  }
  return { ok: true, fraction };
}

// --- Pool derivation --------------------------------------------------------

function validToken(
  token: { symbol?: unknown; address?: unknown; decimals?: unknown } | null | undefined,
): LpEnterPoolToken | null {
  if (!token || typeof token !== 'object') return null;
  const address = typeof token.address === 'string' ? token.address.trim() : '';
  const symbol = typeof token.symbol === 'string' ? token.symbol.trim() : '';
  const decimals = token.decimals;
  if (!address) return null;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 60) {
    return null;
  }
  return { symbol: symbol || '???', address, decimals };
}

interface PoolMeta {
  token0: LpEnterPoolToken;
  token1: LpEnterPoolToken;
  feeTierBps: number | null;
  held: boolean;
}

function feeTierOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The selectable pools for the enter form: the SAVED allowlist, restricted to
 * pools whose token symbol + decimals are known.
 *
 * LIMITATION (plan §5): token metadata is sourced from the positions feed (pools
 * we already hold) and from the pool-candidate discovery feed. A pool that is
 * allowlisted but neither held nor currently surfaced by discovery carries no
 * token metadata here, so it is deliberately OMITTED rather than shown with
 * unknown decimals — an amount cannot be scaled without the decimals, and a
 * silently-wrong scale on a money action is far worse than a missing option.
 * Held pools win when both feeds carry the same address: a live position is the
 * more authoritative source of the on-chain token layout.
 */
export function buildEnterPools(
  savedAllowlist: readonly string[],
  positions: readonly LpPositionView[],
  candidates: readonly PoolCandidate[] = [],
): LpEnterPool[] {
  const meta = new Map<string, PoolMeta>();

  // Candidates first so a held pool (added second) overrides.
  for (const pool of candidates) {
    const key = normalizeAddress(pool?.address ?? '');
    if (!key) continue;
    const token0 = validToken(pool.token0);
    const token1 = validToken(pool.token1);
    if (!token0 || !token1) continue;
    meta.set(key, { token0, token1, feeTierBps: feeTierOf(pool.feeTierBps), held: false });
  }

  for (const position of positions) {
    const key = normalizeAddress(position?.poolAddress ?? '');
    if (!key) continue;
    const token0 = validToken(position.token0);
    const token1 = validToken(position.token1);
    if (!token0 || !token1) continue;
    meta.set(key, { token0, token1, feeTierBps: feeTierOf(position.feeTierBps), held: true });
  }

  const seen = new Set<string>();
  const pools: LpEnterPool[] = [];
  for (const entry of savedAllowlist) {
    const key = normalizeAddress(entry);
    if (!key || seen.has(key)) continue;
    const found = meta.get(key);
    if (!found) continue;
    seen.add(key);
    pools.push({
      address: key,
      token0: found.token0,
      token1: found.token1,
      feeTierBps: found.feeTierBps,
      pairLabel: `${found.token0.symbol} / ${found.token1.symbol}`,
      held: found.held,
    });
  }
  return pools;
}

export function findEnterPool(pools: readonly LpEnterPool[], address: string): LpEnterPool | null {
  const needle = normalizeAddress(address);
  if (!needle) return null;
  return pools.find((pool) => pool.address === needle) ?? null;
}

/** Deposit token picker options — adds native ETH when the pool has a WETH side. */
export function depositTokenOptions(pool: LpEnterPool): { value: string; label: string }[] {
  const options = [
    { value: pool.token0.address, label: pool.token0.symbol },
    { value: pool.token1.address, label: pool.token1.symbol },
  ];
  const hasWeth = options.some((opt) => opt.label.toUpperCase() === 'WETH');
  if (hasWeth && !options.some((opt) => isNativeEthTokenIn(opt.value))) {
    options.push({ value: NATIVE_ETH_ADDRESS, label: 'ETH' });
  }
  return options;
}

function resolveDepositToken(pool: LpEnterPool, tokenInAddress: string): LpEnterPoolToken | null {
  const needle = normalizeAddress(tokenInAddress);
  if (!needle) return null;
  if (isNativeEthTokenIn(needle)) {
    const weth = [pool.token0, pool.token1].find((t) => t.symbol.toUpperCase() === 'WETH');
    return weth ?? null;
  }
  if (normalizeAddress(pool.token0.address) === needle) return pool.token0;
  if (normalizeAddress(pool.token1.address) === needle) return pool.token1;
  return null;
}

// --- Form validation --------------------------------------------------------

export interface LpEnterFormValues {
  poolAddress: string;
  tokenInAddress: string;
  /** Human amount, e.g. "1.5". */
  amount: string;
  rangeStrategy: RangeStrategy;
  /** Percent string, e.g. "0.5" for 0.5%. Blank = default. */
  slippagePercent: string;
}

export interface ValidateEnterResult {
  issues: LpEnterFieldIssue[];
  /** Non-null only when the draft is worth sending. */
  request: LpEnterRequest | null;
}

/**
 * Client-side pre-flight. Returns every problem at once (like the policy
 * validator) so the form reads as a single incomplete state rather than one
 * error at a time, plus the ready request when nothing is wrong.
 */
export function validateEnterForm(
  values: LpEnterFormValues,
  pool: LpEnterPool | null,
): ValidateEnterResult {
  const issues: LpEnterFieldIssue[] = [];

  if (!values.poolAddress.trim() || !pool) {
    issues.push({ field: 'poolAddress', message: 'Select a pool.' });
  }

  let tokenIn: LpEnterPoolToken | null = null;
  let tokenInAddress: string | null = null;
  if (pool) {
    const needle = normalizeAddress(values.tokenInAddress);
    if (!needle) {
      issues.push({ field: 'tokenInAddress', message: 'Select the token to deposit.' });
    } else {
      tokenIn = resolveDepositToken(pool, needle);
      if (!tokenIn) {
        issues.push({ field: 'tokenInAddress', message: 'Token must be one of the pool’s two tokens or native ETH (WETH pools).' });
      } else {
        tokenInAddress = isNativeEthTokenIn(needle) ? NATIVE_ETH_ADDRESS : tokenIn.address;
      }
    }
  }

  let amountIn: string | null = null;
  if (tokenIn) {
    const converted = toBaseUnits(values.amount, tokenIn.decimals);
    if (!converted.ok) issues.push({ field: 'amount', message: converted.error });
    else amountIn = converted.value;
  } else if (values.amount.trim() === '') {
    // Surface the empty-amount error even before a token is chosen, so the form
    // reads as incomplete rather than silently blocking submit.
    issues.push({ field: 'amount', message: 'Enter an amount.' });
  }

  const slippage = parseSlippagePercent(values.slippagePercent);
  let swapSlippage = DEFAULT_SWAP_SLIPPAGE;
  if (!slippage.ok) issues.push({ field: 'swapSlippage', message: slippage.error });
  else swapSlippage = slippage.fraction;

  if (!RANGE_STRATEGIES.includes(values.rangeStrategy)) {
    issues.push({ field: 'rangeStrategy', message: "Range must be 'narrow', 'wide' or 'full'." });
  }

  if (issues.length > 0 || !pool || !tokenIn || amountIn === null || !tokenInAddress) {
    return { issues, request: null };
  }

  return {
    issues,
    request: {
      poolAddress: pool.address,
      tokenInAddress,
      amountIn,
      rangeStrategy: values.rangeStrategy,
      swapSlippage,
    },
  };
}

/** First message per field — the form renders one error under each input. */
export function enterIssuesByField(issues: readonly LpEnterFieldIssue[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const issue of issues) if (!(issue.field in map)) map[issue.field] = issue.message;
  return map;
}

const ENTER_STATUSES = new Set(['pending', 'claimed', 'done', 'failed', 'skipped']);

/**
 * Parses the created command view. Unlike `parseCommand`, it tolerates a null
 * `token_id` (every enter has one) — the enter row is identified by its own id,
 * not by a position it does not yet have.
 */
export function parseEnterCommand(raw: unknown): LpEnterCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const nested = 'command' in record ? record.command : record;
  if (!nested || typeof nested !== 'object') return null;
  const r = nested as Record<string, unknown>;

  const id = typeof r.id === 'string' && r.id.trim() !== '' ? r.id : null;
  if (!id) return null;

  const statusRaw = typeof r.status === 'string' ? r.status : 'unknown';
  const status = (
    ENTER_STATUSES.has(statusRaw) ? statusRaw : 'unknown'
  ) as LpEnterCommand['status'];

  return {
    id,
    status,
    requestedAt: typeof r.requestedAt === 'string' ? r.requestedAt : null,
    txHash: typeof r.txHash === 'string' && r.txHash.trim() !== '' ? r.txHash : null,
    error: typeof r.error === 'string' && r.error.trim() !== '' ? r.error : null,
  };
}
