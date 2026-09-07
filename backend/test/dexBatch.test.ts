import { describe, expect, it } from 'vitest';
import {
  DEX_PAIR_CAP,
  chunkMints,
  snapshotsFromPairs,
  splitForRetry,
  wasTruncated,
  type DexPair,
} from '../src/marketData/dexBatch.js';

/**
 * The shared DexScreener batch read.
 *
 * This logic was extracted from the price-alert poller so the market-cap
 * crossing signal could use it rather than copy it. It is a workaround for a
 * MEASURED, undocumented upstream behaviour (see the module header), and the
 * failure mode of getting it wrong is silent under-reporting rather than an
 * error — which is exactly the kind of thing a second copy drifts on. These
 * tests cover the fields the crossing signal added; the crossing semantics
 * themselves stay pinned in priceAlertCrossing.test.ts.
 */

function pair(partial: Partial<DexPair> & { address: string }): DexPair {
  const { address, ...rest } = partial;
  return { baseToken: { address, symbol: 'TKN' }, ...rest };
}

describe('snapshotsFromPairs', () => {
  it('reads liquidity and chain from the DEEPEST pair, not the first one', () => {
    // Every other subsystem in this repo picks the deepest pool; a shallow pool
    // listed first would otherwise decide whether a token looks exitable.
    const { snapshots } = snapshotsFromPairs(
      [
        pair({ address: 'A', liquidity: { usd: 1_000 }, priceUsd: '1', chainId: 'solana' }),
        pair({ address: 'A', liquidity: { usd: 90_000 }, priceUsd: '2', marketCap: 800_000, chainId: 'solana' }),
      ],
      ['A'],
    );
    expect(snapshots.get('A')?.liquidityUsd).toBe(90_000);
    expect(snapshots.get('A')?.priceUsd).toBe(2);
    expect(snapshots.get('A')?.chainId).toBe('solana');
  });

  it('falls back to fdv, and to a shallower pair, for the token-level market cap', () => {
    const { snapshots } = snapshotsFromPairs(
      [
        pair({ address: 'A', liquidity: { usd: 90_000 }, priceUsd: '1' }),
        pair({ address: 'A', liquidity: { usd: 10_000 }, priceUsd: '1', fdv: 750_001 }),
      ],
      ['A'],
    );
    expect(snapshots.get('A')?.mcapUsd).toBe(750_001);
  });

  it('reports a requested mint with no pair as missing rather than as zero', () => {
    const { snapshots, missing } = snapshotsFromPairs([pair({ address: 'A' })], ['A', 'B']);
    expect(snapshots.has('B')).toBe(false);
    expect(missing).toEqual(['B']);
  });

  it('never invents a liquidity or market cap out of a malformed pair', () => {
    const { snapshots } = snapshotsFromPairs(
      [pair({ address: 'A', priceUsd: 'not-a-number', liquidity: {} })],
      ['A'],
    );
    expect(snapshots.get('A')?.priceUsd).toBeNull();
    expect(snapshots.get('A')?.mcapUsd).toBeNull();
    expect(snapshots.get('A')?.liquidityUsd).toBeNull();
  });
});

describe('the 30-pair cap', () => {
  it('recognises a capped response — the only case where a missing mint may be a lie', () => {
    expect(wasTruncated(DEX_PAIR_CAP)).toBe(true);
    expect(wasTruncated(DEX_PAIR_CAP - 1)).toBe(false);
  });

  it('halves a truncated batch, and stops at a singleton', () => {
    expect(splitForRetry(['a', 'b', 'c'])).toEqual([['a', 'b'], ['c']]);
    // A singleton that comes back empty is genuinely unlisted; there is nothing
    // left to split, and the caller abstains.
    expect(splitForRetry(['a'])).toEqual([]);
  });

  it('clamps the batch size to what the endpoint actually accepts', () => {
    expect(chunkMints(['a', 'b', 'c'], 0)).toEqual([['a'], ['b'], ['c']]);
    expect(chunkMints(new Array(40).fill('a'), 999)).toHaveLength(2);
  });
});

/**
 * 24h volume — the one additive field.
 *
 * Every other field on a snapshot is a PROPERTY of the deepest pool. Volume is
 * a FLOW, and a token that trades across six pools traded all of it. Measured
 * on one live mint on 2026-09-07: the deepest pool carried $9.14M of a $10.7M
 * token total, so reading the deepest pool alone under-reports by ~15%. Against
 * a `min` threshold that under-report costs real alerts.
 */
describe('snapshotsFromPairs — 24h volume', () => {
  it('SUMS volume across every pool, unlike liquidity', () => {
    const { snapshots } = snapshotsFromPairs(
      [
        pair({ address: 'A', liquidity: { usd: 130_000 }, volume: { h24: 9_141_324 } }),
        pair({ address: 'A', liquidity: { usd: 68_000 }, volume: { h24: 1_125_928 } }),
        pair({ address: 'A', liquidity: { usd: 7_000 }, volume: { h24: 208_317 } }),
      ],
      ['A'],
    );
    const snap = snapshots.get('A');
    // Liquidity still comes from the deepest pool alone…
    expect(snap?.liquidityUsd).toBe(130_000);
    // …while volume is the whole token's day.
    expect(snap?.volume24hUsd).toBe(9_141_324 + 1_125_928 + 208_317);
  });

  it('reports NULL, not zero, when no pool offered a figure', () => {
    // The difference the whole abstain path rests on: "DexScreener did not say"
    // is not "nobody traded it", and only one of those is evidence.
    const { snapshots } = snapshotsFromPairs([pair({ address: 'A' })], ['A']);
    expect(snapshots.get('A')?.volume24hUsd).toBeNull();
  });

  it('reports a genuine zero as zero — a listed, dead token is a real reading', () => {
    const { snapshots } = snapshotsFromPairs([pair({ address: 'A', volume: { h24: 0 } })], ['A']);
    expect(snapshots.get('A')?.volume24hUsd).toBe(0);
  });

  it('counts the pools that reported and ignores the ones that did not', () => {
    const { snapshots } = snapshotsFromPairs(
      [
        pair({ address: 'A', volume: { h24: 500 } }),
        pair({ address: 'A' }),
        pair({ address: 'A', volume: { h24: 250 } }),
      ],
      ['A'],
    );
    expect(snapshots.get('A')?.volume24hUsd).toBe(750);
  });

  it('drops a non-numeric or negative figure rather than poisoning the sum', () => {
    const { snapshots } = snapshotsFromPairs(
      [
        pair({ address: 'A', volume: { h24: 400 } }),
        pair({ address: 'A', volume: { h24: Number.NaN } }),
        pair({ address: 'A', volume: { h24: -10 } }),
      ],
      ['A'],
    );
    expect(snapshots.get('A')?.volume24hUsd).toBe(400);
  });
});

/**
 * Price change and pool age — the first-run-up signals.
 *
 * Both feed mcapCross/gates.ts's discriminator between a token climbing THROUGH
 * the target and one falling back through it. Price change is a POOL property
 * (deepest pair, like price) and stored as a fraction; pool age comes from the
 * OLDEST pool because "how long has this been tradeable" is the first pool, not
 * the deepest one.
 */
describe('snapshotsFromPairs — price change and pool age', () => {
  it('reads 24h/6h price change from the DEEPEST pair, as a fraction', () => {
    const { snapshots } = snapshotsFromPairs(
      [
        pair({ address: 'A', liquidity: { usd: 1_000 }, priceChange: { h24: 999, h6: 999 } }),
        pair({ address: 'A', liquidity: { usd: 90_000 }, priceChange: { h24: -20.52, h6: 5.1 } }),
      ],
      ['A'],
    );
    const s = snapshots.get('A');
    expect(s?.priceChangeH24).toBeCloseTo(-0.2052);
    expect(s?.priceChangeH6).toBeCloseTo(0.051);
  });

  it('reports NULL price change when the deepest pair reported none', () => {
    const { snapshots } = snapshotsFromPairs([pair({ address: 'A', liquidity: { usd: 5 } })], ['A']);
    expect(snapshots.get('A')?.priceChangeH24).toBeNull();
    expect(snapshots.get('A')?.priceChangeH6).toBeNull();
  });

  it('accepts a numeric string price change (untrusted narrowing)', () => {
    const { snapshots } = snapshotsFromPairs(
      [pair({ address: 'A', priceChange: { h24: '-20.52' } })],
      ['A'],
    );
    expect(snapshots.get('A')?.priceChangeH24).toBeCloseTo(-0.2052);
  });

  it('takes pool age from the OLDEST pool — max age, not the deepest pool', () => {
    const { snapshots } = snapshotsFromPairs(
      [
        pair({ address: 'A', liquidity: { usd: 90_000 }, pairCreatedAt: 2_000 }),
        pair({ address: 'A', liquidity: { usd: 1_000 }, pairCreatedAt: 1_000 }),
      ],
      ['A'],
    );
    expect(snapshots.get('A')?.pairCreatedAtMs).toBe(1_000);
  });

  it('reports NULL pool age when no pool reported a creation time', () => {
    const { snapshots } = snapshotsFromPairs([pair({ address: 'A' })], ['A']);
    expect(snapshots.get('A')?.pairCreatedAtMs).toBeNull();
  });
});
