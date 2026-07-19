import type { AppConfig, ContractEntry, FrontendMessage } from '../types';
import type { FomoTrade } from '../types/fomo';

/** Default window: contract in feed + FOMO buy within 30 minutes. */
export const SIGNAL_CONVERGENCE_WINDOW_MS = 30 * 60 * 1000;
export const DEFAULT_SIGNAL_CONVERGENCE_WINDOW_MINUTES = 30;

export interface SignalConvergenceMatch {
  contract: ContractEntry;
  trade: FomoTrade;
  key: string;
}

export function getSignalConvergenceWindowMs(config?: AppConfig | null): number {
  const minutes = config?.signalConvergenceWindowMinutes ?? DEFAULT_SIGNAL_CONVERGENCE_WINDOW_MINUTES;
  return Math.max(1, minutes) * 60_000;
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function isFomoBuySide(side: string | null | undefined): boolean {
  if (!side) return false;
  const normalized = side.trim().toLowerCase();
  return normalized === 'buy' || normalized === 'long' || normalized === 'bought';
}

export function addressesMatch(contractAddress: string, tokenAddress: string | null | undefined): boolean {
  if (!tokenAddress) return false;
  return normalizeAddress(contractAddress) === normalizeAddress(tokenAddress);
}

export function findConvergenceForTrade(
  trade: FomoTrade,
  contracts: ContractEntry[],
  windowMs = SIGNAL_CONVERGENCE_WINDOW_MS,
): ContractEntry | null {
  if (!isFomoBuySide(trade.side) || !trade.tokenAddress) return null;

  const tradeTime = trade.receivedAt;
  const token = normalizeAddress(trade.tokenAddress);

  for (const contract of contracts) {
    if (normalizeAddress(contract.address) !== token) continue;
    const contractTime = new Date(contract.timestamp).getTime();
    if (Number.isNaN(contractTime)) continue;
    if (Math.abs(tradeTime - contractTime) <= windowMs) {
      return contract;
    }
  }
  return null;
}

export function findConvergenceForContract(
  contract: ContractEntry,
  trades: FomoTrade[],
  windowMs = SIGNAL_CONVERGENCE_WINDOW_MS,
): FomoTrade | null {
  const contractTime = new Date(contract.timestamp).getTime();
  if (Number.isNaN(contractTime)) return null;

  for (const trade of trades) {
    if (!isFomoBuySide(trade.side)) continue;
    if (!addressesMatch(contract.address, trade.tokenAddress)) continue;
    if (Math.abs(trade.receivedAt - contractTime) <= windowMs) {
      return trade;
    }
  }
  return null;
}

export function findConvergenceForAddress(
  address: string,
  contracts: ContractEntry[],
  trades: FomoTrade[],
  windowMs = SIGNAL_CONVERGENCE_WINDOW_MS,
): FomoTrade | null {
  const normalized = normalizeAddress(address);
  for (const contract of contracts) {
    if (normalizeAddress(contract.address) !== normalized) continue;
    const trade = findConvergenceForContract(contract, trades, windowMs);
    if (trade) return trade;
  }
  return null;
}

export function convergenceAlertReason(contract: ContractEntry, trade: FomoTrade): string {
  const trader = trade.displayName || (trade.fomoHandle ? `@${trade.fomoHandle}` : 'Tracked trader');
  const token = trade.tokenSymbol || contract.tokenSymbol || contract.address.slice(0, 8);
  const channel = contract.channelName || 'feed';
  return `Signal convergence: ${trader} bought ${token} — also called in ${channel}`;
}

export function convergenceAlertMessage(
  contract: ContractEntry,
  trade: FomoTrade,
  windowMinutes = DEFAULT_SIGNAL_CONVERGENCE_WINDOW_MINUTES,
): FrontendMessage {
  const token = trade.tokenSymbol || contract.tokenSymbol || contract.address;
  const trader = trade.displayName || trade.fomoHandle || 'Tracked trader';
  return {
    id: `convergence-${contract.messageId}-${contract.address}-${trade.key}`,
    channelId: contract.channelId,
    guildId: contract.guildId,
    channelName: contract.channelName,
    guildName: contract.guildName,
    author: {
      id: trade.fomoUserId ?? 'fomo',
      username: trade.fomoHandle ?? trader,
      displayName: trader,
      avatar: null,
    },
    content: `${trader} bought ${token} within ${windowMinutes}m of a contract call in ${contract.channelName}.`,
    timestamp: new Date().toISOString(),
    attachments: [],
    embeds: [],
    isHighlighted: true,
    hasContractAddress: true,
    contractAddresses: [contract.address],
    mentions: {},
  };
}

export function convergenceKey(contract: ContractEntry, trade: FomoTrade): string {
  return `${normalizeAddress(contract.address)}:${trade.fomoUserId ?? trade.fomoHandle ?? trade.key}`;
}
