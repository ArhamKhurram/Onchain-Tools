import { describe, it, expect } from 'vitest';
import { mergeEnrichmentPatch, needsMetadataFallback } from '../src/utils/enrichmentMerge.js';

const dexPatch = {
  tokenName: 'sillypufcat',
  tokenSymbol: 'puf',
  fdvAtCall: 2100,
  fdvAtCallDisplay: '2.1K',
  liquidityUsd: 893,
  liquidityDisplay: '893',
  enrichmentSource: 'dexscreener' as const,
};

describe('needsMetadataFallback', () => {
  it('is true while the symbol is missing', () => {
    expect(needsMetadataFallback({})).toBe(true);
    expect(needsMetadataFallback({ tokenName: 'sillypufcat' })).toBe(true);
  });

  // logContract carries a known symbol forward onto a repeat mention but never
  // the FDV (MC@call is point-in-time). Gating on the symbol alone therefore
  // skipped the fallback on every repeat mention and left MC@call null forever.
  it('is true when a repeat mention carries a symbol but no MC@call', () => {
    expect(needsMetadataFallback({ tokenSymbol: 'puf' })).toBe(true);
    expect(needsMetadataFallback({ tokenName: 'sillypufcat', tokenSymbol: 'puf' })).toBe(true);
  });

  it('is false once the row has both', () => {
    expect(needsMetadataFallback({ tokenSymbol: 'puf', fdvAtCall: 2100 })).toBe(false);
  });
});

describe('mergeEnrichmentPatch', () => {
  // A Telegram scan has no Rick embed, so the Dex/GMGN fallback is the only
  // chance it ever gets an MC@call. Regression guard for FDV being stripped.
  it('records FDV on a bare row from a secondary source', () => {
    const merged = mergeEnrichmentPatch({}, dexPatch);
    expect(merged.fdvAtCall).toBe(2100);
    expect(merged.fdvAtCallDisplay).toBe('2.1K');
    expect(merged.liquidityDisplay).toBe('893');
  });

  it('keeps the FDV already recorded when a secondary source refreshes', () => {
    const merged = mergeEnrichmentPatch(
      { fdvAtCall: 2100, fdvAtCallDisplay: '2.1K', enrichmentSource: 'dexscreener' },
      { ...dexPatch, fdvAtCall: 9000, fdvAtCallDisplay: '9K', liquidityDisplay: '1.2K' },
    );
    expect(merged.fdvAtCall).toBeUndefined();
    expect(merged.fdvAtCallDisplay).toBeUndefined();
    // Non-FDV metrics still refresh.
    expect(merged.liquidityDisplay).toBe('1.2K');
  });

  it('lets a late Rick embed override an FDV a fallback got in first', () => {
    const merged = mergeEnrichmentPatch(
      { fdvAtCall: 2100, fdvAtCallDisplay: '2.1K', enrichmentSource: 'dexscreener' },
      {
        tokenSymbol: 'puf',
        fdvAtCall: 1800,
        fdvAtCallDisplay: '1.8K',
        enrichmentSource: 'rick',
      },
    );
    expect(merged.fdvAtCall).toBe(1800);
    expect(merged.fdvAtCallDisplay).toBe('1.8K');
  });

  it('lets a secondary source only fill gaps once Rick owns the row', () => {
    const merged = mergeEnrichmentPatch(
      { tokenSymbol: 'puf', fdvAtCall: 1800, enrichmentSource: 'rick' },
      { ...dexPatch, tokenPair: 'PUF/SOL' },
    );
    expect(merged.fdvAtCall).toBeUndefined();
    expect(merged.tokenSymbol).toBeUndefined(); // Rick's symbol stands
    expect(merged.tokenName).toBe('sillypufcat'); // Rick left this blank
    expect(merged.tokenPair).toBe('PUF/SOL');
    expect(merged.liquidityDisplay).toBeUndefined(); // Rick's metrics stand
  });

  // The counterpart to the test above: Rick owns the row, but recorded no FDV.
  // Rows land there routinely — `looksLikeRick` accepts an embed on its pair
  // title alone, and logContract copies enrichmentSource forward onto a repeat
  // mention while leaving fdvAtCall behind — so dropping the patch's FDV here
  // was the second way MC@call ended up permanently blank.
  it('fills an MC@call that Rick never printed', () => {
    const merged = mergeEnrichmentPatch(
      { tokenSymbol: 'puf', tokenPair: 'PUF/SOL', enrichmentSource: 'rick' },
      dexPatch,
    );
    expect(merged.fdvAtCall).toBe(2100);
    expect(merged.fdvAtCallDisplay).toBe('2.1K');
    // Rick's metadata authority is untouched.
    expect(merged.tokenSymbol).toBeUndefined();
    expect(merged.tokenPair).toBeUndefined();
    expect(merged.liquidityDisplay).toBeUndefined();
  });

  it('always stamps enrichedAt', () => {
    expect(mergeEnrichmentPatch({}, dexPatch).enrichedAt).toBeTruthy();
    const overRick = mergeEnrichmentPatch({ enrichmentSource: 'rick' }, dexPatch);
    expect(overRick.enrichedAt).toBeTruthy();
    // A Rick row with no FDV of its own takes the fallback's.
    expect(overRick.fdvAtCall).toBe(2100);
  });
});
