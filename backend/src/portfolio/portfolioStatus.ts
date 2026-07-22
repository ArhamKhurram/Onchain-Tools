import { isBirdeyeConfigured, type BirdeyeResult } from '../utils/birdeyeClient.js';
import { fetchWalletHoldingsBirdeye, gmgnChainsToBirdeye } from './birdeyeWallet.js';
import { getGmgnEnvStatus } from './status.js';
import { getPortfolioProvider } from './provider.js';
import { resolvePortfolioChains, type GmgnChain } from './gmgnWallet.js';

export function getPortfolioEnvStatus() {
  return {
    provider: getPortfolioProvider(),
    birdeyeConfigured: isBirdeyeConfigured(),
    /** GMGN status for missed-runner / token enrichment — not used by Portfolio routes. */
    gmgn: getGmgnEnvStatus(),
  };
}

function birdeyeProbeResult<T>(result: BirdeyeResult<T>) {
  if (result.ok) return { ok: true as const };
  return {
    ok: false as const,
    error: result.error,
    code: result.code,
    birdeyeConfigured: result.birdeyeConfigured,
  };
}

export async function probePortfolio(opts: {
  probeChain?: string;
  probeAddress?: string;
}): Promise<{
  env: ReturnType<typeof getPortfolioEnvStatus>;
  probes: {
    holdings?: ReturnType<typeof birdeyeProbeResult> & { chains?: GmgnChain[] };
  };
}> {
  const env = getPortfolioEnvStatus();
  const probes: {
    holdings?: ReturnType<typeof birdeyeProbeResult> & { chains?: GmgnChain[] };
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
      birdeyeConfigured: undefined,
    };
    return { env, probes };
  }

  if (!isBirdeyeConfigured()) {
    probes.holdings = {
      ok: false,
      error: 'Portfolio requires BIRDEYE_API_KEY on server.',
      code: undefined,
      birdeyeConfigured: false,
      chains,
    };
    return { env, probes };
  }

  const beChain = gmgnChainsToBirdeye(chains)[0];
  probes.holdings = {
    ...birdeyeProbeResult(await fetchWalletHoldingsBirdeye(beChain, address, 1)),
    chains,
  };

  return { env, probes };
}
