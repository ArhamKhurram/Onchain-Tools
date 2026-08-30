import { gmgnSignedGet, type GmgnResult } from '../utils/gmgnClient.js';

export type OctWalletChain = 'bsc' | 'ethereum' | 'solana' | 'base' | 'robinhood';
export type GmgnChain = 'sol' | 'base' | 'bsc' | 'eth' | 'robinhood';

const GMGN_TO_OCT: Record<GmgnChain, OctWalletChain> = {
  sol: 'solana',
  base: 'base',
  bsc: 'bsc',
  eth: 'ethereum',
  robinhood: 'robinhood',
};

const SUPPORTED_GMGN_CHAINS = new Set<string>(['sol', 'base', 'bsc', 'eth', 'robinhood']);

/** EVM chains a single 0x address can hold positions on (queried together for portfolio). */
const EVM_GMGN_CHAINS: GmgnChain[] = ['eth', 'base', 'bsc'];

/**
 * Resolve a portfolio chain URL param into the set of GMGN chains to query.
 * `evm` fans out to eth/base/bsc; everything else is a single chain.
 */
export function resolvePortfolioChains(param: string): GmgnChain[] | null {
  const lower = param.toLowerCase();
  if (lower === 'evm') return [...EVM_GMGN_CHAINS];
  const single = normalizeGmgnChain(lower);
  return single ? [single] : null;
}

export function gmgnChainToOct(chain: string): OctWalletChain | null {
  return (GMGN_TO_OCT as Record<string, OctWalletChain | undefined>)[chain] ?? null;
}

export function normalizeGmgnChain(chain: string): GmgnChain | null {
  const lower = chain.toLowerCase();
  if (lower === 'solana') return 'sol';
  if (lower === 'ethereum') return 'eth';
  if (SUPPORTED_GMGN_CHAINS.has(lower)) return lower as GmgnChain;
  return null;
}

const CACHE_TTL_MS = 90_000;
const cache = new Map<string, { expires: number; value: GmgnResult<unknown> }>();

function cacheKey(endpoint: string, chain: string, address: string, extra: Record<string, unknown>): string {
  return `${endpoint}:${chain}:${address}:${JSON.stringify(extra)}`;
}

function readCache<T>(key: string): GmgnResult<T> | null {
  const hit = cache.get(key);
  if (!hit || hit.expires <= Date.now()) {
    if (hit) cache.delete(key);
    return null;
  }
  return hit.value as GmgnResult<T>;
}

function writeCache(key: string, value: GmgnResult<unknown>): void {
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
}

async function cachedFetch<T>(
  key: string,
  fetcher: () => Promise<GmgnResult<T>>,
): Promise<GmgnResult<T>> {
  const hit = readCache<T>(key);
  if (hit) return hit;
  const result = await fetcher();
  writeCache(key, result);
  return result;
}

export type WalletStats = {
  realized_profit?: number | string;
  unrealized_profit?: number | string;
  winrate?: number | string;
  total_cost?: number | string;
  buy_count?: number | string;
  sell_count?: number | string;
  pnl?: number | string;
  common?: Record<string, unknown>;
};

export type WalletHolding = {
  chain?: GmgnChain;
  token?: {
    address?: string;
    symbol?: string;
    name?: string;
    price?: number | string;
  };
  balance?: number | string;
  usd_value?: number | string;
  cost?: number | string;
  realized_profit?: number | string;
  unrealized_profit?: number | string;
  total_profit?: number | string;
  profit_change?: number | string;
  avg_cost?: number | string;
  buy_tx_count?: number | string;
  sell_tx_count?: number | string;
  last_active_timestamp?: number | string;
};

export type WalletHoldingsResponse = {
  holdings?: WalletHolding[];
  next?: string;
};

export async function fetchWalletHoldings(
  chain: GmgnChain,
  address: string,
  extra: Record<string, string | number> = {},
): Promise<GmgnResult<WalletHoldingsResponse>> {
  const key = cacheKey('holdings', chain, address, extra);
  return cachedFetch(key, () =>
    gmgnSignedGet<WalletHoldingsResponse>('/v1/user/wallet_holdings', {
      chain,
      wallet_address: address,
      order_by: 'usd_value',
      direction: 'desc',
      ...extra,
    }),
  );
}

export type WalletActivityItem = {
  chain?: GmgnChain;
  transaction_hash?: string;
  type?: string;
  side?: string;
  event_type?: string;
  is_buy?: boolean | string | number;
  token?: {
    address?: string;
    symbol?: string;
    market_cap?: number | string;
  };
  token_amount?: number | string;
  cost_usd?: number | string;
  price_usd?: number | string;
  market_cap?: number | string;
  timestamp?: number | string;
};
