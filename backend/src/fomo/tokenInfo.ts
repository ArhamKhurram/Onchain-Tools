// Resolve token symbol, name, and market cap for a FOMO trade.
//
// FOMO's user-activity payload identifies tokens by address (and sometimes a
// symbol) only — never name or market cap — so the live feed used to show a
// bare address/ticker with no way to tell what was actually bought or how
// big it was. OCT already knows how to turn an address into full token
// metadata (the token catalog + GMGN/DexScreener enrichment — the same
// pipeline contract calls use), so reuse it here.
//
// No local cache layer on top of getTokenSnapshot(): it already reads the
// catalog row first and only reaches out to GMGN/DexScreener when that row
// is missing or older than 5 minutes, so a second cache buys nothing. It
// would actively hurt market cap specifically — that changes constantly, so
// reusing an hour-old cached value across multiple trades of the same token
// would silently show the wrong "market cap at the time of this trade" for
// every trade after the first.
//
// Best-effort by design: any failure leaves the trade unchanged rather than
// dropping it.

import { chainSlugFromNetworkId } from '@oct/shared';
import { getTokenSnapshot } from '../utils/tokenSnapshot.js';
import type { NormalizedTrade } from './store.js';

export interface ResolvedTokenInfo {
  tokenSymbol: string | null;
  tokenName: string | null;
  marketCap: number | null;
  marketCapDisplay: string | null;
}

/**
 * Look up a token's symbol/name/market cap by address + FOMO network id.
 * Returns null when the network is unsupported, the address is missing, or
 * enrichment finds nothing.
 */
export async function lookupTokenInfo(
  tokenAddress: string | null,
  networkId: number | null,
): Promise<ResolvedTokenInfo | null> {
  if (!tokenAddress) return null;
  const chainSlug = chainSlugFromNetworkId(networkId);
  if (!chainSlug) return null;

  try {
    const snapshot = await getTokenSnapshot(chainSlug, tokenAddress);
    if (!snapshot) return null;
    return {
      tokenSymbol: snapshot.symbol?.trim() || null,
      tokenName: snapshot.name?.trim() || null,
      marketCap: snapshot.mc ?? null,
      marketCapDisplay: snapshot.mcDisplay ?? null,
    };
  } catch (err) {
    console.warn('[FomoTokenInfo] Lookup failed:', (err as Error)?.message ?? err);
    return null;
  }
}

/**
 * Return the trade with tokenSymbol/tokenName/marketCap filled in from OCT's
 * token catalog. Skips the lookup once all three are already present — that
 * happens for a stored trade being replayed (its market cap is a snapshot of
 * when the trade happened; a fresh lookup here would silently replace it
 * with the current, different value). Never throws and never blocks
 * delivery of a trade — the worst case is the old behaviour (address/ticker
 * shown, no name or market cap).
 */
export async function resolveTradeTokenInfo(trade: NormalizedTrade): Promise<NormalizedTrade> {
  if (trade.tokenSymbol && trade.tokenName && trade.marketCap != null) return trade;
  const info = await lookupTokenInfo(trade.tokenAddress, trade.networkId);
  if (!info) return trade;
  return {
    ...trade,
    tokenSymbol: trade.tokenSymbol ?? info.tokenSymbol,
    tokenName: trade.tokenName ?? info.tokenName,
    marketCap: trade.marketCap ?? info.marketCap,
    marketCapDisplay: trade.marketCapDisplay ?? info.marketCapDisplay,
  };
}
