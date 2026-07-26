import { describe, it, expect } from 'vitest';
import { mapUserPositions } from '../src/ingest/krystal/positions.js';

// Krystal OMITS `positions` entirely for a wallet with no LP positions — it does
// not return an empty array. Verified live on 2026-07-26 against a funded Safe
// holding zero positions. Treating that as malformed made the slow lane throw
// every tick, which would have meant compounding was never evaluated.

const context = { chainId: 4663, platform: 'uniswapv3', currentTicks: {} } as any;

describe('mapUserPositions — empty wallet', () => {
  it('returns no positions when `positions` is omitted but statsByChain proves the payload is valid', () => {
    const raw = { statsByChain: { '4663': { openPositionCount: 0, closedPositionCount: 0 } } };
    const result = mapUserPositions(raw, context);
    expect(result.positions).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('still accepts an explicit empty array, in case Krystal changes its mind', () => {
    const raw = { statsByChain: { '4663': {} }, positions: [] };
    expect(mapUserPositions(raw, context).positions).toEqual([]);
  });

  // The important half: "absent" must not become a blanket "no positions", or a
  // genuinely broken response silently reads as "nothing to do".
  it('THROWS when both positions and statsByChain are absent — malformed, not empty', () => {
    expect(() => mapUserPositions({}, context)).toThrow();
  });

  it('throws when positions is present but not an array', () => {
    expect(() => mapUserPositions({ statsByChain: {}, positions: 'nope' }, context)).toThrow();
  });

  it('throws on a non-object payload', () => {
    expect(() => mapUserPositions(null, context)).toThrow();
  });
});
