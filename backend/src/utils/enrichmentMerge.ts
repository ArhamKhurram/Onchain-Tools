import type { ContractEnrichmentPatch } from './contractLog.js';

export type EnrichmentSource = 'rick' | 'dexscreener' | 'gmgn';

const SECONDARY_SOURCES = new Set<EnrichmentSource>(['dexscreener', 'gmgn']);

/**
 * How far back the deferred fallback looks to find the row it queued itself for.
 *
 * The timer sleeps 8-15s and then re-reads the contract log, which is ordered
 * newest-first across every room and both sources. At the old limit of 20 a
 * busy meta scrolled the row out of the window before the timer woke, and the
 * lookup returned undefined with no log line — the row simply never got an
 * MC@CALL and nothing said so. 200 covers a burst an order of magnitude beyond
 * anything observed, and the read is one indexed query either way.
 */
export const FALLBACK_LOOKUP_LIMIT = 200;

/**
 * Whether the Dex/GMGN fallback still has work to do on a row.
 *
 * MC-at-call counts as work. The symbol alone used to gate this, and that
 * silently blanked MC@CALL on the majority of rows: `logContract` copies
 * tokenName/tokenSymbol/tokenPair forward from an earlier row of the same
 * address (contractsRepo.logContract) but deliberately NOT fdvAtCall, because
 * MC-at-call is point-in-time and an old row's value is a different number. So
 * every repeat mention was INSERTed with a symbol and a null FDV, the fallback
 * timer read it back, saw a symbol, and returned without ever fetching the one
 * field that was actually missing.
 *
 * The cost of the wider gate is one provider call per mention on tokens that
 * will never price (unlisted mints, false-positive base58). That is a single
 * fetch per contract row, not a loop, and it buys back the number the radar's
 * whole multiplier column is built on.
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
 *     fill in what Rick left blank, FDV included.
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
    // A Rick-owned row does not necessarily have an MC. `looksLikeRick` accepts
    // an embed on its pair title alone, so any bot embed shaped like
    // "Name · SYM/QUOTE" claims the row without supplying an FDV — and
    // `logContract` copies `enrichmentSource` forward onto repeat mentions, so a
    // row can read as Rick-owned having never seen an embed at all. Blocking FDV
    // on those rows locked MC@CALL out permanently: nothing but another Rick
    // embed could ever fill it. Rick still wins wherever Rick actually answered.
    if (existing.fdvAtCall == null && patch.fdvAtCall != null) {
      merged.fdvAtCall = patch.fdvAtCall;
      merged.fdvAtCallDisplay = patch.fdvAtCallDisplay;
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
