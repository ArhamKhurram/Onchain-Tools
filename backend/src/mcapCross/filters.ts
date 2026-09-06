/**
 * PER-USER market-cap-crossing filters — the editable half of `gates.ts`.
 *
 * WHAT THIS IS. `gates.ts` holds one process-wide threshold set, read from
 * env (`OCT_MCAP_CROSS_*`). That is the OPERATOR's baseline. This module adds a
 * second, per-user layer on top of it, the way GMGN and Axiom let a trader
 * narrow (or widen) a token list without touching anyone else's: each user
 * stores only the thresholds they have deliberately changed, and everything
 * else is inherited.
 *
 * PRECEDENCE, IN ONE LINE:
 *
 *     per-user value (when explicitly set)  →  env var  →  hardcoded default
 *
 * The env layer is therefore NOT dead code — it is the default a user who has
 * set nothing sees, so an existing deployment behaves exactly as it did before
 * this file existed. `resolveUserGateConfig(null)` is required by test to equal
 * `resolveGateConfig()`.
 *
 * WHAT IS DELIBERATELY *NOT* EDITABLE
 *
 * 1. `requireLpSecured`. Turning it OFF does not merely relax a number — it
 *    converts an ABSTAIN into a PASS. `missingCriticalFields` abstains when
 *    `lpSecured` is null precisely because "GMGN has no record of this LP" is
 *    not "this LP is fine"; with the flag off that unknown silently becomes a
 *    delivered alert. Every user-editable knob in this file is a NUMBER
 *    compared against a non-null field, which structurally cannot manufacture
 *    confidence out of a null. The boolean can, so it stays operator-only.
 *
 * 2. `targetMcapUsd`. The 750K crossing is detected against ONE stored
 *    `lastSeenMcap` per token (mcapCross/state.ts) — a transition, not a level
 *    test. A per-user target would need per-user crossing state over the whole
 *    universe, which is the one thing the cost model cannot afford. It stays
 *    global and is surfaced read-only in the console.
 *
 * TAX IS AN EVM CONCEPT AND THE FILTER INHERITS THAT. `maxTaxRate` is compared
 * only inside the EVM branch of `evaluateMcapGates`, and `normalizeSecurity`
 * hard-nulls `buyTax`/`sellTax` on Solana because a transfer-tax honeypot
 * cannot exist there. So a user who drags the tax threshold down to 1% narrows
 * BNB and Robinhood and changes nothing at all about Solana — it can never
 * silently mute a chain where the metric is meaningless. The unit tests pin
 * that.
 *
 * A BAD STORED VALUE MUST NEVER DISABLE A GATE. `sanitizeStoredFilters` runs on
 * every READ, not just on write: a value that arrived by some other route (a
 * hand-edited local JSON file, an imported config, a future bug) is DROPPED and
 * the field falls back to the env/default value. Dropping is the safe
 * direction — the gate keeps running at the operator's baseline — where
 * coercing (`Number(x) || 0`) would turn a typo into an open gate.
 */

import { DEFAULT_GATE_CONFIG, resolveGateConfig, type McapGateConfig } from './gates.js';

/**
 * The four user-editable thresholds. Every key is optional; ABSENT means
 * "inherit", which is not the same as any particular number. Rates are
 * fractions, never percents — 0.05 is 5%. The direction is baked into the
 * name: `min*` is a floor, `max*` is a ceiling.
 *
 * Declared here rather than in `@oct/shared` because it is not shared STATE —
 * the console reaches it only through `/api/mcap-cross/filters`, which returns
 * a resolved view rather than an AppConfig slice. The console's mirror of this
 * shape lives beside its settings section.
 */
export interface McapCrossFilters {
  /** MINIMUM pooled USD. Below it the move is unexitable. */
  minLiquidityUsd?: number;
  /** MINIMUM liquidity / market cap. Catches the fake-mcap shape. */
  minLiquidityToMcapRatio?: number;
  /** MAXIMUM top-10 holder concentration. */
  maxTop10HolderRate?: number;
  /** MAXIMUM buy tax and sell tax, each. EVM only; inert on Solana. */
  maxTaxRate?: number;
}

/** The editable keys, in display order. Exhaustive by construction. */
export const MCAP_CROSS_FILTER_KEYS = [
  'minLiquidityUsd',
  'minLiquidityToMcapRatio',
  'maxTop10HolderRate',
  'maxTaxRate',
] as const;

export type McapCrossFilterKey = (typeof MCAP_CROSS_FILTER_KEYS)[number];

/**
 * The accepted range per key, and the direction the threshold points.
 *
 * The bounds are not decoration. `maxTop10HolderRate` and `maxTaxRate` are
 * fractions, so anything above 1 is a user who typed "10" meaning 10% — storing
 * it would open the gate completely while looking like a tightening. Rejecting
 * is the only honest answer; silently dividing by 100 would be a guess about
 * what somebody meant.
 */
export const MCAP_CROSS_FILTER_BOUNDS: Record<
  McapCrossFilterKey,
  { min: number; max: number; direction: 'min' | 'max'; unit: 'usd' | 'fraction'; label: string }
> = {
  minLiquidityUsd: {
    min: 0,
    max: 1e9,
    direction: 'min',
    unit: 'usd',
    label: 'Min liquidity',
  },
  minLiquidityToMcapRatio: {
    min: 0,
    max: 1,
    direction: 'min',
    unit: 'fraction',
    label: 'Min liquidity / market cap',
  },
  maxTop10HolderRate: {
    // A ceiling of 0 would reject every token that has any holders at all, i.e.
    // all of them; it is a mute switch wearing a threshold's clothes. The
    // exclusive lower bound is enforced by EXCLUSIVE_ZERO below.
    min: 0,
    max: 1,
    direction: 'max',
    unit: 'fraction',
    label: 'Max top-10 holder concentration',
  },
  maxTaxRate: {
    min: 0,
    max: 1,
    direction: 'max',
    unit: 'fraction',
    label: 'Max buy/sell tax (EVM only)',
  },
};

/** Ceilings may not be zero: a zero ceiling mutes rather than filters. */
const EXCLUSIVE_ZERO: ReadonlySet<McapCrossFilterKey> = new Set([
  'maxTop10HolderRate',
  'maxTaxRate',
]);

function isAcceptable(key: McapCrossFilterKey, value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  const bounds = MCAP_CROSS_FILTER_BOUNDS[key];
  if (value < bounds.min || value > bounds.max) return false;
  if (EXCLUSIVE_ZERO.has(key) && value <= 0) return false;
  return true;
}

/**
 * Coerce whatever is on disk into a filter set we are willing to apply.
 *
 * Anything unrecognised, non-finite, out of range or of the wrong type is
 * dropped — never clamped and never coerced. A dropped key inherits the
 * operator baseline, which is the strictly safer failure.
 */
export function sanitizeStoredFilters(input: unknown): McapCrossFilters {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const raw = input as Record<string, unknown>;
  const out: McapCrossFilters = {};
  for (const key of MCAP_CROSS_FILTER_KEYS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (!isAcceptable(key, value)) continue;
    out[key] = value;
  }
  return out;
}

export type FilterPatchResult =
  | { ok: true; value: McapCrossFilters }
  | { ok: false; errors: string[] };

/**
 * Validate a patch arriving from an HTTP body. Unlike `sanitizeStoredFilters`
 * this REJECTS rather than drops: a user who typed 150 into "max tax" must be
 * told, not quietly ignored.
 *
 * `null` for a key means "clear this override and go back to inheriting" — the
 * only way to un-set a filter, and the reason the stored shape is a partial.
 */
export function validateFilterPatch(input: unknown): FilterPatchResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['Filters must be an object'] };
  }
  const raw = input as Record<string, unknown>;
  const errors: string[] = [];
  const value: McapCrossFilters = {};

  for (const key of Object.keys(raw)) {
    if (!(MCAP_CROSS_FILTER_KEYS as readonly string[]).includes(key)) {
      errors.push(`Unknown filter "${key}"`);
    }
  }

  for (const key of MCAP_CROSS_FILTER_KEYS) {
    const candidate = raw[key];
    // Absent = leave whatever is stored alone. Explicit null = clear it.
    if (candidate === undefined || candidate === null) continue;

    const bounds = MCAP_CROSS_FILTER_BOUNDS[key];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
      errors.push(`${bounds.label} must be a finite number`);
      continue;
    }
    if (!isAcceptable(key, candidate)) {
      const lo = EXCLUSIVE_ZERO.has(key) ? `greater than ${bounds.min}` : `at least ${bounds.min}`;
      errors.push(
        bounds.unit === 'fraction'
          ? `${bounds.label} must be a fraction ${lo} and at most ${bounds.max} (0.05 = 5%)`
          : `${bounds.label} must be ${lo} and at most ${bounds.max}`,
      );
      continue;
    }
    value[key] = candidate;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/**
 * Apply a validated patch to the stored set. Explicit `null` clears a key back
 * to inheritance; an absent key is untouched.
 */
export function applyFilterPatch(
  stored: McapCrossFilters,
  rawPatch: Record<string, unknown>,
  validated: McapCrossFilters,
): McapCrossFilters {
  const next: McapCrossFilters = { ...stored };
  for (const key of MCAP_CROSS_FILTER_KEYS) {
    if (rawPatch[key] === null) delete next[key];
    else if (validated[key] !== undefined) next[key] = validated[key];
  }
  return next;
}

/**
 * per-user → env → hardcoded default, in exactly that order.
 *
 * `resolveGateConfig()` already collapses the bottom two layers, so this is the
 * one place the top layer is applied. `requireLpSecured` is copied straight
 * through from the baseline because it is not user-editable — see the header.
 */
export function resolveUserGateConfig(
  stored: McapCrossFilters | null | undefined,
  baseline: McapGateConfig = resolveGateConfig(),
): McapGateConfig {
  const clean = sanitizeStoredFilters(stored ?? {});
  return {
    minLiquidityUsd: clean.minLiquidityUsd ?? baseline.minLiquidityUsd,
    minLiquidityToMcapRatio: clean.minLiquidityToMcapRatio ?? baseline.minLiquidityToMcapRatio,
    maxTop10HolderRate: clean.maxTop10HolderRate ?? baseline.maxTop10HolderRate,
    maxTaxRate: clean.maxTaxRate ?? baseline.maxTaxRate,
    requireLpSecured: baseline.requireLpSecured,
  };
}

/**
 * What the console renders: the user's own overrides, what each field actually
 * resolves to right now, and the operator baseline they are measured against.
 */
export interface McapCrossFilterView {
  filters: McapCrossFilters;
  effective: McapGateConfig;
  /** env then default, i.e. what an unset field inherits. */
  defaults: McapGateConfig;
  /** Hardcoded fallbacks, for a "reset to shipped values" affordance. */
  shipped: McapGateConfig;
  /** Global, operator-only. Read-only in the console — see the header. */
  targetMcapUsd: number;
}

export { DEFAULT_GATE_CONFIG };
