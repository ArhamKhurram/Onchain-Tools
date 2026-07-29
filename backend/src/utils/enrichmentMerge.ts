import type { ContractEnrichmentPatch } from './contractLog.js';

export type EnrichmentSource = 'rick' | 'dexscreener' | 'gmgn';

const SECONDARY_SOURCES = new Set<EnrichmentSource>(['dexscreener', 'gmgn']);

export function needsMetadataFallback(entry: {
  tokenSymbol?: string;
  tokenName?: string;
}): boolean {
  return !entry.tokenSymbol;
}

function stripFdvFromPatch(patch: ContractEnrichmentPatch): ContractEnrichmentPatch {
  const { fdvAtCall: _fdv, fdvAtCallDisplay: _fdvDisplay, ...rest } = patch;
  return rest;
}

/**
 * Merge an enrichment patch into an existing row.
 *
 * MC-at-call is a point-in-time number, so the rules are ordered by authority:
 *  1. Rick already enriched the row -> a later DexScreener/GMGN patch may only
 *     fill in metadata Rick left blank.
 *  2. The patch is from Rick -> it wins outright, including FDV, because Rick's
 *     embed is the call itself and a fallback may have gotten there first.
 *  3. Otherwise -> keep whatever FDV we already recorded (the earliest reading
 *     is the closest to the call), but let everything else refresh.
 */
export function mergeEnrichmentPatch(
  existing: ContractEnrichmentPatch & { enrichmentSource?: EnrichmentSource; fdvAtCall?: number; fdvAtCallDisplay?: string },
  patch: ContractEnrichmentPatch,
): ContractEnrichmentPatch {
  if (
    existing.enrichmentSource === 'rick'
    && patch.enrichmentSource
    && SECONDARY_SOURCES.has(patch.enrichmentSource)
  ) {
    const merged: ContractEnrichmentPatch = {
      enrichedAt: patch.enrichedAt ?? new Date().toISOString(),
    };
    if (!existing.tokenName && patch.tokenName) merged.tokenName = patch.tokenName;
    if (!existing.tokenSymbol && patch.tokenSymbol) merged.tokenSymbol = patch.tokenSymbol;
    if (!existing.tokenPair && patch.tokenPair) merged.tokenPair = patch.tokenPair;
    if (!existing.evmChain && patch.evmChain) merged.evmChain = patch.evmChain;
    return merged;
  }

  const merged: ContractEnrichmentPatch = {
    ...patch,
    enrichedAt: patch.enrichedAt ?? new Date().toISOString(),
  };

  if (patch.enrichmentSource === 'rick') return merged;
  return existing.fdvAtCall != null ? stripFdvFromPatch(merged) : merged;
}
