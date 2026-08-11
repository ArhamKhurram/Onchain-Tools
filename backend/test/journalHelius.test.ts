import { describe, expect, it } from 'vitest';
import { cutAtCursor } from '../src/journal/helius.js';
import type { HeliusEnhancedTx } from '../src/journal/normalize.js';

function page(signatures: string[]): HeliusEnhancedTx[] {
  // Helius returns newest-first.
  return signatures.map((signature, i) => ({ signature, timestamp: 1_754_900_000 - i }));
}

describe('cutAtCursor', () => {
  it('returns the whole page with no cursor (fresh wallet backfill)', () => {
    const { fresh, cursorFound } = cutAtCursor(page(['c', 'b', 'a']), null);
    expect(fresh.map((t) => t.signature)).toEqual(['c', 'b', 'a']);
    expect(cursorFound).toBe(false);
  });

  it('cuts strictly BEFORE the cursor signature when found', () => {
    const { fresh, cursorFound } = cutAtCursor(page(['e', 'd', 'c', 'b', 'a']), 'c');
    expect(fresh.map((t) => t.signature)).toEqual(['e', 'd']);
    expect(cursorFound).toBe(true);
  });

  it('yields nothing new when the cursor is the newest tx', () => {
    const { fresh, cursorFound } = cutAtCursor(page(['c', 'b', 'a']), 'c');
    expect(fresh).toHaveLength(0);
    expect(cursorFound).toBe(true);
  });

  it('keeps the whole page and reports not-found when the cursor is beyond it', () => {
    const { fresh, cursorFound } = cutAtCursor(page(['e', 'd', 'c']), 'zz-older');
    expect(fresh.map((t) => t.signature)).toEqual(['e', 'd', 'c']);
    expect(cursorFound).toBe(false);
  });
});
