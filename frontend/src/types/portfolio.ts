import type { HoldingWallet } from './holdingWallets';
import type { WalletChain } from './wallets';

export type PortfolioPeriod = '7d' | '30d';

export type GmgnChain = 'sol' | 'base' | 'bsc' | 'eth' | 'robinhood';

export const WALLET_CHAIN_TO_GMGN: Record<WalletChain, GmgnChain> = {
  solana: 'sol',
  base: 'base',
  bsc: 'bsc',
  ethereum: 'eth',
  robinhood: 'robinhood',
};

/** Portfolio route param — EVM wallets fan out to all EVM chains via the `evm` selector. */
export type PortfolioChainParam = GmgnChain | 'evm';

const EVM_WALLET_CHAINS = new Set<WalletChain>(['ethereum', 'base', 'bsc']);

/**
 * A `0x` (EVM) wallet is the same address on every EVM chain, so we query them
 * together via the `evm` param. Solana and Robinhood stay single-chain.
 */
export function walletChainToPortfolioParam(chain: WalletChain): PortfolioChainParam {
  if (chain === 'solana') return 'sol';
  if (chain === 'robinhood') return 'robinhood';
  return 'evm';
}

export function isEvmWalletChain(chain: WalletChain): boolean {
  return EVM_WALLET_CHAINS.has(chain);
}

export const GMGN_CHAIN_SHORT: Record<GmgnChain, string> = {
  sol: 'SOL',
  base: 'BASE',
  bsc: 'BSC',
  eth: 'ETH',
  robinhood: 'HOOD',
};

export type PortfolioStats = {
  realized_profit?: number | string;
  unrealized_profit?: number | string;
  winrate?: number | string;
  total_cost?: number | string;
  buy_count?: number | string;
  sell_count?: number | string;
  pnl?: number | string;
  common?: Record<string, unknown>;
};

export type PortfolioHolding = {
  chain?: GmgnChain;
  walletLabel?: string;
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
};

export type PortfolioActivity = {
  chain?: GmgnChain;
  walletLabel?: string;
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

export type DailyPnlDay = {
  date: string;
  netPnl: number;
  buyUsd: number;
  sellUsd: number;
  tradeCount: number;
};

export type DailyPnlCumulative = {
  date: string;
  cumulativePnl: number;
};

export type DailyPnlResponse = {
  period: PortfolioPeriod;
  days: DailyPnlDay[];
  cumulative: DailyPnlCumulative[];
  note: string;
  skippedUnknownType?: number;
};

export type PortfolioApiError = {
  ok?: false;
  error: string;
  needsPrivateKey?: boolean;
  gmgnConfigured?: boolean;
};

export function walletChainToGmgn(chain: WalletChain): GmgnChain {
  return WALLET_CHAIN_TO_GMGN[chain];
}

export function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function formatUsd(value: unknown, opts?: { signed?: boolean }): string {
  const n = toNumber(value);
  const abs = Math.abs(n);
  const prefix = opts?.signed && n > 0 ? '+' : opts?.signed && n < 0 ? '-' : n < 0 ? '-' : '';
  const body =
    abs >= 1_000_000 ? `${(abs / 1_000_000).toFixed(2)}M` :
    abs >= 1_000 ? `${(abs / 1_000).toFixed(2)}K` :
    abs.toFixed(2);
  return `${prefix}$${body}`;
}

export function formatPercentRatio(ratio: unknown): string {
  const n = toNumber(ratio);
  return `${(n * 100).toFixed(1)}%`;
}

export function txExplorerUrl(gmgnChain: GmgnChain, hash: string): string | null {
  if (!hash) return null;
  switch (gmgnChain) {
    case 'sol':
      return `https://solscan.io/tx/${hash}`;
    case 'base':
      return `https://basescan.org/tx/${hash}`;
    case 'bsc':
      return `https://bscscan.com/tx/${hash}`;
    case 'eth':
      return `https://etherscan.io/tx/${hash}`;
    case 'robinhood':
      return null;
    default:
      return null;
  }
}

export type ActivitySide = 'buy' | 'sell';

export function classifyActivitySide(item: PortfolioActivity): ActivitySide | null {
  const raw = String(item.type ?? item.side ?? item.event_type ?? '')
    .toLowerCase()
    .replace(/[_\s-]/g, '');

  if (raw.includes('buy') || raw === 'transferin' || raw === 'add') return 'buy';
  if (raw.includes('sell') || raw === 'transferout' || raw === 'remove') return 'sell';

  const isBuy = item.is_buy;
  if (isBuy === true || isBuy === 'true' || isBuy === 1 || isBuy === '1') return 'buy';
  if (isBuy === false || isBuy === 'false' || isBuy === 0 || isBuy === '0') return 'sell';

  return null;
}

export function formatAge(ts: unknown): string {
  const n = Number(ts);
  if (!Number.isFinite(n)) return '—';
  const sec = Math.max(0, Math.floor(Date.now() / 1000 - n));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86_400)}d`;
}

export function formatMarketCap(value: unknown): string | null {
  const n = toNumber(value);
  if (n <= 0) return null;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function dedupeHoldingWallets(wallets: HoldingWallet[]): HoldingWallet[] {
  const seen = new Set<string>();
  const out: HoldingWallet[] = [];
  for (const w of wallets) {
    const key = isEvmWalletChain(w.chain)
      ? `evm:${w.address.toLowerCase()}`
      : `${w.chain}:${w.chain === 'solana' ? w.address : w.address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

export function mergePortfolioStats(list: PortfolioStats[]): PortfolioStats {
  let realized = 0;
  let unrealized = 0;
  let cost = 0;
  let buy = 0;
  let sell = 0;
  let winrateWeighted = 0;
  let tradeWeight = 0;

  for (const s of list) {
    realized += toNumber(s.realized_profit);
    unrealized += toNumber(s.unrealized_profit);
    cost += toNumber(s.total_cost);
    const b = toNumber(s.buy_count);
    const se = toNumber(s.sell_count);
    buy += b;
    sell += se;
    const trades = b + se;
    if (trades > 0) {
      winrateWeighted += toNumber(s.winrate) * trades;
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

export function mergeDailyPnl(responses: DailyPnlResponse[]): DailyPnlResponse {
  const dayMap = new Map<string, DailyPnlDay>();
  let skipped = 0;
  let note = responses[0]?.note ?? '';

  for (const resp of responses) {
    skipped += resp.skippedUnknownType ?? 0;
    for (const day of resp.days) {
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
    period: responses[0]?.period ?? '30d',
    days,
    cumulative,
    skippedUnknownType: skipped,
    note,
  };
}

function activityUsd(item: PortfolioActivity): number {
  const cost = Math.abs(toNumber(item.cost_usd));
  if (cost > 0) return cost;
  const amt = toNumber(item.token_amount);
  const price = toNumber(item.price_usd);
  if (amt > 0 && price > 0) return amt * price;
  return 0;
}

/** Build chart/calendar data from the activity feed already on screen (no extra GMGN calls). */
export function aggregateDailyPnlFromActivity(
  activities: PortfolioActivity[],
  period: PortfolioPeriod,
): DailyPnlResponse {
  const periodDays = period === '7d' ? 7 : 30;
  const cutoffSec = Math.floor(Date.now() / 1000) - periodDays * 86_400;
  const buckets = new Map<string, DailyPnlDay>();
  let skippedUnknownType = 0;

  for (const item of activities) {
    const ts = Number(item.timestamp);
    if (!Number.isFinite(ts) || ts < cutoffSec) continue;

    const side = classifyActivitySide(item);
    if (!side) {
      skippedUnknownType += 1;
      continue;
    }

    const usd = activityUsd(item);
    if (usd <= 0) continue;

    const date = new Date(ts * 1000).toISOString().slice(0, 10);
    const row = buckets.get(date) ?? { date, netPnl: 0, buyUsd: 0, sellUsd: 0, tradeCount: 0 };

    if (side === 'buy') {
      row.buyUsd += usd;
      row.netPnl -= usd;
    } else {
      row.sellUsd += usd;
      row.netPnl += usd;
    }
    row.tradeCount += 1;
    buckets.set(date, row);
  }

  const days = [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
  let running = 0;
  const cumulative = days.map((day) => {
    running += day.netPnl;
    return { date: day.date, cumulativePnl: running };
  });

  return {
    period,
    days,
    cumulative,
    skippedUnknownType,
    note: 'Daily PnL from visible activity feed (recent trades). Buys negative, sells positive.',
  };
}

export function isGmgnRateLimitError(message: string | null | undefined): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes('rate_limit') || lower.includes('too many');
}

export function formatPortfolioError(message: string | null | undefined): string {
  if (!message) return 'Request failed.';
  if (isGmgnRateLimitError(message)) {
    return 'GMGN rate limit — wait 1–2 minutes, pick one wallet, then hit Refresh.';
  }
  return message;
}

/** Shared panel chrome for portfolio sections. */
export const PORTFOLIO_PANEL =
  'border-2 border-oct-accent/35 bg-gradient-to-b from-oct-accent/[0.07] to-oct-surface shadow-[inset_0_1px_0_rgba(255,59,59,0.12)]';
export const PORTFOLIO_PANEL_HEADER =
  'px-4 py-3 border-b-2 border-oct-accent/30 bg-oct-accent/[0.06] flex items-center justify-between';
export const PORTFOLIO_PANEL_TITLE =
  'font-mono text-xs uppercase tracking-[0.16em] text-white font-semibold';
