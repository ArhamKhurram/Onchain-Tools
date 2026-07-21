import { gmgnGet, gmgnSignedGet, type GmgnResult } from '../utils/gmgnClient.js';

export type OctWalletChain = 'bsc' | 'ethereum' | 'solana' | 'base' | 'robinhood';
export type GmgnChain = 'sol' | 'base' | 'bsc' | 'eth' | 'robinhood';

const OCT_TO_GMGN: Record<OctWalletChain, GmgnChain> = {
  solana: 'sol',
  base: 'base',
  bsc: 'bsc',
  ethereum: 'eth',
  robinhood: 'robinhood',
};

const GMGN_TO_OCT: Record<GmgnChain, OctWalletChain> = {
  sol: 'solana',
  base: 'base',
  bsc: 'bsc',
  eth: 'ethereum',
  robinhood: 'robinhood',
};

export const SUPPORTED_GMGN_CHAINS = new Set<string>(['sol', 'base', 'bsc', 'eth', 'robinhood']);

/** EVM chains a single 0x address can hold positions on (queried together for portfolio). */
export const EVM_GMGN_CHAINS: GmgnChain[] = ['eth', 'base', 'bsc'];

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

export function walletChainToGmgn(chain: OctWalletChain): GmgnChain {
  return OCT_TO_GMGN[chain];
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

export function normalizeWalletAddress(address: string, gmgnChain: GmgnChain): string {
  const trimmed = address.trim();
  return gmgnChain === 'sol' ? trimmed : trimmed.toLowerCase();
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

export type WalletActivityItem = {
  chain?: GmgnChain;
  transaction_hash?: string;
  type?: string;
  token?: {
    address?: string;
    symbol?: string;
  };
  token_amount?: number | string;
  cost_usd?: number | string;
  price_usd?: number | string;
  timestamp?: number | string;
};

export type WalletActivityResponse = {
  activities?: WalletActivityItem[];
  next?: string;
};

export async function fetchWalletStats(
  chain: GmgnChain,
  address: string,
  period: '7d' | '30d',
): Promise<GmgnResult<WalletStats>> {
  const key = cacheKey('stats', chain, address, { period });
  return cachedFetch(key, () =>
    gmgnGet<WalletStats>('/v1/user/wallet_stats', {
      chain,
      wallet_address: address,
      period,
    }),
  );
}

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

export async function fetchWalletActivity(
  chain: GmgnChain,
  address: string,
  extra: Record<string, string | number | string[]> = {},
): Promise<GmgnResult<WalletActivityResponse>> {
  const key = cacheKey('activity', chain, address, extra);
  return cachedFetch(key, () =>
    gmgnGet<WalletActivityResponse>('/v1/user/wallet_activity', {
      chain,
      wallet_address: address,
      ...extra,
    }),
  );
}

export async function fetchAllWalletActivity(
  chain: GmgnChain,
  address: string,
  opts: { maxPages?: number; maxEvents?: number; periodDays?: number } = {},
): Promise<WalletActivityItem[]> {
  const maxPages = opts.maxPages ?? 5;
  const maxEvents = opts.maxEvents ?? 500;
  const periodDays = opts.periodDays ?? 30;
  const cutoffSec = Math.floor(Date.now() / 1000) - periodDays * 86_400;

  const all: WalletActivityItem[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages && all.length < maxEvents; page += 1) {
    const extra: Record<string, string | number> = { limit: 100 };
    if (cursor) extra.cursor = cursor;

    const result = await fetchWalletActivity(chain, address, extra);
    if (!result.ok) break;

    const batch = result.data.activities ?? [];
    if (batch.length === 0) break;

    for (const item of batch) {
      const ts = Number(item.timestamp);
      if (Number.isFinite(ts) && ts < cutoffSec) {
        return all;
      }
      all.push({ ...item, chain });
      if (all.length >= maxEvents) break;
    }

    cursor = result.data.next;
    if (!cursor) break;
  }

  return all;
}

// ---- Multi-chain aggregation (EVM wallets query eth/base/bsc together) ----

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * When every chain failed, pick the most informative error to surface:
 * missing API key > needs private key > any other error.
 */
function pickError<T>(results: GmgnResult<T>[]): GmgnResult<T> {
  const configMissing = results.find((r) => !r.ok && r.gmgnConfigured === false);
  if (configMissing && !configMissing.ok) return configMissing;
  const needsKey = results.find((r) => !r.ok && r.needsPrivateKey);
  if (needsKey && !needsKey.ok) return needsKey;
  const anyErr = results.find((r) => !r.ok);
  if (anyErr && !anyErr.ok) return anyErr;
  return { ok: false, error: 'No data returned.', gmgnConfigured: true };
}

function mergeStats(list: WalletStats[]): WalletStats {
  let realized = 0;
  let unrealized = 0;
  let cost = 0;
  let buy = 0;
  let sell = 0;
  let winrateWeighted = 0;
  let tradeWeight = 0;
  let common: Record<string, unknown> | undefined;

  for (const s of list) {
    realized += num(s.realized_profit);
    unrealized += num(s.unrealized_profit);
    cost += num(s.total_cost);
    const b = num(s.buy_count);
    const se = num(s.sell_count);
    buy += b;
    sell += se;
    const trades = b + se;
    if (trades > 0) {
      winrateWeighted += num(s.winrate) * trades;
      tradeWeight += trades;
    }
    if (!common && s.common) common = s.common;
  }

  return {
    realized_profit: realized,
    unrealized_profit: unrealized,
    total_cost: cost,
    buy_count: buy,
    sell_count: sell,
    winrate: tradeWeight > 0 ? winrateWeighted / tradeWeight : 0,
    pnl: cost > 0 ? realized / cost : 0,
    common,
  };
}

export async function fetchWalletStatsMerged(
  chains: GmgnChain[],
  address: string,
  period: '7d' | '30d',
): Promise<GmgnResult<WalletStats>> {
  if (chains.length === 1) return fetchWalletStats(chains[0], address, period);

  const results = await Promise.all(chains.map((c) => fetchWalletStats(c, address, period)));
  const okData = results.filter((r): r is { ok: true; data: WalletStats } => r.ok).map((r) => r.data);
  if (okData.length === 0) return pickError(results);

  return { ok: true, data: mergeStats(okData) };
}

export async function fetchWalletHoldingsMerged(
  chains: GmgnChain[],
  address: string,
  extra: Record<string, string | number> = {},
): Promise<GmgnResult<WalletHoldingsResponse>> {
  if (chains.length === 1) return fetchWalletHoldings(chains[0], address, extra);

  const results = await Promise.all(
    chains.map(async (c) => ({ c, r: await fetchWalletHoldings(c, address, extra) })),
  );
  if (results.every(({ r }) => !r.ok)) return pickError(results.map(({ r }) => r));

  const holdings: WalletHolding[] = [];
  for (const { c, r } of results) {
    if (r.ok) {
      for (const h of r.data.holdings ?? []) holdings.push({ ...h, chain: c });
    }
  }
  holdings.sort((a, b) => num(b.usd_value) - num(a.usd_value));
  return { ok: true, data: { holdings } };
}

export async function fetchWalletActivityMerged(
  chains: GmgnChain[],
  address: string,
  limit: number,
): Promise<GmgnResult<WalletActivityResponse>> {
  if (chains.length === 1) return fetchWalletActivity(chains[0], address, { limit });

  const results = await Promise.all(
    chains.map(async (c) => ({ c, r: await fetchWalletActivity(c, address, { limit }) })),
  );
  if (results.every(({ r }) => !r.ok)) return pickError(results.map(({ r }) => r));

  const activities: WalletActivityItem[] = [];
  for (const { c, r } of results) {
    if (r.ok) {
      for (const a of r.data.activities ?? []) activities.push({ ...a, chain: c });
    }
  }
  activities.sort((a, b) => num(b.timestamp) - num(a.timestamp));
  return { ok: true, data: { activities: activities.slice(0, limit) } };
}

export async function fetchAllWalletActivityMerged(
  chains: GmgnChain[],
  address: string,
  opts: { maxPages?: number; maxEvents?: number; periodDays?: number } = {},
): Promise<WalletActivityItem[]> {
  const perChain = await Promise.all(chains.map((c) => fetchAllWalletActivity(c, address, opts)));
  return perChain.flat();
}
