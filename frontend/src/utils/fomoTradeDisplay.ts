import { buildContractUrl, chainSlugFromNetworkId } from '@oct/shared';
import type { ContractLinkTemplates, FrontendMessage } from '../types';
import type { FomoTradeEvent } from '../types/fomo';

export interface FomoTradeDisplay {
  /** Headline token label — `$SYMBOL`, else a shortened address, else a placeholder. */
  tokenLabel: string;
  /** Full token name for a tooltip/secondary line, when resolved. */
  tokenName: string | null;
  /** Pre-formatted compact market cap (e.g. "$1.2M"), when resolved. */
  marketCapLabel: string | null;
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
  trade: FomoTradeEvent,
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
    tokenName: trade.tokenName?.trim() || null,
    marketCapLabel: trade.marketCapDisplay?.trim() || null,
    shortAddress,
    address,
    chainSlug,
    chartUrl,
    hasSymbol: !!symbol,
  };
}

function formatTradeUsd(value: number | null): string {
  if (value == null) return '';
  const amount = Math.abs(value) >= 1000 ? Math.round(value).toLocaleString() : value.toFixed(2);
  return ` ($${amount})`;
}

/**
 * Synthesize a chat-message-shaped alert so a FOMO buy/sell can flow through
 * the same toast/notification-history pipeline as every other alert type
 * (mirrors buildMissedRunnerMessage on the backend, which does the same for
 * missed-runner alerts).
 */
export function buildFomoTradeAlertMessage(
  trade: FomoTradeEvent,
  display: FomoTradeDisplay,
): FrontendMessage {
  const who = trade.displayName || (trade.fomoHandle ? `@${trade.fomoHandle}` : 'A tracked trader');
  const sideLabel = trade.side === 'sell' ? 'sold' : 'bought';
  const mc = display.marketCapLabel ? ` · MC ${display.marketCapLabel}` : '';

  return {
    id: `fomo-trade-${trade.tradeId ?? Date.now()}`,
    channelId: 'fomo-trade',
    guildId: null,
    channelName: 'FOMO',
    guildName: null,
    author: { id: 'oct-fomo', username: 'OCT', displayName: 'FOMO Trade', avatar: null },
    content: `${who} ${sideLabel} ${display.tokenLabel}${formatTradeUsd(trade.usdValue)}${mc}`,
    timestamp: new Date().toISOString(),
    attachments: [],
    embeds: [],
    isHighlighted: false,
    hasContractAddress: !!trade.tokenAddress,
    contractAddresses: trade.tokenAddress ? [trade.tokenAddress] : [],
    mentions: {},
    platformUrl: display.chartUrl ?? undefined,
  };
}
