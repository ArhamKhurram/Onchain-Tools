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

/**
 * A FOMO trader's public profile: platform-declared addresses + current
 * holdings + PnL.
 *
 * `solAddress`/`evmAddress` come from the fomo.family *profile* record
 * (`/v2/users/fuzzy-search` fields `address`/`evmAddress`), while the holdings
 * and PnL come from a separate `/v2/users/{id}/balances` call keyed by internal
 * user id. The two are never cross-validated by the vendor, and the addresses
 * themselves have been observed to have no on-chain existence at all (Solana
 * accounts that `getAccountInfo` reports as never created; EVM addresses with
 * nonce 0 and no balance across independent RPCs). Combined with the
 * `isCrossmint` flag on swap records, the conclusion is that fomo.family is
 * custodial and these are platform-internal identifiers, not user-controlled
 * wallets. Present them as declared profile fields — never as verified wallets.
 */
export interface BotWalletProfile {
  /** Internal fomo.family user id — the key every other /v2/users/* call needs. */
  fomoUserId: string;
  displayName: string | null;
  handle: string | null;
  /** Platform-declared Solana address. NOT verified on-chain — see the note above. */
  solAddress: string | null;
  /** Platform-declared EVM address. NOT verified on-chain — see the note above. */
  evmAddress: string | null;
  holdings: BotWalletHolding[];
  portfolioPnlUsd: number;
  livePerpPnlUsd: number;
}

// --- Trader activity (/v2/users/{id}/activity) -----------------------------

/**
 * Direction of a swap, derived from which leg is a quote/settlement token
 * (stablecoin or wrapped native) rather than from any field fomo.family sends —
 * their payload carries no side marker. `swap` covers the two non-directional
 * cases: token↔token and quote↔quote.
 */
export type BotSwapDirection = 'buy' | 'sell' | 'swap';

/** One swap in a trader's activity feed. */
export interface BotTraderSwap {
  kind: 'swap';
  id: string | null;
  /** ISO timestamp (`createdAt`), or null when the record omits it. */
  at: string | null;
  direction: BotSwapDirection;
  /** The traded (non-quote) leg — what the position is actually in. */
  tokenAddress: string | null;
  /** Only present when the payload happens to carry it; usually null. */
  tokenSymbol: string | null;
  /** The settlement leg (the stablecoin/native side), or null when both legs are tokens. */
  quoteTokenAddress: string | null;
  networkId: number | null;
  /** USD size of the settlement leg. */
  usdValue: number | null;
  /** DFLOW | JUPITER | RELAY | OKX — the venue fomo.family routed through. */
  provider: string | null;
  /** Token explorer URL for `tokenAddress`, or null when the network is unmapped. */
  explorerUrl: string | null;
}

/** One deposit/withdrawal in a trader's activity feed. */
export interface BotTraderTransfer {
  kind: 'transfer';
  id: string | null;
  at: string | null;
  /** e.g. `DEPOSIT` — passed through verbatim. */
  transferType: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  networkId: number | null;
  amount: number | null;
  usdValue: number | null;
  fromAddress: string | null;
  toAddress: string | null;
  explorerUrl: string | null;
}

export type BotTraderActivityEntry = BotTraderSwap | BotTraderTransfer;

export interface BotTraderActivitySummary {
  swapCount: number;
  transferCount: number;
  /** Total USD spent on `buy` swaps in the returned window. */
  buyUsd: number;
  /** Total USD received from `sell` swaps in the returned window. */
  sellUsd: number;
  /** Oldest and newest `createdAt` in the window; null when nothing is dated. */
  fromAt: string | null;
  toAt: string | null;
}

export interface BotTraderActivityResponse {
  fomoUserId: string;
  /** Records actually requested. fomo.family rejects anything over 100. */
  limit: number;
  entries: BotTraderActivityEntry[];
  summary: BotTraderActivitySummary;
  /**
   * fomo.family reported more records than it returned, and offers no working
   * way to reach them (see FOMO_ACTIVITY_MAX_LIMIT in backend/src/fomo/activity.ts).
   * Consumers must show this as "most recent N only", never as a complete history.
   */
  truncated: boolean;
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
