import { enrichFromDexScreener } from './tokenEnrichment.js';
import { enrichFromGmgn, resolveGmgnChain } from './gmgnEnrichment.js';
import type { TokenEnrichment } from './rickEmbedParser.js';
import {
  getCatalogEntry,
  upsertCatalogFromEnrichment,
  isCatalogStale,
  rowToSnapshot,
  normalizeCatalogChain,
  type TokenSnapshot,
} from '../storage/tokenCatalog.js';

export async function enrichToken(address: string, chainSlug?: string): Promise<TokenEnrichment | null> {
  const gmgnChain = resolveGmgnChain(chainSlug);
  if (gmgnChain && process.env.GMGN_API_KEY) {
    const gmgn = await enrichFromGmgn(gmgnChain, address);
    if (gmgn) return gmgn;
  }
  return enrichFromDexScreener(address);
}

export async function persistEnrichment(
  enrichment: TokenEnrichment,
  chainSlug?: string,
  options?: { raw?: unknown },
): Promise<void> {
  const slug = chainSlug ?? enrichment.evmChain ?? 'unknown';
  await upsertCatalogFromEnrichment(enrichment, slug, options);
}

export async function getTokenSnapshot(chainSlug: string, address: string): Promise<TokenSnapshot | null> {
  const cached = await getCatalogEntry(address, chainSlug);
  if (cached && !isCatalogStale(cached.enrichedAt)) {
    return rowToSnapshot(cached, chainSlug, false);
  }

  const { evmChain } = normalizeCatalogChain(chainSlug);
  const refreshChain = evmChain ?? chainSlug;
  const enrichment = await enrichToken(address, refreshChain !== 'unknown' ? refreshChain : undefined);
  if (!enrichment) {
    if (cached) return rowToSnapshot(cached, chainSlug, true);
    return null;
  }

  await persistEnrichment(enrichment, chainSlug, { raw: enrichment });
  const row = await getCatalogEntry(address, chainSlug);
  if (row) return rowToSnapshot(row, chainSlug, false);

  return {
    address: enrichment.address,
    chain: chainSlug,
    evmChain: enrichment.evmChain,
    symbol: enrichment.tokenSymbol,
    name: enrichment.tokenName,
    pair: enrichment.tokenPair,
    mc: enrichment.fdvAtCall,
    mcDisplay: enrichment.fdvAtCallDisplay,
    priceUsd: enrichment.priceUsd,
    liquidityUsd: enrichment.liquidityUsd,
    source: enrichment.enrichmentSource,
    enrichedAt: new Date().toISOString(),
    stale: false,
  };
}
