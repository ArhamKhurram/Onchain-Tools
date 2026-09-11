// The write half of the MC@call floor.
//
// `mergeEnrichmentPatch` is the one choke point every enrichment patch passes
// through in both storage implementations, so refusing a reading that is not a
// market cap once here covers all three providers — GMGN (a real supply times
// an unindexed price), Rick (a bare "$1" picked out of an embed) and
// DexScreener (a $269 FDV for a token whose peak was $56k). Each value below
// is a reading that actually reached prod.
import { describe, it, expect } from 'vitest';
import { MIN_MC_AT_CALL } from '@oct/shared';
import { mergeEnrichmentPatch } from '../src/utils/enrichmentMerge.js';

describe('mergeEnrichmentPatch refuses a dust MC@call', () => {
  it('drops the FDV but keeps everything else the patch measured', () => {
    const merged = mergeEnrichmentPatch(
      {},
      {
        tokenName: 'THIS',
        tokenSymbol: 'THIS',
        fdvAtCall: 1.1935995,
        fdvAtCallDisplay: '1.19',
        liquidityUsd: 12_400,
        priceUsd: 1.1935995e-9,
        enrichmentSource: 'gmgn',
      },
    );
    expect(merged.fdvAtCall).toBeUndefined();
    expect(merged.fdvAtCallDisplay).toBeUndefined();
    expect(merged.tokenSymbol).toBe('THIS');
    expect(merged.liquidityUsd).toBe(12_400);
    expect(merged.priceUsd).toBe(1.1935995e-9);
  });

  it('refuses it from Rick too, whose patches otherwise win outright', () => {
    const merged = mergeEnrichmentPatch(
      {},
      { tokenSymbol: 'x', fdvAtCall: 1, fdvAtCallDisplay: '$1', enrichmentSource: 'rick' },
    );
    expect(merged.fdvAtCall).toBeUndefined();
  });

  it('leaves a real reading alone, at the floor and above', () => {
    for (const fdv of [MIN_MC_AT_CALL, 1_400, 4_300, 36_123]) {
      const merged = mergeEnrichmentPatch({}, { fdvAtCall: fdv, enrichmentSource: 'dexscreener' });
      expect(merged.fdvAtCall).toBe(fdv);
    }
  });

  // A dust reading recorded first would otherwise sit there forever: every
  // fill-the-hole rule downstream only ever writes into a NULL MC@call.
  it('leaves the hole open so a later good reading can fill it', () => {
    const first = mergeEnrichmentPatch({}, { fdvAtCall: 0.0237454, enrichmentSource: 'gmgn' });
    expect(first.fdvAtCall).toBeUndefined();

    const second = mergeEnrichmentPatch(
      { ...first },
      { fdvAtCall: 4_689_727, fdvAtCallDisplay: '4.69M', enrichmentSource: 'dexscreener' },
    );
    expect(second.fdvAtCall).toBe(4_689_727);
  });
});
