import type { ContractEnrichmentPatch } from './contractLog.js';

export type EnrichmentSource = 'rick' | 'dexscreener' | 'gmgn';

const SECONDARY_SOURCES = new Set<EnrichmentSource>(['dexscreener', 'gmgn']);

/**
 * Does this logged row still have something the Dex/GMGN fallback could fill?
 *
 * Two independent gaps, either of which is worth exactly one fetch:
 *  - no symbol — the row is unreadable in the feed; and
 *  - no MC-at-call — the denominator of the Radar multiplier and of caller
 *    quality scoring, so a blank one costs more than a blank symbol.
 *
 * The FDV half is not redundant with the symbol half. `logContract` carries a
 * previously-resolved name/symbol/pair forward onto a repeat mention, but
 * deliberately NOT `fdvAtCall` — MC@call is point-in-time and must be measured
 * per call rather than copied off an older one. So a repeat mention is inserted
 * already carrying a symbol and a null FDV; gating on the symbol alone made
 * both fallback timers read the row back, decide there was nothing to do, and
 * return without ever pricing it. The FDV then stayed null forever, on every
 * repeat mention of every address we had ever enriched.
 *
 * This function only says a fetch *could* help. Not re-asking a provider that
 * has just told us it has no price for an address is the caller's job — see
 * `resolveFallbackTarget` in ./dexFallback.ts.
 */
export function needsMetadataFallback(entry: {
  tokenSymbol?: string;
  tokenName?: string;
  fdvAtCall?: number;
}): boolean {
  return !entry.tokenSymbol || entry.fdvAtCall == null;
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
 *     fill in what Rick left blank: metadata, and the FDV if Rick printed none.
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
    // Rick's authority is over the metadata, not over an FDV it never printed.
    // A row sits at source='rick' with a null FDV more often than it looks:
    // `looksLikeRick` accepts an embed on its pair title alone (no FDV field
    // needed), and `logContract` copies enrichmentSource forward onto a repeat
    // mention while — correctly — leaving fdvAtCall behind. Dropping the
    // patch's FDV in those cases left MC@call permanently blank. An FDV Rick
    // *did* record is still untouchable; this only fills a hole.
    if (existing.fdvAtCall == null && patch.fdvAtCall != null) {
      merged.fdvAtCall = patch.fdvAtCall;
      if (patch.fdvAtCallDisplay) merged.fdvAtCallDisplay = patch.fdvAtCallDisplay;
    }
    return merged;
  }

  const merged: ContractEnrichmentPatch = {
    ...patch,
    enrichedAt: patch.enrichedAt ?? new Date().toISOString(),
  };

  if (patch.enrichmentSource === 'rick') return merged;
  return existing.fdvAtCall != null ? stripFdvFromPatch(merged) : merged;
}
