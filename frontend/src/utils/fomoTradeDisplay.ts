import { buildContractUrl, chainSlugFromNetworkId } from '@oct/shared';
import type { ContractLinkTemplates } from '../types';
import type { FomoTrade } from '../types/fomo';

export interface FomoTradeDisplay {
  /** Headline token label — `$SYMBOL`, else a shortened address, else a placeholder. */
  tokenLabel: string;
  /** `abcd…wxyz` secondary context; null when there's no address. */
  shortAddress: string | null;
  /** Full address for tooltips/copy. */
  address: string | null;
  /** OCT chain slug ('sol', 'eth', …) or null when the network is unknown. */
  chainSlug: string | null;
  /** Chart/trade link, or null when we can't build one. */
  chartUrl: string | null;
  /** True when the symbol resolved — the address is then only shown as context. */
  hasSymbol: boolean;
}

/**
 * What the live FOMO feed should show for a trade. FOMO's activity payload
 * identifies tokens by address, so the backend resolves a symbol from OCT's
 * token catalog; this falls back gracefully when that hasn't happened yet.
 */
export function fomoTradeDisplay(
  trade: FomoTrade,
  templates?: ContractLinkTemplates | null,
): FomoTradeDisplay {
  const address = trade.tokenAddress?.trim() || null;
  const symbol = trade.tokenSymbol?.trim() || null;
  const shortAddress = address ? `${address.slice(0, 4)}…${address.slice(-4)}` : null;
  const chainSlug = chainSlugFromNetworkId(trade.networkId);

  let chartUrl: string | null = null;
  if (address && templates) {
    try {
      // buildContractUrl infers sol vs evm from the address; the slug only
      // matters for pointing EVM links at the right chain.
      chartUrl = buildContractUrl(address, templates, chainSlug && chainSlug !== 'sol' ? chainSlug : undefined);
    } catch {
      chartUrl = null;
    }
  }

  return {
    tokenLabel: symbol ? `$${symbol.toUpperCase()}` : (shortAddress ?? 'Unknown token'),
    shortAddress,
    address,
    chainSlug,
    chartUrl,
    hasSymbol: !!symbol,
  };
}
