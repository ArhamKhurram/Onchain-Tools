import {
  fetchWalletActivityMergedBirdeye,
  fetchWalletHoldingsMergedBirdeye,
  fetchWalletPnlChartMergedBirdeye,
  fetchWalletStatsMergedBirdeye,
  isBirdeyeConfigured,
} from './birdeyeWallet.js';
import {
  fetchAllWalletActivityMerged,
  fetchWalletActivityMerged,
  fetchWalletHoldingsMerged,
  fetchWalletStatsMerged,
  type GmgnChain,
} from './gmgnWallet.js';
import type { DailyPnlResult } from './pnlAggregator.js';
import { aggregateDailyPnl } from './pnlAggregator.js';

export type PortfolioProvider = 'birdeye' | 'gmgn';

export function getPortfolioProvider(): PortfolioProvider {
  return isBirdeyeConfigured() ? 'birdeye' : 'gmgn';
}

type ProviderFail = {
  ok: false;
  error: string;
  code?: number;
  needsPrivateKey?: boolean;
  gmgnConfigured?: boolean;
  birdeyeConfigured?: boolean;
};

export async function fetchPortfolioStats(
  chains: GmgnChain[],
  address: string,
  period: '7d' | '30d',
) {
  if (getPortfolioProvider() === 'birdeye') {
    return fetchWalletStatsMergedBirdeye(chains, address, period);
  }
  return fetchWalletStatsMerged(chains, address, period);
}

export async function fetchPortfolioHoldings(
  chains: GmgnChain[],
  address: string,
  limit: number,
) {
  if (getPortfolioProvider() === 'birdeye') {
    return fetchWalletHoldingsMergedBirdeye(chains, address, limit);
  }
  return fetchWalletHoldingsMerged(chains, address, { limit });
}

export async function fetchPortfolioActivity(
  chains: GmgnChain[],
  address: string,
  limit: number,
) {
  if (getPortfolioProvider() === 'birdeye') {
    return fetchWalletActivityMergedBirdeye(chains, address, limit);
  }
  return fetchWalletActivityMerged(chains, address, limit);
}

export async function fetchPortfolioPnlDaily(
  chains: GmgnChain[],
  address: string,
  period: '7d' | '30d',
): Promise<DailyPnlResult | ProviderFail> {
  const periodDays = period === '7d' ? 7 : 30;

  if (getPortfolioProvider() === 'birdeye') {
    const result = await fetchWalletPnlChartMergedBirdeye(chains, address, periodDays);
    if (!result.ok) return result;
    return result.data;
  }

  const activities = await fetchAllWalletActivityMerged(chains, address, { periodDays });
  return aggregateDailyPnl(activities, periodDays);
}

export function portfolioErrorStatus(result: {
  needsPrivateKey?: boolean;
  gmgnConfigured?: boolean;
  birdeyeConfigured?: boolean;
}): number {
  if (result.birdeyeConfigured === false || result.gmgnConfigured === false) return 503;
  if (result.needsPrivateKey) return 403;
  return 502;
}
