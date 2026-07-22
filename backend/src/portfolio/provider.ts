import {
  fetchWalletActivityMergedBirdeye,
  fetchWalletHoldingsMergedBirdeye,
  fetchWalletPnlChartMergedBirdeye,
  fetchWalletStatsMergedBirdeye,
  isBirdeyeConfigured,
} from './birdeyeWallet.js';
import type { GmgnChain } from './gmgnWallet.js';
import type { DailyPnlResult } from './pnlAggregator.js';

/** Portfolio uses Birdeye only — GMGN is reserved for missed-runner alerts and token enrichment. */
export type PortfolioProvider = 'birdeye';

export function getPortfolioProvider(): PortfolioProvider {
  return 'birdeye';
}

type ProviderFail = {
  ok: false;
  error: string;
  code?: number;
  birdeyeConfigured?: boolean;
};

function birdeyeRequired<T>(): ProviderFail {
  return {
    ok: false,
    error: 'Portfolio requires BIRDEYE_API_KEY on server.',
    birdeyeConfigured: false,
  };
}

export async function fetchPortfolioStats(
  chains: GmgnChain[],
  address: string,
  period: '7d' | '30d',
) {
  if (!isBirdeyeConfigured()) return birdeyeRequired();
  return fetchWalletStatsMergedBirdeye(chains, address, period);
}

export async function fetchPortfolioHoldings(
  chains: GmgnChain[],
  address: string,
  limit: number,
) {
  if (!isBirdeyeConfigured()) return birdeyeRequired();
  return fetchWalletHoldingsMergedBirdeye(chains, address, limit);
}

export async function fetchPortfolioActivity(
  chains: GmgnChain[],
  address: string,
  limit: number,
) {
  if (!isBirdeyeConfigured()) return birdeyeRequired();
  return fetchWalletActivityMergedBirdeye(chains, address, limit);
}

export async function fetchPortfolioPnlDaily(
  chains: GmgnChain[],
  address: string,
  period: '7d' | '30d',
): Promise<DailyPnlResult | ProviderFail> {
  if (!isBirdeyeConfigured()) return birdeyeRequired();

  const periodDays = period === '7d' ? 7 : 30;
  const result = await fetchWalletPnlChartMergedBirdeye(chains, address, periodDays);
  if (!result.ok) return result;
  return result.data;
}

export function portfolioErrorStatus(result: {
  birdeyeConfigured?: boolean;
}): number {
  if (result.birdeyeConfigured === false) return 503;
  return 502;
}
