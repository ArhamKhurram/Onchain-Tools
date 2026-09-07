// The bot's view of the per-user market-cap filters — labels, formatting, the
// button ladder, and the parse. Pure: no I/O, no clock, no module state.
//
// ONE SOURCE OF TRUTH, AND THIS FILE IS NOT IT. Every bound, every direction,
// every unit and every LABEL is read out of `mcapCross/filters.ts` at call
// time. Nothing here restates a threshold, and nothing here decides whether a
// value is acceptable: `parseFilterValue` asks `validateFilterPatch` — the same
// function `PUT /api/mcap-cross/filters` asks — and returns its errors
// verbatim. A number the console refuses is a number Telegram refuses, with the
// same sentence, because it is literally the same sentence.
//
// AND THE KEY LIST IS NOT ENUMERATED EITHER. Everything iterates
// `MCAP_CROSS_FILTER_KEYS`, so a filter added to that table appears in the
// panel, in `/filters`, in the ladder and in the help text with no edit here.
// That is not tidiness — there is a second agent adding fields to that module
// right now, and a hardcoded list of four would have silently hidden them.
//
// WHY A LADDER OF PRESET VALUES AND NOT A TYPED NUMBER. An inline keyboard has
// no text input; a button is the only thing a panel can offer. So the panel
// offers a ladder and the TYPED command (`/filters <key> <value>`) offers the
// full range — the same split the alerts card and `/alerts` already have. The
// ladder is generated from the unit and then FILTERED THROUGH THE VALIDATOR, so
// a candidate that a bound would reject is never rendered as a button. That is
// what keeps it correct for keys this file has never heard of.

import {
  MCAP_CROSS_FILTER_BOUNDS,
  MCAP_CROSS_FILTER_KEYS,
  validateFilterPatch,
  type McapCrossFilterKey,
  type McapCrossFilters,
} from '../mcapCross/filters.js';

export { MCAP_CROSS_FILTER_KEYS };
export type { McapCrossFilterKey, McapCrossFilters };

/** Untrusted string → a key of the filter table, or null. */
export function asFilterKey(value: string | null | undefined): McapCrossFilterKey | null {
  if (typeof value !== 'string') return null;
  const wanted = value.trim().toLowerCase();
  for (const key of MCAP_CROSS_FILTER_KEYS) {
    if (key.toLowerCase() === wanted) return key;
  }
  return null;
}

/** The table's own label. Never a second wording of it. */
export function filterLabel(key: McapCrossFilterKey): string {
  return MCAP_CROSS_FILTER_BOUNDS[key].label;
}

/**
 * A value as a person reads it, decided by the table's `unit`.
 *
 * Fractions are shown as percentages because nobody thinks in 0.02 — but they
 * are only ever SHOWN that way. Everything that crosses a boundary (the wire,
 * the store, the validator, `/filters`) stays a fraction, so there is no unit
 * conversion for a future reader to get backwards.
 */
export function formatFilterValue(key: McapCrossFilterKey, value: number): string {
  const bounds = MCAP_CROSS_FILTER_BOUNDS[key];
  if (bounds.unit === 'fraction') return `${Number((value * 100).toFixed(4))}%`;
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

/**
 * Candidate rungs per unit, before validation.
 *
 * Chosen to span the range a person actually tunes over rather than the range
 * the bounds ALLOW (`minLiquidityUsd` permits up to a billion; nobody sets
 * that from a phone). Anything outside a rung is what the typed command is for.
 */
const CANDIDATES: Record<'usd' | 'fraction', readonly number[]> = {
  usd: [1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000],
  fraction: [0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75],
};

/**
 * The offered values for one key.
 *
 * The validator, not this file, has the last word: a rung that
 * `validateFilterPatch` would reject (out of range, or zero on a ceiling where
 * zero is a mute switch) is dropped rather than rendered as a button that
 * errors when pressed.
 */
export function filterLadder(key: McapCrossFilterKey): number[] {
  const bounds = MCAP_CROSS_FILTER_BOUNDS[key];
  const candidates = CANDIDATES[bounds.unit] ?? [];
  return candidates.filter((value) => validateFilterPatch({ [key]: value }).ok);
}

export type FilterValueParse =
  | { ok: true; value: number | null }
  | { ok: false; errors: string[] };

/** The words that mean "clear my override and inherit the default again". */
const INHERIT_WORDS = new Set(['inherit', 'default', 'clear', 'reset', 'none', 'off', '-']);

/**
 * Parse one `<key> <value>` assignment from a command or a button.
 *
 * `null` on success means "clear the override" — the only way to un-set a
 * filter, and the reason the stored shape is a partial. Every other outcome is
 * the shared validator's verdict, errors included; this function invents no
 * message of its own about a range.
 */
export function parseFilterValue(key: McapCrossFilterKey, raw: string): FilterValueParse {
  const text = raw.trim();
  if (text === '') return { ok: false, errors: ['Give a value, or "inherit" to clear it.'] };
  if (INHERIT_WORDS.has(text.toLowerCase())) return { ok: true, value: null };

  // A percent sign is accepted on a fraction field and converted here, at the
  // one boundary where a human is typing. `5%` and `0.05` are the same value;
  // a bare `5` is not, and is rejected by the bounds rather than guessed at.
  const bounds = MCAP_CROSS_FILTER_BOUNDS[key];
  const percent = bounds.unit === 'fraction' && text.endsWith('%');
  const numeric = Number(percent ? text.slice(0, -1).trim() : text.replace(/[$,_]/g, ''));
  if (!Number.isFinite(numeric)) {
    return { ok: false, errors: [`${bounds.label} must be a finite number`] };
  }

  const value = percent ? numeric / 100 : numeric;
  const verdict = validateFilterPatch({ [key]: value });
  if (!verdict.ok) return { ok: false, errors: verdict.errors };
  return { ok: true, value };
}

/**
 * What one filter reads as right now, for a card or a command reply.
 *
 * `effective` and `defaults` are the resolved gate configs; they are indexed by
 * the same key names, which is why they arrive as records rather than as the
 * typed config — a key added to the filter table exists on both without this
 * module knowing its name.
 */
export interface FilterLine {
  key: McapCrossFilterKey;
  label: string;
  /** The value in force, formatted. */
  value: string;
  /** True when the bound account set it; false when it is inherited. */
  overridden: boolean;
  /** What clearing the override would fall back to, formatted. */
  inherited: string;
}

export function filterLines(
  stored: McapCrossFilters,
  effective: Record<string, unknown>,
  defaults: Record<string, unknown>,
): FilterLine[] {
  return MCAP_CROSS_FILTER_KEYS.map((key) => {
    const own = stored[key];
    const live = typeof effective[key] === 'number' ? (effective[key] as number) : undefined;
    const base = typeof defaults[key] === 'number' ? (defaults[key] as number) : undefined;
    return {
      key,
      label: filterLabel(key),
      // A gate config that has no such field is a filter the operator's
      // baseline does not know about yet — rendered as unknown rather than as
      // a confident zero.
      value: live === undefined ? 'unknown' : formatFilterValue(key, live),
      overridden: own !== undefined,
      inherited: base === undefined ? 'unknown' : formatFilterValue(key, base),
    };
  });
}
