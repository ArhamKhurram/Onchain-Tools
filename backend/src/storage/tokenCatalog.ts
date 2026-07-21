import { createClient } from '@supabase/supabase-js';
import { isHostedMode } from './index.js';
import type { TokenEnrichment } from '../utils/rickEmbedParser.js';
import type { EnrichmentSource } from '../utils/enrichmentMerge.js';

export interface TokenCatalogRow {
  address: string;
  chain: 'evm' | 'sol';
  evmChain?: string;
  symbol?: string;
  name?: string;
  pair?: string;
  fdv?: number;
  liq?: number;
  priceUsd?: number;
  enrichedAt: string;
  source?: EnrichmentSource;
  confidence?: string;
  raw?: unknown;
}

export interface TokenSnapshot {
  address: string;
  chain: string;
  evmChain?: string;
  symbol?: string;
  name?: string;
  pair?: string;
  mc?: number;
  mcDisplay?: string;
  priceUsd?: number;
  liquidityUsd?: number;
  source?: EnrichmentSource;
  enrichedAt: string;
  stale: boolean;
}

const STALE_MS = 5 * 60 * 1000;

function serviceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase service credentials required');
  return createClient(url, key, { auth: { persistSession: false } });
}

function formatCompact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

export function normalizeCatalogChain(chainSlug: string): { chain: 'evm' | 'sol'; evmChain?: string } {
  const lower = chainSlug.toLowerCase();
  if (lower === 'sol' || lower === 'solana') return { chain: 'sol' };
  return { chain: 'evm', evmChain: lower === 'unknown' ? undefined : lower };
}

function mapRow(row: Record<string, unknown>): TokenCatalogRow {
  return {
    address: String(row.address),
    chain: row.chain as 'evm' | 'sol',
    evmChain: (row.evm_chain as string | null) ?? undefined,
    symbol: (row.symbol as string | null) ?? undefined,
    name: (row.name as string | null) ?? undefined,
    pair: (row.pair as string | null) ?? undefined,
    fdv: row.fdv != null ? Number(row.fdv) : undefined,
    liq: row.liq != null ? Number(row.liq) : undefined,
    priceUsd: row.price_usd != null ? Number(row.price_usd) : undefined,
    enrichedAt: String(row.enriched_at),
    source: (row.source as EnrichmentSource | null) ?? undefined,
    confidence: (row.confidence as string | null) ?? undefined,
    raw: row.raw ?? undefined,
  };
}

export function rowToSnapshot(row: TokenCatalogRow, chainSlug: string, stale: boolean): TokenSnapshot {
  return {
    address: row.address,
    chain: chainSlug,
    evmChain: row.evmChain,
    symbol: row.symbol,
    name: row.name,
    pair: row.pair,
    mc: row.fdv,
    mcDisplay: row.fdv != null ? formatCompact(row.fdv) : undefined,
    priceUsd: row.priceUsd,
    liquidityUsd: row.liq,
    source: row.source,
    enrichedAt: row.enrichedAt,
    stale,
  };
}

export async function getCatalogEntry(address: string, chainSlug: string): Promise<TokenCatalogRow | null> {
  if (!isHostedMode()) return null;
  const { chain, evmChain } = normalizeCatalogChain(chainSlug);
  const client = serviceClient();

  let query = client
    .from('token_catalog')
    .select('*')
    .ilike('address', address)
    .eq('chain', chain);

  if (evmChain) {
    query = query.eq('evm_chain', evmChain);
  } else if (chain === 'evm') {
    query = query.eq('evm_chain', '');
  }

  let { data, error } = await query.order('enriched_at', { ascending: false }).limit(1).maybeSingle();
  if (!data && chain === 'evm' && !evmChain) {
    const fallback = await client
      .from('token_catalog')
      .select('*')
      .ilike('address', address)
      .eq('chain', 'evm')
      .order('enriched_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    data = fallback.data;
    error = fallback.error;
  }
  if (error) {
    console.error('[TokenCatalog] read failed:', error.message);
    return null;
  }
  return data ? mapRow(data) : null;
}

export async function upsertCatalogFromEnrichment(
  enrichment: TokenEnrichment,
  chainSlug: string,
  options?: { confidence?: string; raw?: unknown },
): Promise<void> {
  if (!isHostedMode()) return;

  const { chain, evmChain } = normalizeCatalogChain(chainSlug);
  const resolvedEvmChain = enrichment.evmChain ?? evmChain;
  const now = new Date().toISOString();

  const row = {
    address: enrichment.address,
    chain,
    evm_chain: resolvedEvmChain ?? '',
    symbol: enrichment.tokenSymbol ?? null,
    name: enrichment.tokenName ?? null,
    pair: enrichment.tokenPair ?? null,
    fdv: enrichment.fdvAtCall ?? null,
    liq: enrichment.liquidityUsd ?? null,
    price_usd: enrichment.priceUsd ?? null,
    enriched_at: now,
    source: enrichment.enrichmentSource,
    confidence: options?.confidence ?? null,
    raw: options?.raw ?? null,
    updated_at: now,
  };

  const client = serviceClient();
  const { error } = await client
    .from('token_catalog')
    .upsert(row, { onConflict: 'address,chain,evm_chain' });

  if (error) {
    console.error('[TokenCatalog] upsert failed:', error.message);
  }
}

export function isCatalogStale(enrichedAt: string): boolean {
  return Date.now() - new Date(enrichedAt).getTime() > STALE_MS;
}

export { STALE_MS };
