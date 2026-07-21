import type { ContractEnrichmentPatch } from './contractLog.js';

export type EnrichmentSource = 'rick' | 'dexscreener' | 'gmgn';

const SECONDARY_SOURCES = new Set<EnrichmentSource>(['dexscreener', 'gmgn']);

export function metadataOnlyEnrichmentPatch(
  patch: ContractEnrichmentPatch,
): ContractEnrichmentPatch {
  const { fdvAtCall: _fdv, fdvAtCallDisplay: _display, ...rest } = patch;
  return rest;
}

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

/** Merge a secondary enrichment patch into an existing row without overwriting Rick metrics. */
export function mergeEnrichmentPatch(
  existing: ContractEnrichmentPatch & { enrichmentSource?: EnrichmentSource; fdvAtCall?: number; fdvAtCallDisplay?: string },
  patch: ContractEnrichmentPatch,
): ContractEnrichmentPatch {
  const preserveFdv = existing.fdvAtCall != null;

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
  if (preserveFdv) return stripFdvFromPatch(merged);
  return merged;
}
