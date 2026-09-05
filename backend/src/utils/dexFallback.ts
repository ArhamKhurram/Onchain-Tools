import { normalizeContractAddress } from '@oct/shared';
import type { ContractEntry } from './contractLog.js';
import { needsMetadataFallback } from './enrichmentMerge.js';

/**
 * Shared decision logic for the two DexScreener/GMGN fallback timers — the 15s
 * one in index.ts (Discord + Telegram ingestion) and the 8s one in
 * api/routes/contracts.ts (the hosted browser-gateway path). Both schedule
 * themselves for one specific logged row and then have to answer the same two
 * questions: which row was that, and is fetching a price for it worth doing.
 */

/**
 * How long we take a provider at its word that it cannot price an address.
 *
 * Long enough that a token nothing indexes costs one fetch per half hour
 * rather than one per mention; short enough that a token that only gets a pair
 * indexed later still picks up an MC@call on a subsequent call. Mentions inside
 * the window get no MC@call at all, which is the intended trade: a blank
 * denominator is safe, a stale or invented one is not.
 */
export const FDV_UNAVAILABLE_TTL_MS = 30 * 60 * 1000;

// Ceiling on the map so a spam wave of never-priceable addresses cannot grow it
// without bound. Entries are cheap (a string and a number), so this is large.
const MAX_TRACKED_ADDRESSES = 5_000;

/** address -> timestamp after which we are willing to ask a provider again. */
const fdvUnavailableUntil = new Map<string, number>();

function prune(now: number): void {
  for (const [key, expiry] of fdvUnavailableUntil) {
    if (expiry <= now) fdvUnavailableUntil.delete(key);
  }
  // Still full of live entries: evict oldest-first (Map iterates in insertion
  // order). Evicting only costs an extra fetch, never a wrong number.
  while (fdvUnavailableUntil.size >= MAX_TRACKED_ADDRESSES) {
    const oldest = fdvUnavailableUntil.keys().next();
    if (oldest.done) break;
    fdvUnavailableUntil.delete(oldest.value);
  }
}

/**
 * Record what a fallback fetch actually yielded for an address.
 *
 * Pass the enrichment the providers returned, or `null`/`undefined` when the
 * fetch produced nothing at all. Every fallback fetch must report its outcome
 * here, or the guard below has nothing to go on.
 *
 * The distinction between those two cases is the whole point of taking the
 * enrichment rather than a bare number. `enrichToken` returns null when nobody
 * answered — GMGN inside its 90s `RATE_LIMIT_BANNED` cooldown, the DexScreener
 * circuit breaker open, a timeout, a 5xx — which says nothing whatsoever about
 * whether the token has a price. Arming a 30-minute negative guard on that
 * turns a few seconds of provider trouble into half an hour of deliberately
 * blank MC@call for the address, across every later mention, and the busier the
 * feed the more often it fires. Only a provider that answered and had no FDV to
 * give is evidence the address is unpriceable.
 */
export function recordFallbackFdv(
  address: string,
  result: { fdvAtCall?: number } | null | undefined,
  now = Date.now(),
): void {
  // Nobody answered: no evidence either way, so leave the guard untouched and
  // let the next mention try again.
  if (result == null) return;
  const key = normalizeContractAddress(address);
  if (result.fdvAtCall != null) {
    fdvUnavailableUntil.delete(key);
    return;
  }
  if (fdvUnavailableUntil.size >= MAX_TRACKED_ADDRESSES) prune(now);
  fdvUnavailableUntil.set(key, now + FDV_UNAVAILABLE_TTL_MS);
}

/** True while a provider has recently told us it has no price for this address. */
export function isFdvUnavailable(address: string, now = Date.now()): boolean {
  const key = normalizeContractAddress(address);
  const expiry = fdvUnavailableUntil.get(key);
  if (expiry == null) return false;
  if (expiry <= now) {
    fdvUnavailableUntil.delete(key);
    return false;
  }
  return true;
}

/** Test seam — the guard is process-global state. */
export function resetFallbackGuard(): void {
  fdvUnavailableUntil.clear();
}

/** The one storage method the fallback timers need. */
export interface FallbackTargetStore {
  getContractByMessage(userId: string, messageId: string, address: string): Promise<ContractEntry | null>;
}

/**
 * Resolve the row a fallback timer scheduled itself for, and decide whether it
 * is still worth a provider call. Returns the row to enrich, or null to skip.
 *
 * Resolution is by (messageId, address), not by scanning the N most recent
 * contracts. Both timers used to do the latter with N=20, so during a burst —
 * exactly when a busy feed is logging calls worth scoring — the row had already
 * scrolled out of the window by the time the timer fired 8 or 15 seconds later,
 * and the fallback silently did nothing.
 *
 * The guard clause is what keeps the widened `needsMetadataFallback` gate from
 * turning into a refetch loop. Now that a missing FDV alone re-opens the gate,
 * an address that no provider will ever price would otherwise be re-fetched on
 * every single mention, forever. A symbol-less row is still always fetched
 * (unchanged from before — that fetch is the row's only chance at a symbol);
 * only the FDV-only retry is rate-limited, and only for addresses a provider
 * has already declined to price.
 */
export async function resolveFallbackTarget(
  storage: FallbackTargetStore,
  userId: string,
  address: string,
  messageId: string,
  now = Date.now(),
): Promise<ContractEntry | null> {
  const row = await storage.getContractByMessage(userId, messageId, address);
  if (!row) return null;
  if (!needsMetadataFallback(row)) return null;
  if (row.tokenSymbol && isFdvUnavailable(address, now)) return null;
  return row;
}
