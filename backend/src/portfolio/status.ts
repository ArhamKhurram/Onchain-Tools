import { detectAlgorithm } from '../utils/gmgnSigner.js';
import { gmgnGet, gmgnSignedGet, type GmgnResult } from '../utils/gmgnClient.js';
import {
  fetchWalletHoldings,
  resolvePortfolioChains,
  type GmgnChain,
} from './gmgnWallet.js';

function normalizePrivateKeyPem(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

export type GmgnEnvStatus = {
  gmgnApiKeyConfigured: boolean;
  gmgnApiKeyLength: number;
  gmgnPrivateKeyConfigured: boolean;
  gmgnPrivateKeyAlgorithm: string | null;
  gmgnPrivateKeyParseError: string | null;
};

export function getGmgnEnvStatus(): GmgnEnvStatus {
  const apiKey = process.env.GMGN_API_KEY?.trim();
  const privateKeyPem = normalizePrivateKeyPem(process.env.GMGN_PRIVATE_KEY);

  let algorithm: string | null = null;
  let parseError: string | null = null;
  if (privateKeyPem) {
    try {
      algorithm = detectAlgorithm(privateKeyPem);
    } catch (err) {
      parseError = (err as Error).message;
    }
  }

  return {
    gmgnApiKeyConfigured: !!apiKey,
    gmgnApiKeyLength: apiKey?.length ?? 0,
    gmgnPrivateKeyConfigured: !!privateKeyPem && !parseError,
    gmgnPrivateKeyAlgorithm: algorithm,
    gmgnPrivateKeyParseError: parseError,
  };
}

function probeResult<T>(result: GmgnResult<T>) {
  if (result.ok) return { ok: true as const };
  return {
    ok: false as const,
    error: result.error,
    code: result.code,
    needsPrivateKey: result.needsPrivateKey,
    gmgnConfigured: result.gmgnConfigured,
  };
}

export async function probeGmgn(opts: {
  probeChain?: string;
  probeAddress?: string;
}): Promise<{
  env: GmgnEnvStatus;
  probes: {
    userInfo?: ReturnType<typeof probeResult>;
    holdings?: ReturnType<typeof probeResult> & { chains?: GmgnChain[] };
  };
}> {
  const env = getGmgnEnvStatus();
  const probes: {
    userInfo?: ReturnType<typeof probeResult>;
    holdings?: ReturnType<typeof probeResult> & { chains?: GmgnChain[] };
  } = {};

  if (!env.gmgnApiKeyConfigured) {
    return { env, probes };
  }

  probes.userInfo = probeResult(await gmgnGet<unknown>('/v1/user/info', {}));

  const chainParam = opts.probeChain?.trim();
  const address = opts.probeAddress?.trim();
  if (chainParam && address) {
    const chains = resolvePortfolioChains(chainParam);
    if (!chains) {
      probes.holdings = {
        ok: false,
        error: `Unsupported probe chain: ${chainParam}`,
        code: undefined,
        needsPrivateKey: undefined,
        gmgnConfigured: undefined,
      };
    } else if (chains.length === 1) {
      probes.holdings = {
        ...probeResult(await fetchWalletHoldings(chains[0], address, { limit: 1 })),
        chains,
      };
    } else {
      probes.holdings = {
        ...probeResult(await gmgnSignedGet<{ holdings?: unknown[] }>('/v1/user/wallet_holdings', {
          chain: chains[0],
          wallet_address: address.toLowerCase(),
          limit: 1,
        })),
        chains,
      };
    }
  }

  return { env, probes };
}
