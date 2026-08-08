// Shared click-to-sort primitives, extracted from RadarTable so the Radar and the
// three pump.fun tables sort the same way instead of each hand-rolling a compare.
//
// Split by concern: the PURE pieces live here (a display-string parser and two
// direction-aware comparators, all unit-tested in frontend/test/sort.test.ts), the
// React `useSort` state hook lives in hooks/useSort.ts, and the header UI lives in
// components/common/SortHeader.tsx. Keeping the comparators pure is deliberate —
// they are the part a bug hides in (nulls, direction, "$18M" sorting as a string),
// so they must be testable without a DOM.

/** Ascending or descending — the two states a sortable column toggles between. */
export type SortDir = 'asc' | 'desc';

/**
 * Parse a display-formatted number back to its value so a column sorts by MAGNITUDE
 * rather than lexically ("$18M" must outrank "$9M", which string order gets wrong).
 * Handles the shapes the pump/radar cells render: a leading `$`, thousands commas, a
 * K/M/B magnitude suffix, a trailing `x` multiplier, and a leading +/- sign. A raw
 * number passes straight through, and anything unreadable (an em dash, blank, junk)
 * is null — never 0, which would sort a missing value as the smallest real one.
 */
export function parseCompactNumber(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value == null) return null;
  let s = value.trim();
  if (s === '' || s === '—' || s === '-') return null;

  let sign = 1;
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('-')) {
    sign = -1;
    s = s.slice(1);
  }

  // Drop currency, grouping commas and any stray spaces before reading the suffix.
  s = s.replace(/[$,\s]/g, '');

  let mult = 1;
  const suffix = s.slice(-1).toLowerCase();
  if (suffix === 'k') {
    mult = 1e3;
    s = s.slice(0, -1);
  } else if (suffix === 'm') {
    mult = 1e6;
    s = s.slice(0, -1);
  } else if (suffix === 'b') {
    mult = 1e9;
    s = s.slice(0, -1);
  } else if (suffix === 'x') {
    // A multiplier like "1.12x" — the number is the value, the x is just the unit.
    s = s.slice(0, -1);
  }

  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return sign * n * mult;
}

/**
 * Compare two values as numbers for a sorted column. Accepts a raw number OR a
 * display string (coerced via parseCompactNumber), so a caller may sort by the same
 * formatted text a cell shows without the sort going lexical. A missing value sorts
 * as -Infinity — i.e. it always sinks to the low end (bottom on desc, top on asc),
 * matching the Radar's long-standing behaviour where a blank market cap ranks last.
 */
export function compareNumeric(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
  dir: SortDir,
): number {
  const sign = dir === 'asc' ? 1 : -1;
  const av = parseCompactNumber(a) ?? -Infinity;
  const bv = parseCompactNumber(b) ?? -Infinity;
  if (av === bv) return 0;
  return av < bv ? -sign : sign;
}

/**
 * Compare two values as case-insensitive text for a sorted column. A null/undefined
 * value collapses to the empty string so it sorts first ascending, rather than
 * throwing on `.toLowerCase()`.
 */
export function compareText(
  a: string | null | undefined,
  b: string | null | undefined,
  dir: SortDir,
): number {
  const sign = dir === 'asc' ? 1 : -1;
  const av = (a ?? '').toLowerCase();
  const bv = (b ?? '').toLowerCase();
  if (av === bv) return 0;
  return av < bv ? -sign : sign;
}

/** One sortable column: its key, whether it compares as a number or as text, and how
 *  to pull its value out of a row. */
export interface SortColumn<T, K extends string> {
  key: K;
  type: 'numeric' | 'text';
  get: (row: T) => string | number | null | undefined;
}

/**
 * Sort a copy of `rows` by the active column, breaking ties with an optional
 * secondary comparator (e.g. always newest-first) so equal cells land in a stable,
 * meaningful order rather than input order. Returns a new array — never mutates the
 * caller's list, which is usually React state or a memo result.
 */
export function sortRows<T, K extends string>(
  rows: readonly T[],
  columns: readonly SortColumn<T, K>[],
  sortKey: K,
  sortDir: SortDir,
  tiebreak?: (a: T, b: T) => number,
): T[] {
  const col = columns.find((c) => c.key === sortKey);
  const out = [...rows];
  out.sort((a, b) => {
    let result = 0;
    if (col) {
      result =
        col.type === 'numeric'
          ? compareNumeric(col.get(a), col.get(b), sortDir)
          : compareText(col.get(a) as string | null | undefined, col.get(b) as string | null | undefined, sortDir);
    }
    if (result !== 0) return result;
    return tiebreak ? tiebreak(a, b) : 0;
  });
  return out;
}
