// Data-access + normalization helpers for the FOMO tracking feature.
//
// The fomo_* tables are not part of the generic StorageProvider interface
// (they are hosted-only and partly service-role-only), so both the REST routes
// and the fan-out poller talk to Supabase directly through a shared service
// client, mirroring the pattern already used in api/routes.ts.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface FomoTrackedUserRow {
  id: string;
  user_id: string;
  fomo_user_id: string;
  fomo_handle: string | null;
  display_name: string | null;
  notify_pushover: boolean;
  created_at: string;
}

let _client: SupabaseClient | null = null;

function resolveSupabaseServiceConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL?.trim();
  const key = (
    process.env.SUPABASE_SERVICE_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )?.trim();
  if (!url || !key) return null;
  return { url, key };
}

/**
 * Lazily construct the process-wide Supabase service client used for all
 * fomo_* table access. Returns null when Supabase is not configured (e.g. local
 * mode), so callers can degrade gracefully instead of throwing.
 */
export function getFomoServiceClient(): SupabaseClient | null {
  if (_client) return _client;
  const cfg = resolveSupabaseServiceConfig();
  if (!cfg) return null;
  _client = createClient(cfg.url, cfg.key, { auth: { persistSession: false } });
  return _client;
}

/** Load the persisted Privy refresh token from fomo_poll_state (prod/dev durable store). */
export async function loadPersistedFomoRefreshToken(): Promise<string | null> {
  const db = getFomoServiceClient();
  if (!db) return null;
  const { data, error } = await db
    .from('fomo_poll_state')
    .select('refresh_token')
    .eq('id', true)
    .single();
  if (error) return null;
  const token = data?.refresh_token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * A single swap from a tracked user's `/v2/users/{id}/activity` feed.
 */
export interface NormalizedTrade {
  tradeId: string | null;
  fomoUserId: string | null;
  fomoHandle: string | null;
  displayName: string | null;
  side: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  networkId: number | null;
  usdValue: number | null;
  raw: unknown;
}

export interface TrackedFomoUserRef {
  fomoUserId: string;
  fomoHandle: string | null;
  displayName: string | null;
}

/** Quote / settlement tokens used to infer buy vs sell (any supported chain). */
const QUOTE_TOKEN_ADDRESSES = new Set(
  [
    // Solana
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    'So11111111111111111111111111111111111111112', // SOL (wrapped)
    // Ethereum (1)
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
    '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', // native ETH placeholder
    // Base (8453)
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
    '0x4200000000000000000000000000000000000006', // WETH
    '0x50c5725949a6f0c72e6c0a4849bb420bc9f0e9bb', // DAI
    // BSC (56)
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
    '0x55d398326f99059ff775485246999027b3197955', // USDT
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', // WBNB
    '0xe9e7cea3dedca5984780bafc599bd69add087d56', // BUSD
    // Robinhood Chain (FOMO networkId 143)
    '0x0bd7d308f8e1639faeb988df18a8011f41eacad73', // WETH
    '0x5fc5360d0400a0fd4f2af552add042d716f1d168', // USDG (Robinhood stable)
  ].map(normalizeTokenAddress),
);

function normalizeTokenAddress(address: string): string {
  const trimmed = address.trim();
  if (trimmed.startsWith('0x')) return trimmed.toLowerCase();
  return trimmed;
}

function isQuoteToken(address: string | null | undefined): boolean {
  if (!address) return false;
  return QUOTE_TOKEN_ADDRESSES.has(normalizeTokenAddress(address));
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

function firstNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/**
 * Best-effort extraction of a single raw trade object into a NormalizedTrade.
 *
 * Every access here is a GUESS until verified against a real FOMO response.
 * The function reads several plausible aliases for each field and never throws;
 * unknown fields become null so a partially-understood payload still flows
 * through fan-out (a trade with no tradeId simply can't be deduped and is
 * skipped by the poller).
 */
export function normalizeTrade(raw: any): NormalizedTrade {
  const r = raw ?? {};
  const user = r.user ?? r.trader ?? r.account ?? r.profile ?? {};
  const token = r.token ?? r.asset ?? {};

  return {
    tradeId: firstString(r.id, r.tradeId, r.trade_id, r.txHash, r.transactionHash, r.signature, r.inTradeId),
    fomoUserId: firstString(user.id, user.userId, r.userId, r.user_id, r.traderId, user.userHandle),
    fomoHandle: firstString(user.userHandle, user.handle, user.username, r.userHandle),
    displayName: firstString(user.displayName, user.name, r.displayName),
    side: (firstString(r.side, r.type, r.action, r.direction, r.activityType) ?? '').toLowerCase() || null,
    tokenAddress: firstString(token.address, r.tokenAddress, r.token_address, r.contractAddress, r.inTokenAddress, r.outTokenAddress),
    tokenSymbol: firstString(token.symbol, token.ticker, r.tokenSymbol, r.ticker),
    networkId: firstNumber(token.networkId, r.networkId, r.network_id, r.chainId, r.inNetworkId, r.outNetworkId),
    usdValue: firstNumber(r.usdValue, r.valueUsd, r.value_usd, r.amountUsd, r.usdAmount, r.humanUsdAmountIn, r.humanUsdAmountOut),
    raw,
  };
}

/**
 * Normalize a `/v2/users/{id}/activity` swap row into a tracked-user trade.
 * Buy = quote → token; sell = token → quote. Works for Solana, EVM (ETH/Base/BSC),
 * Robinhood Chain (FOMO networkId 143), and cross-chain swaps (e.g. SOL USDC → HOOD token).
 */
export function normalizeUserActivity(
  raw: any,
  trader: TrackedFomoUserRef,
): NormalizedTrade | null {
  const r = raw ?? {};
  if (r.activityType && r.activityType !== 'swap') return null;

  const inToken = firstString(r.inTokenAddress);
  const outToken = firstString(r.outTokenAddress);
  if (!inToken || !outToken) return null;

  const inIsQuote = isQuoteToken(inToken);
  const outIsQuote = isQuoteToken(outToken);
  const inNetworkId = firstNumber(r.inNetworkId, r.networkId);
  const outNetworkId = firstNumber(r.outNetworkId, r.networkId);

  let side: string | null = null;
  let tokenAddress: string | null = null;
  let networkId: number | null = null;

  if (inIsQuote && !outIsQuote) {
    side = 'buy';
    tokenAddress = outToken;
    networkId = outNetworkId ?? inNetworkId;
  } else if (!inIsQuote && outIsQuote) {
    side = 'sell';
    tokenAddress = inToken;
    networkId = inNetworkId ?? outNetworkId;
  } else if (!inIsQuote && !outIsQuote) {
    // Token ↔ token — still surface it; default to out side as the subject.
    side = 'swap';
    tokenAddress = outToken;
    networkId = outNetworkId ?? inNetworkId;
  } else {
    // Quote ↔ quote (rare) — skip.
    return null;
  }

  return {
    tradeId: firstString(r.id, r.inTradeId, r.outTradeId),
    fomoUserId: trader.fomoUserId,
    fomoHandle: trader.fomoHandle,
    displayName: trader.displayName,
    side,
    tokenAddress,
    tokenSymbol: null,
    networkId,
    usdValue: firstNumber(r.humanUsdAmountIn, r.humanUsdAmountOut),
    raw,
  };
}

/** Pull swap activities from `/v2/users/{id}/activity`. */
export function extractUserActivitiesArray(json: any): any[] {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  const obj = json.responseObject;
  if (obj && typeof obj === 'object') {
    if (Array.isArray(obj.activities)) return obj.activities;
    if (Array.isArray(obj.activity)) return obj.activity;
  }
  return extractTradesArray(json);
}

/**
 * Pull the array of raw trade objects out of a FOMO getTradingActivity() JSON
 * body. The envelope shape is also UNVERIFIED, so this tries the conventions
 * seen elsewhere in the client (responseObject) plus common fallbacks.
 *
 * TODO(verify): confirm the real envelope key for the trades array.
 */
export function extractTradesArray(json: any): any[] {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  const obj = json.responseObject;
  if (obj && typeof obj === 'object') {
    if (Array.isArray(obj.items)) return obj.items;
    if (Array.isArray(obj.activities)) return obj.activities;
    if (Array.isArray(obj.leaderboard)) return obj.leaderboard;
  }
  const candidates = [
    json.responseObject,
    json.data,
    json.trades,
    json.activity,
    json.items,
    json.results,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

export interface FomoLeaderboardEntry {
  fomoUserId: string;
  fomoHandle: string | null;
  displayName: string | null;
  pnl?: number | null;
  volume?: number | null;
  rank?: number | null;
}

/** Map OCT contract chain hints to FOMO network IDs (subset of supported chains). */
export function networkIdFromContract(chain: 'evm' | 'sol', evmChain?: string | null): number | null {
  if (chain === 'sol') return 1399811149;
  switch ((evmChain ?? '').toLowerCase()) {
    case 'eth':
    case 'ethereum':
      return 1;
    case 'bsc':
    case 'bnb':
      return 56;
    case 'base':
      return 8453;
    case 'robinhood':
    case 'hood':
      return 143;
    default:
      return null;
  }
}

function pickLeaderboardUser(obj: any): { fomoUserId: string; fomoHandle: string | null; displayName: string | null } | null {
  if (!obj || typeof obj !== 'object') return null;
  const user = obj.user ?? obj.trader ?? obj.profile ?? obj;
  const fomoUserId = firstString(user.id, user.userId, user.user_id, obj.userId, obj.id);
  if (!fomoUserId) return null;
  return {
    fomoUserId,
    fomoHandle: firstString(user.userHandle, user.handle, user.username, obj.userHandle),
    displayName: firstString(user.displayName, user.name, obj.displayName),
  };
}

/** Pull leaderboard rows from a FOMO /v2/leaderboard* JSON body. */
function extractLeaderboardArray(json: any): any[] {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  const obj = json.responseObject;
  if (obj && typeof obj === 'object') {
    if (Array.isArray(obj.leaderboard)) return obj.leaderboard;
    if (Array.isArray(obj.leaderBoard)) return obj.leaderBoard;
    if (Array.isArray(obj.entries)) return obj.entries;
    if (Array.isArray(obj.users)) return obj.users;
  }
  return extractTradesArray(json);
}

/** Best-effort extraction of leaderboard rows from a FOMO JSON body. */
export function extractLeaderboardEntries(json: any): FomoLeaderboardEntry[] {
  const rawList = extractLeaderboardArray(json);

  const entries: FomoLeaderboardEntry[] = [];
  for (let i = 0; i < rawList.length; i++) {
    const row = rawList[i];
    const picked = pickLeaderboardUser(row);
    if (!picked) continue;
    entries.push({
      ...picked,
      pnl: firstNumber(
        row.pnl24h,
        row.pnl7d,
        row.pnl30d,
        row.pnlAll,
        row.pnl,
        row.totalPnl,
        row.realizedPnl,
        row.profit,
        row.totalProfit,
      ),
      volume: firstNumber(row.totalVolume, row.volume, row.totalVolumeUsd, row.tradeVolume),
      rank: firstNumber(row.rank, row.position) ?? i + 1,
    });
  }
  return entries;
}

export interface HodlerOverlapResult {
  tokenAddress: string;
  networkId: number;
  trackedCount: number;
  trackedHandles: string[];
}

/** Match FOMO top-holders payload against a set of tracked FOMO user ids/handles. */
export function matchHoldersToTracked(
  tokenAddress: string,
  networkId: number,
  hodlersJson: any,
  trackedById: Map<string, { fomo_handle: string | null }>,
  trackedHandles: Set<string>,
): HodlerOverlapResult {
  const list: any[] = Array.isArray(hodlersJson?.responseObject)
    ? hodlersJson.responseObject
    : [];
  const entry = list.find(
    (e) =>
      String(e?.tokenAddress ?? e?.address ?? '').toLowerCase() === tokenAddress.toLowerCase() &&
      Number(e?.networkId) === Number(networkId),
  );
  const holders: any[] = Array.isArray(entry?.topHolders) ? entry.topHolders : [];
  const matchedHandles = new Set<string>();

  for (const h of holders) {
    const user = h?.user ?? h ?? {};
    const id = firstString(user.id, user.userId, user.user_id);
    const handle = firstString(user.userHandle, user.handle, user.username)?.toLowerCase() ?? null;

    if (id && trackedById.has(id)) {
      const tracked = trackedById.get(id)!;
      matchedHandles.add(tracked.fomo_handle ?? handle ?? id);
      continue;
    }
    if (handle && trackedHandles.has(handle)) {
      matchedHandles.add(handle);
    }
  }

  return {
    tokenAddress,
    networkId,
    trackedCount: matchedHandles.size,
    trackedHandles: [...matchedHandles],
  };
}
