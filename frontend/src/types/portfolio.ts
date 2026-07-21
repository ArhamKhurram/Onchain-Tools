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
  transaction_hash?: string;
  type?: string;
  token?: {
    address?: string;
    symbol?: string;
  };
  token_amount?: number | string;
  cost_usd?: number | string;
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
