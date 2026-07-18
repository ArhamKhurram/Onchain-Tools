// FOMO (fomo.family) API types. Ported from the Outpost bot, decoupled from Discord.

export interface FomoUser {
  displayName: string | null;
  userHandle: string;
  profilePictureLink?: string;
  followers?: number;
  username?: string;
  name?: string;
}

export interface FomoHolder {
  user: FomoUser;
  value: number;
  pnl: number;
  unrealizedPnl: number;
  realizedPnl: number;
  humanAmount?: number;
  address?: string;
}

export interface FomoHodlersTokenEntry {
  tokenAddress: string;
  networkId: number;
  topHolders: FomoHolder[];
  totalHolders: number;
}

export interface FomoHodlersResponse {
  success: boolean;
  responseObject: FomoHodlersTokenEntry[];
}

export interface FomoTokenDetails {
  name?: string | null;
  ticker?: string | null;
  tokenAddress: string;
  networkId: number;
  iconLink?: string | null;
  [key: string]: any;
}

export interface FomoAllowListItem {
  name: string | null;
  ticker: string;
  tokenAddress: string;
  networkId: number;
  createdAt: string;
  isLowFees: boolean;
  categories: string[];
  notes: string;
}

export interface FomoThesisEntry {
  user?: FomoUser;
  comment?: string;
  text?: string;
  value?: number;
  pnl?: number;
  [key: string]: any;
}

export interface FomoUserBalance {
  [key: string]: any;
}

export interface FomoUserBalancesResponse {
  balances?: FomoUserBalance[];
  otherPnl?: number;
  nativeEvmBalances?: any[];
  [key: string]: any;
}

export interface FomoFuzzySearchResult {
  id?: string;
  userId?: string;
  userHandle?: string;
  handle?: string;
  displayName?: string;
  name?: string;
  username?: string;
  [key: string]: any;
}

export type NetworkId = 1 | 56 | 143 | 8453 | 1399811149;

export const EXPLORER_BASE: Record<number, string> = {
  [1]: 'https://etherscan.io/token/',
  [56]: 'https://bscscan.com/token/',
  [143]: 'https://solscan.io/token/',
  [8453]: 'https://basescan.org/token/',
  [1399811149]: 'https://solscan.io/token/',
};

export interface FomoTokenMetadata {
  ticker?: string | null;
  name?: string | null;
  iconLink?: string | null;
  marketCap?: number | null;
  price?: number | null;
  description?: string | null;
  twitter?: string | null;
  telegram?: string | null;
  website?: string | null;
}

/**
 * Everything needed to authenticate against FOMO via Privy and to survive
 * Cloudflare's cold-start bot checks. Only `refreshToken` is strictly required;
 * the rest improve reliability. This shape is credential-source agnostic — the
 * values can come from process.env (single shared account) or from a per-user
 * record in the DB (each OCT user connects their own FOMO account).
 */
export interface FomoCredentials {
  refreshToken: string;
  privyAppId?: string;
  privyClient?: string;
  privyClientId?: string;
  privyCaId?: string;
  privyToken?: string;
  privySession?: string;
  cfClearance?: string;
  cfBm?: string;
  cfUvid?: string;
}

export interface FomoCallResult<T = any> {
  status: number;
  text: string;
  json: T | null;
  errorName?: string;
  errorMessage?: string;
  errorStack?: string;
}
