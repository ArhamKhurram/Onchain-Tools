// Outpost bot service layer (DISCORD_BOT_PLAN.md §3). The single home for
// bot-shaped data: called directly by the in-process slash-command handlers
// (Phase 2) and by the /api/v1/bot HTTP routes. Pure mappers are exported for
// unit tests; fetchers reuse OCT's shared FOMO client + caches so bot traffic
// stays inside the same rate/cache budget as the console.

import type {
  BotHolder,
  BotHoldersResponse,
  BotLeaderboardResponse,
  BotNetworkId,
  BotSnapshotResponse,
  BotTokenInfo,
} from '@oct/shared';
import { ensureSharedFomoClientReady } from '../fomo/client.js';
import { extractLeaderboardEntries, networkIdFromContract } from '../fomo/store.js';
import { EXPLORER_BASE, type FomoClientLike } from '../fomo/types.js';
import {
  getCached,
  setCached,
  leaderboardCacheKey,
  hodlersCacheKey,
  LEADERBOARD_TTL_MS,
  HODLERS_TTL_MS,
} from '../fomo/cache.js';
import { getTokenSnapshot } from '../utils/tokenSnapshot.js';

export type BotServiceErrorCode = 'not_configured' | 'upstream' | 'not_found';

export class BotServiceError extends Error {
  constructor(public code: BotServiceErrorCode, message: string) {
    super(message);
    this.name = 'BotServiceError';
  }
}

const FOMO_NOT_CONFIGURED =
  'FOMO service account is not configured. Seed fomo_poll_state.refresh_token or set FOMO_REFRESH_TOKEN.';

// --- Network resolution ---------------------------------------------------

/**
 * Accepts either a numeric FOMO network id ("1399811149") or an OCT chain slug
 * ("sol", "eth", "bsc", "base", "robinhood"/"hood"). Returns null for anything
 * unsupported. Decision §8.1: accept both, default Solana at the call sites.
 */
export function resolveNetworkId(input: string | number | undefined | null): BotNetworkId | null {
  if (input === undefined || input === null || input === '') return null;
  const asNumber = typeof input === 'number' ? input : Number(input);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return asNumber in EXPLORER_BASE ? (asNumber as BotNetworkId) : null;
  }
  const slug = String(input).trim().toLowerCase();
  if (slug === 'sol' || slug === 'solana') return 1399811149;
  return (networkIdFromContract('evm', slug) as BotNetworkId | null) ?? null;
}

export const DEFAULT_NETWORK_ID: BotNetworkId = 1399811149; // Solana

// --- Pure mappers (exported for tests) ------------------------------------

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === 'string' && v.length > 0) return v;
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Parse a FOMO /hodlers/top batch payload into BotHolder rows for one token.
 * Payload shape: { responseObject: [{ tokenAddress|address, networkId, topHolders: [...] }] }
 * (matches matchHoldersToTracked in fomo/store.ts and the old Outpost bot).
 */
export function mapHolders(hodlersJson: any, tokenAddress: string, networkId: number): BotHolder[] {
  const list: any[] = Array.isArray(hodlersJson?.responseObject) ? hodlersJson.responseObject : [];
  const entry =
    list.find(
      (e) =>
        String(e?.tokenAddress ?? e?.address ?? '').toLowerCase() === tokenAddress.toLowerCase() &&
        Number(e?.networkId) === Number(networkId),
    ) ?? list[0];
  const rawHolders: any[] = Array.isArray(entry?.topHolders) ? entry.topHolders : [];

  return rawHolders.map((h, idx) => {
    const user = h?.user ?? {};
    const address = firstString(h?.address, h?.walletAddress, h?.owner) ?? '';
    return {
      rank: idx + 1,
      name:
        firstString(user.displayName, user.userHandle, user.username, user.name) ?? (address || '—'),
      address,
      valueUsd: asNumber(h?.value) ?? 0,
      pnlUsd: asNumber(h?.pnl) ?? 0,
    };
  });
}

/**
 * Parse a FOMO /proxy/filterTokens payload into BotTokenInfo. Mirrors
 * FomoClient.getTokenMetadata (fomo/client.ts) but works on any FomoClientLike
 * result, so it is proxy-mode safe.
 */
export function mapTokenInfo(filterJson: any, tokenAddress: string, networkId: number): BotTokenInfo {
  const entries: any[] = Array.isArray(filterJson?.responseObject) ? filterJson.responseObject : [];
  const entry = entries.find(
    (e) =>
      String(e?.token?.address ?? '').toLowerCase() === tokenAddress.toLowerCase() &&
      Number(e?.token?.networkId) === Number(networkId),
  );

  const empty: BotTokenInfo = {
    address: tokenAddress,
    symbol: null,
    name: null,
    marketCap: null,
    priceUsd: null,
    iconUrl: null,
    description: null,
    socials: {},
  };
  if (!entry?.token) return empty;

  const info = entry.token.info ?? {};
  const social = entry.token.socialLinks ?? {};
  const socials: BotTokenInfo['socials'] = {};
  if (typeof social.twitter === 'string' && social.twitter) socials.twitter = social.twitter;
  if (typeof social.telegram === 'string' && social.telegram) socials.telegram = social.telegram;
  if (typeof social.website === 'string' && social.website) socials.website = social.website;

  return {
    address: tokenAddress,
    symbol: firstString(entry.token.symbol, info.symbol),
    name: firstString(entry.token.name, info.name),
    marketCap: asNumber(entry.marketCap) ?? asNumber(info.marketCap),
    priceUsd: asNumber(entry.priceUSD),
    iconUrl: firstString(info.imageLargeUrl, info.imageSmallUrl, info.imageThumbUrl, info.imageBannerUrl),
    description: firstString(info.description),
    socials,
  };
}

// --- Fetchers --------------------------------------------------------------

async function requireFomoClient(): Promise<FomoClientLike> {
  const client = await ensureSharedFomoClientReady();
  if (!client) throw new BotServiceError('not_configured', FOMO_NOT_CONFIGURED);
  return client;
}

function assertUpstreamOk(status: number | undefined, what: string): void {
  if (!status || status < 200 || status >= 300) {
    throw new BotServiceError('upstream', `FOMO upstream error (${status ?? 0}) fetching ${what}.`);
  }
}

export async function getBotHolders(tokenAddress: string, networkId: BotNetworkId): Promise<BotHoldersResponse> {
  const client = await requireFomoClient();
  const tokens = [{ address: tokenAddress, networkId }];

  // Shares the console's hodlers cache (15 min TTL) — same key, same budget.
  const cacheKey = hodlersCacheKey(tokens);
  let hodlersJson = getCached<any>(cacheKey);
  if (!hodlersJson) {
    const query = encodeURIComponent(JSON.stringify(tokens));
    const result = await client.call(`/hodlers/top?tokens=${query}`);
    assertUpstreamOk(result.status, 'holders');
    hodlersJson = result.json;
    setCached(cacheKey, hodlersJson, HODLERS_TTL_MS);
  }

  const holders = mapHolders(hodlersJson, tokenAddress, networkId);
  if (holders.length === 0) {
    throw new BotServiceError('not_found', 'No holders found for this token.');
  }

  // Token metadata is decorative — never fail the command over it.
  let token: BotTokenInfo = {
    address: tokenAddress,
    symbol: null,
    name: null,
    marketCap: null,
    priceUsd: null,
    iconUrl: null,
    description: null,
    socials: {},
  };
  try {
    const metaCacheKey = `bot:tokenmeta:${networkId}:${tokenAddress.toLowerCase()}`;
    let filterJson = getCached<any>(metaCacheKey);
    if (!filterJson) {
      const result = await client.call('/proxy/filterTokens', {
        method: 'POST',
        body: JSON.stringify([`${tokenAddress}:${networkId}`]),
      });
      if (result.status && result.status >= 200 && result.status < 300) {
        filterJson = result.json;
        setCached(metaCacheKey, filterJson, HODLERS_TTL_MS);
      }
    }
    if (filterJson) token = mapTokenInfo(filterJson, tokenAddress, networkId);
  } catch (err) {
    console.warn('[BotService] token metadata fetch failed:', (err as Error)?.message);
  }

  return {
    token,
    networkId,
    explorerBase: EXPLORER_BASE[networkId] ?? EXPLORER_BASE[DEFAULT_NETWORK_ID],
    holders,
  };
}

export async function getBotLeaderboard(window: '24h' | 'all', limit = 25): Promise<BotLeaderboardResponse> {
  const client = await requireFomoClient();
  const clamped = Math.min(Math.max(limit, 1), 100);
  const windowArg = window === '24h' ? ('24h' as const) : undefined;

  // Shares the console's leaderboard cache (5 min TTL): same key shape, and the
  // cached payload is the fomo route's { entries } envelope.
  const cacheKey = leaderboardCacheKey(windowArg, clamped);
  let payload = getCached<{ entries: ReturnType<typeof extractLeaderboardEntries> }>(cacheKey);
  if (!payload) {
    const result = await client.getLeaderboard(clamped, windowArg);
    assertUpstreamOk(result.status, 'leaderboard');
    payload = { entries: extractLeaderboardEntries(result.json) };
    setCached(cacheKey, payload, LEADERBOARD_TTL_MS);
  }

  return {
    window,
    entries: payload.entries.map((e, idx) => ({
      rank: e.rank ?? idx + 1,
      handle: e.fomoHandle,
      displayName: e.displayName,
      pnlUsd: e.pnl ?? null,
      volumeUsd: e.volume ?? null,
    })),
  };
}

export async function getBotSnapshot(chain: string, address: string): Promise<BotSnapshotResponse> {
  const snapshot = await getTokenSnapshot(chain, address);
  if (!snapshot) {
    return {
      found: false,
      address,
      chain,
      symbol: null,
      name: null,
      marketCap: null,
      marketCapDisplay: null,
      priceUsd: null,
      liquidityUsd: null,
      source: null,
      stale: false,
    };
  }
  return {
    found: true,
    address: snapshot.address,
    chain: snapshot.evmChain ?? snapshot.chain,
    symbol: snapshot.symbol ?? null,
    name: snapshot.name ?? null,
    marketCap: snapshot.mc ?? null,
    marketCapDisplay: snapshot.mcDisplay ?? null,
    priceUsd: snapshot.priceUsd ?? null,
    liquidityUsd: snapshot.liquidityUsd ?? null,
    source: snapshot.source ?? null,
    stale: snapshot.stale,
  };
}
