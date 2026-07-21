import { isBirdeyeConfigured } from '../utils/birdeyeClient.js';
import { fetchWalletHoldingsBirdeye, gmgnChainsToBirdeye } from './birdeyeWallet.js';
import { probeResult } from './status.js';
import { fetchWalletHoldings, resolvePortfolioChains, type GmgnChain } from './gmgnWallet.js';
import { getGmgnEnvStatus } from './status.js';
import { getPortfolioProvider } from './provider.js';

export function getPortfolioEnvStatus() {
  return {
    provider: getPortfolioProvider(),
    birdeyeConfigured: isBirdeyeConfigured(),
    gmgn: getGmgnEnvStatus(),
  };
}

export async function probePortfolio(opts: {
  probeChain?: string;
  probeAddress?: string;
}): Promise<{
  env: ReturnType<typeof getPortfolioEnvStatus>;
  probes: {
    pnlSummary?: ReturnType<typeof probeResult>;
    holdings?: ReturnType<typeof probeResult> & { chains?: GmgnChain[] };
  };
}> {
  const env = getPortfolioEnvStatus();
  const probes: {
    pnlSummary?: ReturnType<typeof probeResult>;
    holdings?: ReturnType<typeof probeResult> & { chains?: GmgnChain[] };
  } = {};

  const chainParam = opts.probeChain?.trim();
  const address = opts.probeAddress?.trim();
  if (!chainParam || !address) {
    return { env, probes };
  }

  const chains = resolvePortfolioChains(chainParam);
  if (!chains) {
    probes.holdings = {
      ok: false,
      error: `Unsupported probe chain: ${chainParam}`,
      code: undefined,
      needsPrivateKey: undefined,
      gmgnConfigured: undefined,
    };
    return { env, probes };
  }

  if (env.provider === 'birdeye') {
    const beChain = gmgnChainsToBirdeye(chains)[0];
    probes.holdings = {
      ...probeResult(await fetchWalletHoldingsBirdeye(beChain, address, 1)),
      chains,
    };
  } else if (chains.length === 1) {
    probes.holdings = {
      ...probeResult(await fetchWalletHoldings(chains[0], address, { limit: 1 })),
      chains,
    };
  } else {
    probes.holdings = {
      ...probeResult(await fetchWalletHoldings(chains[0], address, { limit: 1 })),
      chains,
    };
  }

  return { env, probes };
}
