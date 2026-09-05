import { describe, it, expect } from 'vitest';
import {
  buildDroppedLookup,
  droppedAmong,
  droppedCount,
  isDropped,
  normDroppedKey,
  EMPTY_DROPPED_LOOKUP,
} from '../src/lib/droppedRoster';

// The "not live" badge is only as honest as this lookup. Two things matter:
// key folding must match the backend planner (j7/rosterPlan.ts `norm`) so a
// handle the user typed as @Ansem still matches j7's "ansem", and a missing or
// malformed payload must degrade to "nothing dropped" rather than throw on a
// tab that otherwise renders fine.

const WALLET = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

const payload = {
  pump: [
    { key: WALLET, followerCount: 2 },
    { key: 'So11111111111111111111111111111111111111112', followerCount: 1 },
  ],
  fomo: [{ key: 'Ansem', followerCount: 3 }],
  at: '2026-09-04T10:00:00.000Z',
};

describe('normDroppedKey', () => {
  it('trims and case-folds, matching the backend planner', () => {
    expect(normDroppedKey('  Ansem ')).toBe('ansem');
    expect(normDroppedKey(WALLET)).toBe(WALLET.toLowerCase());
  });
});

describe('buildDroppedLookup', () => {
  it('indexes both trackers by folded key and keeps the timestamp', () => {
    const lookup = buildDroppedLookup(payload);
    expect(lookup.pump.size).toBe(2);
    expect(lookup.fomo.size).toBe(1);
    expect(lookup.at).toBe('2026-09-04T10:00:00.000Z');
    expect(lookup.fomo.get('ansem')).toEqual({ key: 'Ansem', followerCount: 3 });
  });

  it('degrades a null / partial / junk payload to an empty lookup', () => {
    expect(buildDroppedLookup(null)).toBe(EMPTY_DROPPED_LOOKUP);
    expect(buildDroppedLookup(undefined)).toBe(EMPTY_DROPPED_LOOKUP);
    const partial = buildDroppedLookup({ pump: [{ key: WALLET, followerCount: 1 }] });
    expect(partial.pump.size).toBe(1);
    expect(partial.fomo.size).toBe(0);
    expect(partial.at).toBeNull();
    // Rows without a usable key are skipped, not indexed under "".
    const junk = buildDroppedLookup({
      pump: [{ key: '', followerCount: 1 }, { key: '   ', followerCount: 1 }, null as never],
      fomo: [],
      at: 42 as never,
    });
    expect(junk.pump.size).toBe(0);
    expect(junk.at).toBeNull();
  });
});

describe('isDropped', () => {
  const lookup = buildDroppedLookup(payload);

  it('matches a pump wallet exactly and case-insensitively', () => {
    expect(isDropped(lookup, 'pump', WALLET)).toBe(true);
    expect(isDropped(lookup, 'pump', WALLET.toLowerCase())).toBe(true);
  });

  it('matches a fomo handle regardless of the casing the user typed', () => {
    expect(isDropped(lookup, 'fomo', 'ansem')).toBe(true);
    expect(isDropped(lookup, 'fomo', 'ANSEM')).toBe(true);
    expect(isDropped(lookup, 'fomo', ' Ansem ')).toBe(true);
  });

  it('keeps the two key spaces apart', () => {
    // A wallet is never a fomo handle and vice versa — no cross-tracker bleed.
    expect(isDropped(lookup, 'fomo', WALLET)).toBe(false);
    expect(isDropped(lookup, 'pump', 'ansem')).toBe(false);
  });

  it('never flags a null / empty / unknown key', () => {
    expect(isDropped(lookup, 'pump', null)).toBe(false);
    expect(isDropped(lookup, 'pump', undefined)).toBe(false);
    expect(isDropped(lookup, 'pump', '')).toBe(false);
    expect(isDropped(lookup, 'fomo', 'nobody')).toBe(false);
    expect(isDropped(EMPTY_DROPPED_LOOKUP, 'pump', WALLET)).toBe(false);
  });
});

describe('droppedCount / droppedAmong', () => {
  const lookup = buildDroppedLookup(payload);

  it('counts per tracker and in total', () => {
    expect(droppedCount(lookup, 'pump')).toBe(2);
    expect(droppedCount(lookup, 'fomo')).toBe(1);
    expect(droppedCount(lookup)).toBe(3);
  });

  it('returns only the caller-supplied items that are dropped, in their order', () => {
    const roster = [
      { callerAddress: 'notDropped111111111111111111111111111111111' },
      { callerAddress: WALLET },
      { callerAddress: 'So11111111111111111111111111111111111111112' },
    ];
    const out = droppedAmong(lookup, 'pump', roster, (r) => r.callerAddress);
    expect(out.map((r) => r.callerAddress)).toEqual([WALLET, 'So11111111111111111111111111111111111111112']);
  });
});
