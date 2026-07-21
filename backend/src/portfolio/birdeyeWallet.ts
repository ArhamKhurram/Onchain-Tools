import { birdeyeGet, birdeyePost, isBirdeyeConfigured, type BirdeyeChain, type BirdeyeResult } from '../utils/birdeyeClient.js';
import { mapSequential } from '../utils/gmgnLimiter.js';
import type { DailyPnlResult } from './pnlAggregator.js';
import {
  EVM_GMGN_CHAINS,
  type GmgnChain,
  type OctWalletChain,
  type WalletActivityItem,
  type WalletHolding,
  type WalletHoldingsResponse,
  type WalletStats,
} from './gmgnWallet.js';

export { isBirdeyeConfigured };

const GMGN_TO_BIRDEYE: Record<GmgnChain, BirdeyeChain> = {
  sol: 'solana',
  eth: 'ethereum',
  base: 'base',
  bsc: 'bsc',
  robinhood: 'robinhood',
};

export function gmgnChainsToBirdeye(chains: GmgnChain[]): BirdeyeChain[] {
  return chains.map((c) => GMGN_TO_BIRDEYE[c]);
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function periodToDuration(period: '7d' | '30d'): '7d' | '30d' {
  return period;
}

function formatBirdeyeTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

type PnlSummaryData = {
  summary?: {
    counts?: {
      total_buy?: number;
      total_sell?: number;
      total_trade?: number;
      win_rate?: number;
    };
    cashflow_usd?: {
      total_invested?: number;
      total_sold?: number;
      current_value?: number;
    };
    pnl?: {
      realized_profit_usd?: number;
      unrealized_usd?: number;
      total_usd?: number;
    };
  };
};

type PnlChartPoint = {
  timestamp?: string;
  realized_pnl?: number;
  total_volume_usd?: number;
  total_tx_count?: number;
};

type PnlDetailsToken = {
  symbol?: string;
  address?: string;
  quantity?: { holding?: number };
  cashflow_usd?: { current_value?: number; total_invested?: number };
  pnl?: {
    realized_profit?: number;
    unrealized_profit?: number;
    total_profit?: number;
    realized_profit_usd?: number;
    unrealized_usd?: number;
    total_usd?: number;
  };
  pricing?: { current_price?: number | null };
};

type PnlDetailsData = {
  tokens?: PnlDetailsToken[];
  summary?: PnlSummaryData['summary'];
};

type TxListItem = {
  tx_hash?: string;
  txHash?: string;
  block_unix_time?: number;
  blockTime?: number;
  timestamp?: number;
  side?: string;
  type?: string;
  token_symbol?: string;
  tokenSymbol?: string;
  symbol?: string;
  volume_usd?: number;
  volumeUsd?: number;
  value?: number;
  token_amount?: number;
  tokenAmount?: number;
  market_cap?: number;
  mc?: number;
  token_address?: string;
  tokenAddress?: string;
};

function summaryToStats(summary: PnlSummaryData['summary'] | undefined): WalletStats {
  const invested = num(summary?.cashflow_usd?.total_invested);
  const realized = num(summary?.pnl?.realized_profit_usd);
  const winRate = num(summary?.counts?.win_rate);
  return {
    realized_profit: realized,
    unrealized_profit: num(summary?.pnl?.unrealized_usd),
    total_cost: invested,
    buy_count: num(summary?.counts?.total_buy),
    sell_count: num(summary?.counts?.total_sell),
    winrate: winRate <= 1 ? winRate : winRate / 100,
    pnl: invested > 0 ? realized / invested : 0,
  };
}

function pickError<T>(results: BirdeyeResult<T>[]): BirdeyeResult<T> {
  const missing = results.find((r) => !r.ok && r.birdeyeConfigured === false);
  if (missing && !missing.ok) return missing;
  const anyErr = results.find((r) => !r.ok);
  if (anyErr && !anyErr.ok) return anyErr;
  return { ok: false, error: 'No data returned.', birdeyeConfigured: true };
}

function mergeStats(list: WalletStats[]): WalletStats {
  let realized = 0;
  let unrealized = 0;
  let cost = 0;
  let buy = 0;
  let sell = 0;
  let winrateWeighted = 0;
  let tradeWeight = 0;

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
  }

  return {
    realized_profit: realized,
    unrealized_profit: unrealized,
    total_cost: cost,
    buy_count: buy,
    sell_count: sell,
    winrate: tradeWeight > 0 ? winrateWeighted / tradeWeight : 0,
    pnl: cost > 0 ? realized / cost : 0,
  };
}

export async function fetchWalletStatsBirdeye(
  chain: BirdeyeChain,
  address: string,
  period: '7d' | '30d',
): Promise<BirdeyeResult<WalletStats>> {
  const result = await birdeyeGet<PnlSummaryData>(chain, '/wallet/v2/pnl/summary', {
    wallet: address,
    duration: periodToDuration(period),
    position_scope: 'duration_only',
  });
  if (!result.ok) return result;
  return { ok: true, data: summaryToStats(result.data.summary) };
}

export async function fetchWalletStatsMergedBirdeye(
  chains: GmgnChain[],
  address: string,
  period: '7d' | '30d',
): Promise<BirdeyeResult<WalletStats>> {
  const birdeyeChains = gmgnChainsToBirdeye(chains);
  if (birdeyeChains.length === 1) {
    return fetchWalletStatsBirdeye(birdeyeChains[0], address, period);
  }

  const results = await mapSequential(birdeyeChains, (c) => fetchWalletStatsBirdeye(c, address, period));
  const okData = results.filter((r): r is { ok: true; data: WalletStats } => r.ok).map((r) => r.data);
  if (okData.length === 0) return pickError(results);

  return { ok: true, data: mergeStats(okData) };
}

export async function fetchWalletPnlChartBirdeye(
  chain: BirdeyeChain,
  address: string,
  periodDays: 7 | 30,
): Promise<BirdeyeResult<DailyPnlResult>> {
  const now = new Date();
  const from = new Date(now.getTime() - periodDays * 86_400_000);

  const result = await birdeyeGet<PnlChartPoint[] | { data?: PnlChartPoint[] }>(
    chain,
    '/wallet/v2/pnl/chart',
    {
      wallet: address,
      position_scope: 'duration_only',
      time_from: formatBirdeyeTime(from),
      time_to: formatBirdeyeTime(now),
    },
  );
  if (!result.ok) return result;

  const raw = result.data;
  const points: PnlChartPoint[] = Array.isArray(raw) ? raw : (raw as { data?: PnlChartPoint[] }).data ?? [];

  const cutoffMs = from.getTime();
  const daysMap = new Map<string, { date: string; netPnl: number; buyUsd: number; sellUsd: number; tradeCount: number }>();

  for (const pt of points) {
    if (!pt.timestamp) continue;
    const ts = new Date(pt.timestamp).getTime();
    if (ts < cutoffMs) continue;
    const date = pt.timestamp.slice(0, 10);
    const netPnl = num(pt.realized_pnl);
    const row = daysMap.get(date) ?? { date, netPnl: 0, buyUsd: 0, sellUsd: 0, tradeCount: 0 };
    row.netPnl += netPnl;
    row.tradeCount += num(pt.total_tx_count);
    if (netPnl >= 0) row.sellUsd += Math.abs(netPnl);
    else row.buyUsd += Math.abs(netPnl);
    daysMap.set(date, row);
  }

  const days = [...daysMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  let running = 0;
  const cumulative = days.map((day) => {
    running += day.netPnl;
    return { date: day.date, cumulativePnl: running };
  });

  return {
    ok: true,
    data: {
      days,
      cumulative,
      skippedUnknownType: 0,
      note: 'Daily realized PnL from Birdeye wallet chart API.',
    },
  };
}

export async function fetchWalletPnlChartMergedBirdeye(
  chains: GmgnChain[],
  address: string,
  periodDays: 7 | 30,
): Promise<BirdeyeResult<DailyPnlResult>> {
  const birdeyeChains = gmgnChainsToBirdeye(chains);
  if (birdeyeChains.length === 1) {
    return fetchWalletPnlChartBirdeye(birdeyeChains[0], address, periodDays);
  }

  const results = await mapSequential(birdeyeChains, (c) =>
    fetchWalletPnlChartBirdeye(c, address, periodDays),
  );
  const ok = results.filter((r): r is { ok: true; data: DailyPnlResult } => r.ok);
  if (ok.length === 0) return pickError(results);

  const dayMap = new Map<string, { date: string; netPnl: number; buyUsd: number; sellUsd: number; tradeCount: number }>();
  for (const { data } of ok) {
    for (const day of data.days) {
      const row = dayMap.get(day.date) ?? { date: day.date, netPnl: 0, buyUsd: 0, sellUsd: 0, tradeCount: 0 };
      row.netPnl += day.netPnl;
      row.buyUsd += day.buyUsd;
      row.sellUsd += day.sellUsd;
      row.tradeCount += day.tradeCount;
      dayMap.set(day.date, row);
    }
  }

  const days = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  let running = 0;
  const cumulative = days.map((day) => {
    running += day.netPnl;
    return { date: day.date, cumulativePnl: running };
  });

  return {
    ok: true,
    data: {
      days,
      cumulative,
      skippedUnknownType: 0,
      note: 'Daily realized PnL from Birdeye (EVM chains merged).',
    },
  };
}

function tokenToHolding(token: PnlDetailsToken, chain: BirdeyeChain): WalletHolding | null {
  const holding = num(token.quantity?.holding);
  const usd = num(token.cashflow_usd?.current_value);
  if (holding <= 0 && usd <= 0) return null;

  const gmgnChain = (Object.entries(GMGN_TO_BIRDEYE).find(([, b]) => b === chain)?.[0] ?? chain) as GmgnChain;

  return {
    chain: gmgnChain,
    token: {
      address: token.address,
      symbol: token.symbol,
      price: token.pricing?.current_price ?? undefined,
    },
    balance: holding,
    usd_value: usd,
    cost: num(token.cashflow_usd?.total_invested),
    realized_profit: num(token.pnl?.realized_profit_usd ?? token.pnl?.realized_profit),
    unrealized_profit: num(token.pnl?.unrealized_usd ?? token.pnl?.unrealized_profit),
    total_profit: num(token.pnl?.total_usd ?? token.pnl?.total_profit),
  };
}

export async function fetchWalletHoldingsBirdeye(
  chain: BirdeyeChain,
  address: string,
  limit: number,
): Promise<BirdeyeResult<WalletHoldingsResponse>> {
  const result = await birdeyePost<PnlDetailsData>(chain, '/wallet/v2/pnl/details', {
    wallet: address,
    duration: '30d',
    sort_by: 'last_trade',
    sort_type: 'desc',
    limit: Math.min(limit, 100),
    offset: 0,
  });
  if (!result.ok) return result;

  const gmgnChain = (Object.entries(GMGN_TO_BIRDEYE).find(([, b]) => b === chain)?.[0] ?? chain) as GmgnChain;
  const holdings: WalletHolding[] = [];
  for (const token of result.data.tokens ?? []) {
    const row = tokenToHolding(token, chain);
    if (row) holdings.push({ ...row, chain: gmgnChain });
  }
  holdings.sort((a, b) => num(b.usd_value) - num(a.usd_value));

  return { ok: true, data: { holdings } };
}

export async function fetchWalletHoldingsMergedBirdeye(
  chains: GmgnChain[],
  address: string,
  limit: number,
): Promise<BirdeyeResult<WalletHoldingsResponse>> {
  const birdeyeChains = gmgnChainsToBirdeye(chains);
  if (birdeyeChains.length === 1) {
    return fetchWalletHoldingsBirdeye(birdeyeChains[0], address, limit);
  }

  const results = await mapSequential(birdeyeChains, (c) =>
    fetchWalletHoldingsBirdeye(c, address, Math.ceil(limit / birdeyeChains.length)),
  );
  if (results.every((r) => !r.ok)) return pickError(results);

  const holdings: WalletHolding[] = [];
  for (const r of results) {
    if (r.ok) holdings.push(...(r.data.holdings ?? []));
  }
  holdings.sort((a, b) => num(b.usd_value) - num(a.usd_value));

  return { ok: true, data: { holdings: holdings.slice(0, limit) } };
}

function mapTxItem(item: TxListItem, chain: BirdeyeChain): WalletActivityItem {
  const side = String(item.side ?? item.type ?? '').toLowerCase();
  const gmgnChain = (Object.entries(GMGN_TO_BIRDEYE).find(([, b]) => b === chain)?.[0] ?? chain) as GmgnChain;
  const ts = num(item.block_unix_time ?? item.blockTime ?? item.timestamp);

  return {
    chain: gmgnChain,
    transaction_hash: item.tx_hash ?? item.txHash,
    type: side.includes('buy') ? 'buy' : side.includes('sell') ? 'sell' : side,
    side,
    token: {
      address: item.token_address ?? item.tokenAddress,
      symbol: item.token_symbol ?? item.tokenSymbol ?? item.symbol,
    },
    token_amount: item.token_amount ?? item.tokenAmount,
    cost_usd: item.volume_usd ?? item.volumeUsd ?? item.value,
    market_cap: item.market_cap ?? item.mc,
    timestamp: ts > 0 ? ts : undefined,
  };
}

export async function fetchWalletActivityBirdeye(
  chain: BirdeyeChain,
  address: string,
  limit: number,
): Promise<BirdeyeResult<{ activities: WalletActivityItem[] }>> {
  const result = await birdeyeGet<{ items?: TxListItem[]; txs?: TxListItem[] } | TxListItem[]>(
    chain,
    '/v1/wallet/tx_list',
    { wallet: address, limit: Math.min(limit, 100) },
  );

  if (!result.ok) {
    return result as BirdeyeResult<{ activities: WalletActivityItem[] }>;
  }

  const raw = result.data;
  const items: TxListItem[] = Array.isArray(raw)
    ? raw
    : raw.items ?? raw.txs ?? [];

  const activities = items.map((item) => mapTxItem(item, chain));
  activities.sort((a, b) => num(b.timestamp) - num(a.timestamp));

  return { ok: true, data: { activities: activities.slice(0, limit) } };
}

export async function fetchWalletActivityMergedBirdeye(
  chains: GmgnChain[],
  address: string,
  limit: number,
): Promise<BirdeyeResult<{ activities: WalletActivityItem[] }>> {
  const birdeyeChains = gmgnChainsToBirdeye(chains);
  if (birdeyeChains.length === 1) {
    return fetchWalletActivityBirdeye(birdeyeChains[0], address, limit);
  }

  const results = await mapSequential(birdeyeChains, (c) =>
    fetchWalletActivityBirdeye(c, address, Math.ceil(limit / birdeyeChains.length)),
  );
  if (results.every((r) => !r.ok)) return pickError(results);

  const activities: WalletActivityItem[] = [];
  for (const r of results) {
    if (r.ok) activities.push(...(r.data.activities ?? []));
  }
  activities.sort((a, b) => num(b.timestamp) - num(a.timestamp));

  return { ok: true, data: { activities: activities.slice(0, limit) } };
}

/** Re-export EVM chain list for resolve compatibility. */
export { EVM_GMGN_CHAINS };

export type { GmgnChain, OctWalletChain };
