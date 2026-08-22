import { describe, it, expect } from 'vitest';
import { callerStatChips } from '../src/utils/callerBandStyle';
import type { CallerScore } from '@oct/shared';

// The inline per-row analytics for the Top Callers Feed. The numbers come
// straight off the persisted CallerScore, and the labels have to stay honest
// about being reach (share of calls that TOUCHED a multiple), not realized
// profit — hence the `≥` floor on the median.

function score(overrides: Partial<CallerScore> = {}): CallerScore {
  return {
    key: 'discord:1',
    displayName: 'caller',
    calls: 20,
    rated: 18,
    band: 'elite',
    hitRate2x: 0.42,
    hitRate5x: 0.15,
    medianMultiple: 2.5,
    bestMultiple: 12,
    slopRate: 0.1,
    ...overrides,
  };
}

describe('callerStatChips', () => {
  it('reads hit rates, scored-call count and median reach off the score', () => {
    const chips = callerStatChips(score());
    expect(chips.map((c) => c.label)).toEqual(['42% 2x', '15% 5x', '18 calls', '≥2.5× med']);
  });

  it('drops the 5x chip when a caller never touched 5x', () => {
    const chips = callerStatChips(score({ hitRate5x: 0 }));
    expect(chips.map((c) => c.label)).toEqual(['42% 2x', '18 calls', '≥2.5× med']);
  });

  it('singularises a one-call sample', () => {
    const chips = callerStatChips(score({ rated: 1, calls: 1 }));
    expect(chips.some((c) => c.label === '1 call')).toBe(true);
  });

  it('returns nothing when there is no scored history (e.g. a freshly trusted caller)', () => {
    expect(callerStatChips(score({ rated: 0 }))).toEqual([]);
    expect(callerStatChips(undefined)).toEqual([]);
  });

  it('every chip carries a reach-framed explanation, never a profit claim', () => {
    for (const chip of callerStatChips(score())) {
      expect(chip.title.length).toBeGreaterThan(0);
      expect(chip.title.toLowerCase()).not.toContain('profit made');
    }
  });
});
