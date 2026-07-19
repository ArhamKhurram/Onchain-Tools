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
 * A single trade from FOMO's trading-activity feed, normalized into the shape
 * the fan-out poller and fomo_trade_events table expect.
 *
 * !! FIELD NAMES ARE UNVERIFIED !! The exact JSON shape/scope of
 * `/feed/tradingActivity` has not been confirmed against a live response. Every
 * field extracted in `normalizeTrade` below is marked with a TODO so it can be
 * checked against a real payload (logged behind DEBUG on first poll). Treat the
 * current key guesses as best-effort until verified.
 */
export interface NormalizedTrade {
  tradeId: string | null;        // TODO(verify): FOMO's stable id for the trade (dedup key)
  fomoUserId: string | null;     // TODO(verify): stable id of the trader
  fomoHandle: string | null;     // TODO(verify): trader's @handle
  displayName: string | null;    // TODO(verify): trader's display name
  side: string | null;           // TODO(verify): 'buy' | 'sell'
  tokenAddress: string | null;   // TODO(verify): traded token contract address
  tokenSymbol: string | null;    // TODO(verify): traded token ticker/symbol
  networkId: number | null;      // TODO(verify): chain/network id
  usdValue: number | null;       // TODO(verify): USD notional of the trade
  raw: unknown;                  // full raw object, persisted for later verification
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
  // Trader may be nested under `user`, `trader`, `account`, or flattened.
  const user = r.user ?? r.trader ?? r.account ?? r.profile ?? {};
  // Token may be nested under `token`, or flattened onto the trade.
  const token = r.token ?? r.asset ?? {};

  return {
    // TODO(verify): dedup id. Aliases guessed: id / tradeId / txHash / transactionHash / signature.
    tradeId: firstString(r.id, r.tradeId, r.trade_id, r.txHash, r.transactionHash, r.signature),
    // TODO(verify): trader stable id. Aliases: user.id / userId / user.userId / traderId.
    fomoUserId: firstString(user.id, user.userId, r.userId, r.user_id, r.traderId, user.userHandle),
    // TODO(verify): trader handle. Aliases: user.userHandle / user.handle / user.username.
    fomoHandle: firstString(user.userHandle, user.handle, user.username, r.userHandle),
    // TODO(verify): trader display name. Aliases: user.displayName / user.name.
    displayName: firstString(user.displayName, user.name, r.displayName),
    // TODO(verify): buy/sell direction. Aliases: side / type / action / direction (may be 'BUY'/'SELL').
    side: (firstString(r.side, r.type, r.action, r.direction) ?? '').toLowerCase() || null,
    // TODO(verify): token contract address. Aliases: token.address / tokenAddress / contractAddress.
    tokenAddress: firstString(token.address, r.tokenAddress, r.token_address, r.contractAddress),
    // TODO(verify): token symbol. Aliases: token.symbol / tokenSymbol / ticker.
    tokenSymbol: firstString(token.symbol, token.ticker, r.tokenSymbol, r.ticker),
    // TODO(verify): network/chain id. Aliases: token.networkId / networkId / chainId.
    networkId: firstNumber(token.networkId, r.networkId, r.network_id, r.chainId),
    // TODO(verify): USD notional. Aliases: usdValue / valueUsd / amountUsd / usdAmount.
    usdValue: firstNumber(r.usdValue, r.valueUsd, r.value_usd, r.amountUsd, r.usdAmount),
    raw,
  };
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
