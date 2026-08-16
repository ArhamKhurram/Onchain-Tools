import { describe, expect, it } from 'vitest';
import {
  DEX_PAIR_CAP,
  chunkMints,
  evaluateCrossing,
  snapshotsFromPairs,
  splitForRetry,
  valueForMetric,
  wasTruncated,
  type CrossingInput,
  type DexPair,
} from '../src/priceAlerts/crossing.js';

/**
 * Price alerts — the pure half. The operator failure this covers: a token
 * traded into their 100-150K buy band twice and they missed both fills. The
 * rules that make an alert trustworthy enough to act on are all here.
 */

function input(partial: Partial<CrossingInput>): CrossingInput {
  return {
    direction: 'above',
    targetUsd: 150_000,
    lastSeenUsd: 100_000,
    observedUsd: 120_000,
    ...partial,
  };
}

describe('evaluateCrossing — direction: above', () => {
  it('fires when the value moves from below the target to strictly above it', () => {
    const v = evaluateCrossing(input({ lastSeenUsd: 140_000, observedUsd: 151_000 }));
    expect(v.action).toBe('fire');
    expect(v.observedUsd).toBe(151_000);
  });

  it('records without firing while the value stays below the target', () => {
    expect(evaluateCrossing(input({ lastSeenUsd: 100_000, observedUsd: 140_000 })).action).toBe('record');
  });

  it('does not fire when the value merely SITS above the target (level test, not a crossing)', () => {
    // Already above last cycle and still above: the crossing happened before,
    // and it already fired then. Re-firing here would be a level test.
    expect(evaluateCrossing(input({ lastSeenUsd: 160_000, observedUsd: 170_000 })).action).toBe('record');
  });

  it('treats exactly-at-target as not yet crossed, then fires on the next tick above', () => {
    expect(evaluateCrossing(input({ lastSeenUsd: 140_000, observedUsd: 150_000 })).action).toBe('record');
    expect(evaluateCrossing(input({ lastSeenUsd: 150_000, observedUsd: 150_001 })).action).toBe('fire');
  });

  it('fires on a re-crossing after the value fell back below', () => {
    expect(evaluateCrossing(input({ lastSeenUsd: 120_000, observedUsd: 155_000 })).action).toBe('fire');
  });
});

describe('evaluateCrossing — direction: below', () => {
  it('fires when the value moves from at-or-above the target to strictly below it', () => {
    const v = evaluateCrossing(
      input({ direction: 'below', targetUsd: 100_000, lastSeenUsd: 110_000, observedUsd: 95_000 }),
    );
    expect(v.action).toBe('fire');
    expect(v.observedUsd).toBe(95_000);
  });

  it('fires from exactly at the target down through it', () => {
    expect(
      evaluateCrossing(
        input({ direction: 'below', targetUsd: 100_000, lastSeenUsd: 100_000, observedUsd: 99_999 }),
      ).action,
    ).toBe('fire');
  });

  it('does not fire while the value stays above the target', () => {
    expect(
      evaluateCrossing(
        input({ direction: 'below', targetUsd: 100_000, lastSeenUsd: 130_000, observedUsd: 110_000 }),
      ).action,
    ).toBe('record');
  });

  it('does not fire when the value merely sits below the target', () => {
    expect(
      evaluateCrossing(
        input({ direction: 'below', targetUsd: 100_000, lastSeenUsd: 80_000, observedUsd: 70_000 }),
      ).action,
    ).toBe('record');
  });
});

describe('evaluateCrossing — first-observation rule', () => {
  it('arms without firing on the first observation, even far past the target', () => {
    const v = evaluateCrossing(input({ lastSeenUsd: null, observedUsd: 900_000 }));
    expect(v.action).toBe('arm');
    expect(v.observedUsd).toBe(900_000);
  });

  it('arms without firing on the first observation of a below alert already under target', () => {
    const v = evaluateCrossing(
      input({ direction: 'below', targetUsd: 100_000, lastSeenUsd: null, observedUsd: 1_000 }),
    );
    expect(v.action).toBe('arm');
  });

  it('fires on the FIRST GENUINE crossing after the baseline was armed', () => {
    // Cycle 1 arms at 900K (above the 150K target). Cycle 2 sees it fall below,
    // cycle 3 sees it cross back up — that is the first real transition.
    expect(evaluateCrossing(input({ lastSeenUsd: null, observedUsd: 900_000 })).action).toBe('arm');
    expect(evaluateCrossing(input({ lastSeenUsd: 900_000, observedUsd: 120_000 })).action).toBe('record');
    expect(evaluateCrossing(input({ lastSeenUsd: 120_000, observedUsd: 160_000 })).action).toBe('fire');
  });
});

describe('evaluateCrossing — abstain on missing data', () => {
  it('abstains when there is no observation this cycle', () => {
    const v = evaluateCrossing(input({ lastSeenUsd: 140_000, observedUsd: null }));
    expect(v.action).toBe('abstain');
    // Nothing to persist: lastSeenUsd must survive the gap untouched.
    expect(v.observedUsd).toBeNull();
  });

  it('abstains on a non-finite or non-positive observation', () => {
    expect(evaluateCrossing(input({ observedUsd: Number.NaN })).action).toBe('abstain');
    expect(evaluateCrossing(input({ observedUsd: Number.POSITIVE_INFINITY })).action).toBe('abstain');
    expect(evaluateCrossing(input({ observedUsd: 0 })).action).toBe('abstain');
    expect(evaluateCrossing(input({ observedUsd: -5 })).action).toBe('abstain');
  });

  it('abstains on a non-finite target rather than guessing', () => {
    expect(evaluateCrossing(input({ targetUsd: Number.NaN })).action).toBe('abstain');
  });

  it('never fires across a data gap: the crossing is judged against the last REAL value', () => {
    // 140K → (gap, abstain, lastSeen stays 140K) → 155K still fires once.
    expect(evaluateCrossing(input({ lastSeenUsd: 140_000, observedUsd: null })).action).toBe('abstain');
    expect(evaluateCrossing(input({ lastSeenUsd: 140_000, observedUsd: 155_000 })).action).toBe('fire');
  });
});

describe('evaluateCrossing — one-shot', () => {
  it('a fired alert leaves the armed sweep, so the same crossing cannot re-fire', () => {
    // The poller only loads status='armed' rows and the repo update is guarded
    // on status='armed'. Once fired, the alert is simply not evaluated again —
    // there is no cooldown because there is no second evaluation. What the pure
    // detector guarantees is the other half: a value that stays past the target
    // never produces a second 'fire'.
    let last: number | null = 140_000;
    const first = evaluateCrossing(input({ lastSeenUsd: last, observedUsd: 151_000 }));
    expect(first.action).toBe('fire');
    last = first.observedUsd;
    for (const observed of [152_000, 160_000, 200_000]) {
      const v = evaluateCrossing(input({ lastSeenUsd: last, observedUsd: observed }));
      expect(v.action).toBe('record');
      last = v.observedUsd;
    }
  });
});

// --- DexScreener batch reads ------------------------------------------------

function pair(address: string, over: Partial<DexPair> = {}): DexPair {
  return {
    baseToken: { address, symbol: 'TKN' },
    liquidity: { usd: 10_000 },
    priceUsd: '0.001',
    marketCap: 100_000,
    ...over,
  };
}

describe('chunkMints', () => {
  it('splits into request-sized batches preserving order', () => {
    expect(chunkMints(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('clamps the batch size to the 1..30 the endpoint accepts', () => {
    expect(chunkMints(['a', 'b'], 0)).toEqual([['a'], ['b']]);
    expect(chunkMints(new Array(31).fill('a'), 999)).toHaveLength(2);
  });

  it('returns no batches for an empty watchlist (self-gating: zero requests)', () => {
    expect(chunkMints([], 10)).toEqual([]);
  });
});

describe('snapshotsFromPairs', () => {
  it('picks the deepest-liquidity pair for price and symbol', () => {
    const { snapshots } = snapshotsFromPairs(
      [
        pair('MINT_A', { liquidity: { usd: 100 }, priceUsd: '0.5', baseToken: { address: 'MINT_A', symbol: 'SHALLOW' } }),
        pair('MINT_A', { liquidity: { usd: 900_000 }, priceUsd: '0.9', baseToken: { address: 'MINT_A', symbol: 'DEEP' } }),
      ],
      ['MINT_A'],
    );
    expect(snapshots.get('MINT_A')?.priceUsd).toBe(0.9);
    expect(snapshots.get('MINT_A')?.symbol).toBe('DEEP');
  });

  it('falls back to fdv when the deepest pair has no marketCap', () => {
    const { snapshots } = snapshotsFromPairs(
      [pair('MINT_A', { marketCap: undefined, fdv: 250_000 })],
      ['MINT_A'],
    );
    expect(snapshots.get('MINT_A')?.mcapUsd).toBe(250_000);
  });

  it('takes the market cap from a shallower pair when the deepest reports none', () => {
    const { snapshots } = snapshotsFromPairs(
      [
        pair('MINT_A', { liquidity: { usd: 5 }, marketCap: 42_000 }),
        pair('MINT_A', { liquidity: { usd: 900_000 }, marketCap: undefined, fdv: undefined }),
      ],
      ['MINT_A'],
    );
    expect(snapshots.get('MINT_A')?.mcapUsd).toBe(42_000);
  });

  it('ignores pairs where the mint is the QUOTE side, not the base', () => {
    const { snapshots, missing } = snapshotsFromPairs([pair('OTHER_MINT')], ['MINT_A']);
    expect(snapshots.size).toBe(0);
    expect(missing).toEqual(['MINT_A']);
  });

  it('reports missing mints so the caller can abstain instead of inventing a price', () => {
    const { snapshots, missing } = snapshotsFromPairs([pair('MINT_A')], ['MINT_A', 'MINT_B']);
    expect(snapshots.has('MINT_A')).toBe(true);
    expect(missing).toEqual(['MINT_B']);
  });

  it('yields null price/mcap (not 0) on unusable numbers', () => {
    const { snapshots } = snapshotsFromPairs(
      [pair('MINT_A', { priceUsd: 'not-a-number', marketCap: 0, fdv: undefined })],
      ['MINT_A'],
    );
    expect(snapshots.get('MINT_A')?.priceUsd).toBeNull();
    expect(snapshots.get('MINT_A')?.mcapUsd).toBeNull();
  });

  it('handles a null/absent pairs payload', () => {
    expect(snapshotsFromPairs(null, ['MINT_A']).missing).toEqual(['MINT_A']);
    expect(snapshotsFromPairs(undefined, []).snapshots.size).toBe(0);
  });
});

describe('30-pair response cap', () => {
  it('flags a response that hit the cap (mints may have been silently dropped)', () => {
    expect(wasTruncated(DEX_PAIR_CAP)).toBe(true);
    expect(wasTruncated(DEX_PAIR_CAP - 1)).toBe(false);
  });

  it('halves a truncated batch for re-query', () => {
    expect(splitForRetry(['a', 'b', 'c'])).toEqual([['a', 'b'], ['c']]);
  });

  it('stops splitting at a singleton — an empty result there means genuinely unlisted', () => {
    expect(splitForRetry(['a'])).toEqual([]);
    expect(splitForRetry([])).toEqual([]);
  });
});

describe('valueForMetric', () => {
  const snapshot = { mint: 'M', symbol: 'S', priceUsd: 0.0042, mcapUsd: 4_200_000 };

  it('reads mcap for mcap alerts and price for price alerts', () => {
    expect(valueForMetric(snapshot, 'mcap')).toBe(4_200_000);
    expect(valueForMetric(snapshot, 'price')).toBe(0.0042);
  });

  it('returns null (→ abstain) when the requested metric is unavailable', () => {
    expect(valueForMetric({ ...snapshot, mcapUsd: null }, 'mcap')).toBeNull();
    expect(valueForMetric({ ...snapshot, priceUsd: null }, 'price')).toBeNull();
  });
});
