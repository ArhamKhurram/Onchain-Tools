import type { TokenEnrichment } from './rickEmbedParser.js';
import { gmgnGetLegacy } from './gmgnClient.js';

/** GMGN token info for missed-runner MC and Robinhood snapshots — not used by Portfolio (Birdeye). */

function formatCompact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

type GmgnTokenInfo = {
  address?: string;
  symbol?: string;
  name?: string;
  liquidity?: string | number;
  circulating_supply?: string | number;
  total_supply?: string | number;
  price?: {
    price?: string | number;
  };
  pool?: {
    quote_symbol?: string;
  };
};

const GMGN_CHAIN_MAP: Record<string, string> = {
  robinhood: 'robinhood',
  hood: 'robinhood',
  base: 'base',
  eth: 'eth',
  ethereum: 'eth',
  bsc: 'bsc',
  arb: 'eth',
  arbitrum: 'eth',
  sol: 'sol',
  solana: 'sol',
};

export function resolveGmgnChain(evmChain?: string): string | null {
  if (!evmChain) return null;
  return GMGN_CHAIN_MAP[evmChain.toLowerCase()] ?? null;
}

export async function enrichFromGmgn(chain: string, address: string): Promise<TokenEnrichment | null> {
  const data = await gmgnGetLegacy<GmgnTokenInfo>('/v1/token/info', { chain, address });
  if (!data?.address) return null;

  const priceRaw = data.price?.price;
  const price = priceRaw != null ? Number(priceRaw) : undefined;
  const supplyRaw = data.circulating_supply ?? data.total_supply;
  const supply = supplyRaw != null ? Number(supplyRaw) : undefined;
  const fdv = supply != null && Number.isFinite(price) ? supply * price! : undefined;
  const liqRaw = data.liquidity;
  const liq = liqRaw != null ? Number(liqRaw) : undefined;
  const quote = data.pool?.quote_symbol;
  const symbol = data.symbol;

  return {
    address,
    tokenName: data.name,
    tokenSymbol: symbol,
    tokenPair: symbol && quote ? `${symbol}/${quote}` : undefined,
    fdvAtCall: Number.isFinite(fdv) ? fdv : undefined,
    fdvAtCallDisplay: fdv != null && Number.isFinite(fdv) ? formatCompact(fdv) : undefined,
    liquidityUsd: Number.isFinite(liq) ? liq : undefined,
    liquidityDisplay: liq != null && Number.isFinite(liq) ? formatCompact(liq) : undefined,
    priceUsd: Number.isFinite(price) ? price : undefined,
    evmChain: chain === 'sol' ? undefined : chain,
    enrichmentSource: 'gmgn',
  };
}
