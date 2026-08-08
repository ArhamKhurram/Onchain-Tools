import { describe, it, expect } from 'vitest';
import {
  compareNumeric,
  compareText,
  parseCompactNumber,
  sortRows,
  type SortColumn,
} from '../src/lib/sort';

// The shared sort primitives back every click-to-sort table (Radar + the three
// pump.fun tables). Each `it` guards one concrete way a sort goes wrong: a compact
// display string sorting lexically instead of by value, a missing cell jumping to the
// top, or the direction flag being ignored. None touches a DOM.

describe('parseCompactNumber', () => {
  it('reads the compact display shapes the tables render', () => {
    // The bug this guards: sorting "$18M" and "$9M" as strings puts $18M first only
    // by luck of the '1' < '9' char order — parse to value so magnitude wins.
    expect(parseCompactNumber('$18M')).toBe(18_000_000);
    expect(parseCompactNumber('$17.83M')).toBe(17_830_000);
    expect(parseCompactNumber('$4.2K')).toBe(4_200);
    expect(parseCompactNumber('$2.50B')).toBe(2_500_000_000);
    expect(parseCompactNumber('$150')).toBe(150);
  });

  it('reads a multiplier and a signed, comma-grouped figure', () => {
    expect(parseCompactNumber('1.12x')).toBe(1.12);
    expect(parseCompactNumber('10x')).toBe(10);
    expect(parseCompactNumber('+$1.2K')).toBe(1_200);
    expect(parseCompactNumber('-$2.0M')).toBe(-2_000_000);
    expect(parseCompactNumber('2,500')).toBe(2_500);
  });

  it('passes a raw finite number straight through', () => {
    expect(parseCompactNumber(42)).toBe(42);
    expect(parseCompactNumber(-1.5)).toBe(-1.5);
  });

  it('returns null — never 0 — for a blank, an em dash, junk, or a non-finite number', () => {
    // The bug this guards: coercing a missing value to 0 would sort it as the
    // smallest REAL value instead of parking it at the missing end.
    expect(parseCompactNumber('')).toBeNull();
    expect(parseCompactNumber('—')).toBeNull();
    expect(parseCompactNumber('-')).toBeNull();
    expect(parseCompactNumber('nonsense')).toBeNull();
    expect(parseCompactNumber(null)).toBeNull();
    expect(parseCompactNumber(undefined)).toBeNull();
    expect(parseCompactNumber(Number.NaN)).toBeNull();
  });
});

describe('compareNumeric', () => {
  it('orders ascending and descending by value', () => {
    expect(compareNumeric(1, 2, 'asc')).toBeLessThan(0);
    expect(compareNumeric(1, 2, 'desc')).toBeGreaterThan(0);
    expect(compareNumeric(5, 5, 'asc')).toBe(0);
  });

  it('coerces compact display strings before comparing, so it is value-order not char-order', () => {
    // "$2M" must outrank "$900K" descending even though '2' < '9' as characters.
    expect(compareNumeric('$2M', '$900K', 'desc')).toBeLessThan(0);
    expect(compareNumeric('1.12x', '1.9x', 'asc')).toBeLessThan(0);
  });

  it('sinks a missing value to the low end in both directions', () => {
    // null reads as -Infinity: last on desc (a real value comes first), first on asc.
    expect(compareNumeric(null, 10, 'desc')).toBeGreaterThan(0);
    expect(compareNumeric(null, 10, 'asc')).toBeLessThan(0);
  });
});

describe('compareText', () => {
  it('orders case-insensitively in both directions', () => {
    expect(compareText('apple', 'Banana', 'asc')).toBeLessThan(0);
    expect(compareText('apple', 'Banana', 'desc')).toBeGreaterThan(0);
    expect(compareText('Same', 'same', 'asc')).toBe(0);
  });

  it('treats a null/undefined label as empty rather than throwing', () => {
    expect(compareText(null, 'x', 'asc')).toBeLessThan(0);
    expect(compareText(undefined, undefined, 'asc')).toBe(0);
  });
});

describe('sortRows', () => {
  interface Row {
    name: string;
    mcap: number | null;
    at: number;
  }
  const columns: readonly SortColumn<Row, 'name' | 'mcap'>[] = [
    { key: 'name', type: 'text', get: (r) => r.name },
    { key: 'mcap', type: 'numeric', get: (r) => r.mcap },
  ];
  const rows: Row[] = [
    { name: 'beta', mcap: 5, at: 3 },
    { name: 'alpha', mcap: null, at: 1 },
    { name: 'gamma', mcap: 20, at: 2 },
  ];

  it('does not mutate the input array', () => {
    const before = [...rows];
    sortRows(rows, columns, 'mcap', 'desc');
    expect(rows).toEqual(before);
  });

  it('sorts numeric descending with the missing value last', () => {
    const out = sortRows(rows, columns, 'mcap', 'desc');
    expect(out.map((r) => r.name)).toEqual(['gamma', 'beta', 'alpha']);
  });

  it('sorts text ascending', () => {
    const out = sortRows(rows, columns, 'name', 'asc');
    expect(out.map((r) => r.name)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('applies the tiebreak when the active column ties', () => {
    // Two rows with the same mcap fall back to the newest-first tiebreak (higher at).
    const tied: Row[] = [
      { name: 'x', mcap: 9, at: 1 },
      { name: 'y', mcap: 9, at: 2 },
    ];
    const out = sortRows(tied, columns, 'mcap', 'desc', (a, b) => b.at - a.at);
    expect(out.map((r) => r.name)).toEqual(['y', 'x']);
  });
});
