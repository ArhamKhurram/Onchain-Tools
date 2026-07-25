// Resolve the token symbol for a FOMO trade.
//
// FOMO's user-activity payload identifies tokens by address only (see
// normalizeUserActivity), so the live feed used to show a truncated address.
// OCT already knows how to turn an address into token metadata — the token
// catalog + GMGN/DexScreener enrichment — so reuse that here.
//
// Best-effort by design: any failure leaves the trade unchanged rather than
// dropping it, and results are memoised so a busy feed doesn't re-resolve the
// same token on every trade.

import { chainSlugFromNetworkId } from '@oct/shared';
import { getTokenSnapshot } from '../utils/tokenSnapshot.js';
import type { NormalizedTrade } from './store.js';

const SYMBOL_TTL_MS = 60 * 60 * 1000; // 1h — symbols are effectively immutable
const NEGATIVE_TTL_MS = 5 * 60 * 1000; // retry unknown tokens sooner
const MAX_ENTRIES = 500;

const cache = new Map<string, { symbol: string | null; expiresAt: number }>();

function cacheKey(chainSlug: string, address: string): string {
  return `${chainSlug}:${address.toLowerCase()}`;
}

function readCache(key: string): { symbol: string | null } | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return { symbol: hit.symbol };
}

function writeCache(key: string, symbol: string | null): void {
  if (cache.size >= MAX_ENTRIES) {
    // Cheap eviction: drop the oldest insertion.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, {
    symbol,
    expiresAt: Date.now() + (symbol ? SYMBOL_TTL_MS : NEGATIVE_TTL_MS),
  });
}

/** Test seam. */
export function clearTokenSymbolCache(): void {
  cache.clear();
}

/**
 * Look up a token symbol by address + FOMO network id. Returns null when the
 * network is unsupported, the address is missing, or enrichment finds nothing.
 */
export async function lookupTokenSymbol(
  tokenAddress: string | null,
  networkId: number | null,
): Promise<string | null> {
  if (!tokenAddress) return null;
  const chainSlug = chainSlugFromNetworkId(networkId);
  if (!chainSlug) return null;

  const key = cacheKey(chainSlug, tokenAddress);
  const cached = readCache(key);
  if (cached) return cached.symbol;

  try {
    const snapshot = await getTokenSnapshot(chainSlug, tokenAddress);
    const symbol = snapshot?.symbol?.trim() || null;
    writeCache(key, symbol);
    return symbol;
  } catch (err) {
    console.warn('[FomoSymbol] Lookup failed:', (err as Error)?.message ?? err);
    return null;
  }
}

/**
 * Return the trade with `tokenSymbol` filled in when it was missing. Never
 * throws and never blocks delivery of a trade — the worst case is the old
 * behaviour (address shown instead of a symbol).
 */
export async function resolveTradeTokenSymbol(trade: NormalizedTrade): Promise<NormalizedTrade> {
  if (trade.tokenSymbol) return trade;
  const symbol = await lookupTokenSymbol(trade.tokenAddress, trade.networkId);
  return symbol ? { ...trade, tokenSymbol: symbol } : trade;
}
