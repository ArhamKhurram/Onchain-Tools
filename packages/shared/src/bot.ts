// Bot-facing DTO contract — shared by the in-process OCT bot handlers and
// the /api/v1/bot HTTP routes (see docs/architecture/discord-bot.md). These are deliberately
// bot-shaped: short, embed-friendly fields, never raw internal types.

/** FOMO network ids the bot understands (subset OCT supports). */
export type BotNetworkId = 1 | 56 | 143 | 8453 | 1399811149;

export interface BotTokenInfo {
  address: string;
  symbol: string | null;
  name: string | null;
  marketCap: number | null;
  priceUsd: number | null;
  iconUrl: string | null;
  description: string | null;
  socials: { twitter?: string; telegram?: string; website?: string };
}

export interface BotHolder {
  rank: number;
  /** Display name > handle > wallet address fallback. */
  name: string;
  /** Wallet address ('' when the payload omits it). */
  address: string;
  valueUsd: number;
  pnlUsd: number;
}

export interface BotHoldersResponse {
  token: BotTokenInfo;
  networkId: BotNetworkId;
  /** Explorer URL prefix for this network (append an address). */
  explorerBase: string;
  holders: BotHolder[];
}

/**
 * One trader's written thesis on a token: their position, PnL, and the text.
 * Shaped like the fomo.family "theses" panel — display-facing fields only, the
 * raw FomoThesisEntry `[k]: any` junk narrowed away. valueUsd/pnlUsd follow the
 * BotHolder convention so the console reuses the same USD formatters.
 */
export interface BotThesisEntry {
  /** Display label: display name > handle > username. */
  handle: string;
  /** The trader's X/handle (fomo.family logins are X-based), or null. */
  xHandle: string | null;
  /** Full X profile URL when we can build one, else null. */
  xUrl: string | null;
  /** Avatar image URL, or null. */
  avatar: string | null;
  valueUsd: number;
  pnlUsd: number;
  /** The written thesis (comment > text). '' when the entry carries none. */
  thesis: string;
}

export interface BotThesesResponse {
  networkId: BotNetworkId;
  /** Explorer URL prefix for this network (append an address). */
  explorerBase: string;
  theses: BotThesisEntry[];
}

export interface BotLeaderboardEntry {
  rank: number;
  handle: string | null;
  displayName: string | null;
  pnlUsd: number | null;
  volumeUsd: number | null;
}

export interface BotLeaderboardResponse {
  window: '24h' | 'all';
  entries: BotLeaderboardEntry[];
}

export interface BotSnapshotResponse {
  found: boolean;
  address: string;
  chain: string;
  symbol: string | null;
  name: string | null;
  marketCap: number | null;
  marketCapDisplay: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  source: string | null;
  /** Snapshot age indicator — true when served from a stale catalog entry. */
  stale: boolean;
}

/** One position in a trader's `/wallet` holdings list. */
export interface BotWalletHolding {
  symbol: string;
  valueUsd: number;
  pnlUsd: number;
}

/** A FOMO trader's public profile: wallets + current holdings + PnL. */
export interface BotWalletProfile {
  displayName: string | null;
  handle: string | null;
  solAddress: string | null;
  evmAddress: string | null;
  holdings: BotWalletHolding[];
  portfolioPnlUsd: number;
  livePerpPnlUsd: number;
}

/** Phase 2b — the linked OCT account's tracked FOMO traders. */
export interface BotTrackedTrader {
  handle: string | null;
  displayName: string | null;
  trackedAt: string;
}

export interface BotTrackedResponse {
  traders: BotTrackedTrader[];
}
