/**
 * DexScreener fallback when no Rick embed arrives for a contract.
 */

import type { TokenEnrichment } from './rickEmbedParser.js';
import { parseCompactUsd } from './rickEmbedParser.js';
import { enrichFromGmgn, resolveGmgnChain } from './gmgnEnrichment.js';

function formatCompact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

const CHAIN_MAP: Record<string, string> = {
  ethereum: 'eth',
  bsc: 'bsc',
  base: 'base',
  arbitrum: 'arb',
  polygon: 'polygon',
  avalanche: 'avax',
  solana: 'sol',
};

export async function enrichFromDexScreener(address: string): Promise<TokenEnrichment | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(address)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      pairs?: {
        chainId?: string;
        baseToken?: { address?: string; name?: string; symbol?: string };
        quoteToken?: { symbol?: string };
        priceUsd?: string;
        fdv?: number;
        marketCap?: number;
        liquidity?: { usd?: number };
        volume?: { h24?: number };
        pairCreatedAt?: number;
      }[];
    };

    const lower = address.toLowerCase();
    const pairs = (data.pairs ?? []).filter((p) =>
      p.baseToken?.address?.toLowerCase() === lower
      || (!address.startsWith('0x') && p.baseToken?.address === address),
    );
    if (pairs.length === 0) return null;

    pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const best = pairs[0];
    const fdv = best.fdv ?? best.marketCap;
    const liq = best.liquidity?.usd;
    const vol = best.volume?.h24;
    const price = best.priceUsd ? Number(best.priceUsd) : undefined;
    const symbol = best.baseToken?.symbol;
    const quote = best.quoteToken?.symbol;
    let tokenAge: string | undefined;
    if (best.pairCreatedAt) {
      const hrs = Math.floor((Date.now() - best.pairCreatedAt) / 3_600_000);
      if (hrs < 24) tokenAge = `${Math.max(1, hrs)}h`;
      else tokenAge = `${Math.floor(hrs / 24)}d`;
    }

    return {
      address,
      tokenName: best.baseToken?.name,
      tokenSymbol: symbol,
      tokenPair: symbol && quote ? `${symbol}/${quote}` : undefined,
      fdvAtCall: fdv,
      fdvAtCallDisplay: fdv != null ? formatCompact(fdv) : undefined,
      liquidityUsd: liq,
      liquidityDisplay: liq != null ? formatCompact(liq) : undefined,
      volumeUsd: vol,
      volumeDisplay: vol != null ? formatCompact(vol) : undefined,
      priceUsd: Number.isFinite(price) ? price : undefined,
      tokenAge,
      evmChain: best.chainId ? (CHAIN_MAP[best.chainId] ?? best.chainId) : undefined,
      enrichmentSource: 'dexscreener',
    };
  } catch (err) {
    console.error('[enrich] DexScreener failed:', (err as Error).message);
    return null;
  }
}

/** Live market-cap snapshot for Radar / missed-runner (does not overwrite mc@call). */
export async function fetchLiveMarketCap(
  address: string,
  chainSlug?: string,
): Promise<{
  mcNow?: number;
  mcNowDisplay?: string;
  priceUsd?: number;
} | null> {
  if (chainSlug && process.env.GMGN_API_KEY) {
    const gmgnChain = resolveGmgnChain(chainSlug) ?? (chainSlug === 'sol' ? 'sol' : null);
    if (gmgnChain) {
      const gmgn = await enrichFromGmgn(gmgnChain, address);
      if (gmgn?.fdvAtCall != null && gmgn.fdvAtCall > 0) {
        return {
          mcNow: gmgn.fdvAtCall,
          mcNowDisplay: gmgn.fdvAtCallDisplay,
          priceUsd: gmgn.priceUsd,
        };
      }
    }
  }

  const enriched = await enrichFromDexScreener(address);
  if (!enriched) return null;
  return {
    mcNow: enriched.fdvAtCall,
    mcNowDisplay: enriched.fdvAtCallDisplay,
    priceUsd: enriched.priceUsd,
  };
}

// silence unused if tree-shaken oddly
void parseCompactUsd;
