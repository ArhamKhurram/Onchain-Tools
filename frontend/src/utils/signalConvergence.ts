import type { AppConfig, ContractEntry, FrontendMessage } from '../types';
import type { FomoTrade } from '../types/fomo';

/** Default window: contract in feed + FOMO buy within 30 minutes. */
const SIGNAL_CONVERGENCE_WINDOW_MS = 30 * 60 * 1000;
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

  // occurredAt, not receivedAt: a replayed trade is stamped with its arrival in
  // this session, so comparing arrival times would make every day-old trade look
  // simultaneous with whatever was called around the page load.
  const tradeTime = trade.occurredAt;
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
    if (Math.abs(trade.occurredAt - contractTime) <= windowMs) {
      return trade;
    }
  }
  return null;
}

// Buy-side trades bucketed by normalized token address, cached per trades-array
// identity. The per-row convergence subscription runs its selector on EVERY
// store write (that is how zustand decides whether to re-render), so the lookup
// must be O(1) unless the trades array actually changed reference.
const buyIndexCache = new WeakMap<FomoTrade[], Map<string, FomoTrade[]>>();

function buyTradesByToken(trades: FomoTrade[]): Map<string, FomoTrade[]> {
  let index = buyIndexCache.get(trades);
  if (!index) {
    index = new Map();
    // Array order is preserved inside each bucket so the first match is the
    // same trade findConvergenceForContract would have returned.
    for (const trade of trades) {
      if (!isFomoBuySide(trade.side) || !trade.tokenAddress) continue;
      const key = normalizeAddress(trade.tokenAddress);
      const bucket = index.get(key);
      if (bucket) bucket.push(trade);
      else index.set(key, [trade]);
    }
    buyIndexCache.set(trades, index);
  }
  return index;
}

/**
 * `findConvergenceForContract`, but suitable for use inside a zustand selector:
 * the trades scan is replaced by a WeakMap-cached by-token index, so the common
 * per-store-write call is a couple of map lookups instead of an O(trades) scan
 * per contract row. Returns the identical trade object (identity-stable while
 * the match is unchanged, so Object.is keeps the subscriber quiet).
 */
export function findConvergenceForContractIndexed(
  contract: ContractEntry,
  trades: FomoTrade[],
  windowMs = SIGNAL_CONVERGENCE_WINDOW_MS,
): FomoTrade | null {
  const candidates = buyTradesByToken(trades).get(normalizeAddress(contract.address));
  if (!candidates) return null;
  const contractTime = new Date(contract.timestamp).getTime();
  if (Number.isNaN(contractTime)) return null;
  for (const trade of candidates) {
    if (Math.abs(trade.occurredAt - contractTime) <= windowMs) {
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

/**
 * Convergence for every address at once: one pass over contracts and trades
 * instead of a full rescan per address. For each address that has a match the
 * map holds exactly the trade `findConvergenceForAddress` would return —
 * contracts are walked in order, and within a contract the trades are tried
 * in order, so the first (contract, trade) pair wins identically. Keys are
 * normalized (trimmed, lowercased) addresses.
 *
 * Built for render loops: the radar rebuilds this once per data change and
 * does O(1) lookups per row, where it used to rescan everything per row per
 * render.
 */
export function buildConvergenceIndex(
  contracts: ContractEntry[],
  trades: FomoTrade[],
  windowMs = SIGNAL_CONVERGENCE_WINDOW_MS,
): Map<string, FomoTrade> {
  const result = new Map<string, FomoTrade>();
  if (contracts.length === 0 || trades.length === 0) return result;

  // Buy-side trades grouped by token, preserving trades order — the order
  // findConvergenceForContract scans them in.
  const tradesByToken = new Map<string, FomoTrade[]>();
  for (const trade of trades) {
    if (!isFomoBuySide(trade.side) || !trade.tokenAddress) continue;
    const token = normalizeAddress(trade.tokenAddress);
    const list = tradesByToken.get(token);
    if (list) list.push(trade);
    else tradesByToken.set(token, [trade]);
  }
  if (tradesByToken.size === 0) return result;

  for (const contract of contracts) {
    const address = normalizeAddress(contract.address);
    if (result.has(address)) continue;
    const candidates = tradesByToken.get(address);
    if (!candidates) continue;
    const contractTime = new Date(contract.timestamp).getTime();
    if (Number.isNaN(contractTime)) continue;
    for (const trade of candidates) {
      if (Math.abs(trade.occurredAt - contractTime) <= windowMs) {
        result.set(address, trade);
        break;
      }
    }
  }
  return result;
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
