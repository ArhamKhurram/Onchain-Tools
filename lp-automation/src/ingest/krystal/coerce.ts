// Defensive coercion primitives for Krystal API responses.
//
// WHY THIS FILE EXISTS: Krystal returns numbers as strings ("4791.63651"),
// decimals as strings ("18"), and legitimately-empty fields as "" rather than
// null (`token0.usdPrice` is `""` on every pool we sampled from chain 4663).
//
// JavaScript's implicit coercions turn every one of those into a plausible-
// looking number:
//
//     Number('')    === 0
//     Number(null)  === 0
//     Number([])    === 0
//     Number(true)  === 1
//     parseFloat('12abc') === 12
//
// A TVL of 0 or an APR of 0 that came from a missing field is indistinguishable
// downstream from a real 0, and it flows straight into the net-efficiency score
// that authorises a spend. So nothing in the mappers may use `Number()`,
// `parseFloat()`, or `+x` directly — everything goes through here, and a value
// that is not unambiguously a finite number raises `KrystalFieldError`.
//
// See LP_AUTOMATION_PLAN.md §6 (rule evaluator) for what consumes these values.

import type { Address } from '../../types.js';

/** Raised when a Krystal field is missing, null, or not coercible without guessing. */
export class KrystalFieldError extends Error {
  readonly path: string;
  readonly received: unknown;

  constructor(path: string, received: unknown, detail: string) {
    super(`Krystal field "${path}" ${detail} (received: ${describe(received)})`);
    this.name = 'KrystalFieldError';
    this.path = path;
    this.received = received;
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object') return Array.isArray(value) ? `array(${value.length})` : 'object';
  return String(value);
}

/** Narrow an unknown to a plain record, or throw. */
export function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KrystalFieldError(path, value, 'is not an object');
  }
  return value as Record<string, unknown>;
}

/** Narrow an unknown to an array, or throw. */
export function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new KrystalFieldError(path, value, 'is not an array');
  return value;
}

/** A non-empty string. Empty strings are rejected — Krystal uses "" for "absent". */
export function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new KrystalFieldError(path, value, 'is not a string');
  if (value.length === 0) throw new KrystalFieldError(path, value, 'is an empty string');
  return value;
}

/** Returns undefined (never a fabricated default) when the field is absent or "". */
export function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value;
}

const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * A finite number, accepting Krystal's string-typed numerics.
 *
 * Deliberately stricter than `Number()`: booleans, null, arrays, empty strings
 * and partially-numeric strings ("12abc") are all errors rather than 0/1/12.
 */
export function requireFiniteNumber(value: unknown, path: string): number {
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

/** A finite number that must not be negative (TVL, volume, USD values). */
export function requireNonNegativeNumber(value: unknown, path: string): number {
  const n = requireFiniteNumber(value, path);
  if (n < 0) throw new KrystalFieldError(path, value, 'is negative');
  return n;
}

/** A safe integer, accepting Krystal's string-typed integers ("18" for decimals). */
export function requireInteger(value: unknown, path: string): number {
  const n = requireFiniteNumber(value, path);
  if (!Number.isInteger(n)) throw new KrystalFieldError(path, value, 'is not an integer');
  if (!Number.isSafeInteger(n)) throw new KrystalFieldError(path, value, 'exceeds safe integer range');
  return n;
}

/** ERC-20 decimals: an integer in [0, 36]. Anything else is a data bug, not a token. */
export function requireDecimals(value: unknown, path: string): number {
  const n = requireInteger(value, path);
  if (n < 0 || n > 36) throw new KrystalFieldError(path, value, 'is not a plausible decimals value');
  return n;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * A 20-byte hex address, normalised to lowercase.
 *
 * Krystal is inconsistent about casing within a single response — `txData.to`
 * comes back lowercase while `txData.from` and `txInfo.swapAmount0.srcToken`
 * come back EIP-55 checksummed. Normalising on ingest (per types.ts) means
 * downstream allowlist comparisons can be plain string equality.
 */
export function requireAddress(value: unknown, path: string): Address {
  if (typeof value !== 'string') throw new KrystalFieldError(path, value, 'is not a string');
  if (!ADDRESS.test(value)) throw new KrystalFieldError(path, value, 'is not a 20-byte hex address');
  return value.toLowerCase() as Address;
}

/** Normalise an address that is already known to be well-formed, or throw. */
export function normalizeAddress(value: string, path = 'address'): Address {
  return requireAddress(value, path);
}

/** Read a property, throwing with a path-qualified message if it is absent. */
export function prop(source: Record<string, unknown>, key: string, path: string): unknown {
  const value = source[key];
  if (value === undefined) throw new KrystalFieldError(`${path}.${key}`, undefined, 'is missing');
  return value;
}

/**
 * Krystal expresses fee tiers and APRs as PERCENT (`feeTier: 1` for a 1% pool,
 * `apr: 8806.02` for 8806%). `types.ts` wants APR as a fraction and fee tiers in
 * basis points, so the conversion happens once, here, rather than at each call
 * site where it could be forgotten.
 *
 * Verified on chain 4663 by reading `fee()` off the pool contracts directly:
 *   feeTier 1    -> on-chain fee 10000 (tickSpacing 200) -> 100 bps
 *   feeTier 0.3  -> on-chain fee  3000 (tickSpacing  60) ->  30 bps
 *   feeTier 0.05 -> on-chain fee   500 (tickSpacing  10) ->   5 bps
 *   feeTier 0.01 -> on-chain fee   100 (tickSpacing   1) ->   1 bps
 */
export function percentToBps(percent: number): number {
  // Round through integer micro-percent so 0.05 * 100 does not land on
  // 5.000000000000001. Uniswap V4 pools on 4663 do carry fractional tiers
  // (e.g. 3.995%), so the result is not forced to a whole number.
  return Math.round(percent * 1e6) / 1e4;
}

/** Percent (234.15) -> annualized fraction (2.3415), as `types.ts` specifies. */
export function percentToFraction(percent: number): number {
  return percent / 100;
}
