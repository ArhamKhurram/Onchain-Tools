// OCT bot service layer (see docs/architecture/discord-bot.md). The single home for
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
  BotThesesResponse,
  BotThesisEntry,
  BotTokenInfo,
  BotTrackedResponse,
  BotWalletProfile,
} from '@oct/shared';
import { ensureSharedFomoClientReady } from '../fomo/client.js';
import { getFomoServiceClient } from '../fomo/store.js';
import { resolveOctUserByDiscordId } from './identity.js';
import { extractLeaderboardEntries, networkIdFromContract } from '../fomo/store.js';
import { EXPLORER_BASE, type FomoClientLike } from '../fomo/types.js';
import {
  getCached,
  setCached,
  leaderboardCacheKey,
  hodlersCacheKey,
  thesesCacheKey,
  LEADERBOARD_TTL_MS,
  HODLERS_TTL_MS,
  THESES_TTL_MS,
} from '../fomo/cache.js';
import { getTokenSnapshot } from '../utils/tokenSnapshot.js';

export type BotServiceErrorCode = 'not_configured' | 'upstream' | 'not_found' | 'not_linked';

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

/** EVM chains FOMO indexes, most-used first — the probe order for `0x…` addresses. */
export const EVM_NETWORK_IDS: readonly BotNetworkId[] = [56, 1, 8453, 143];

/** `0x` + 40 hex is an EVM address; anything else we treat as base58/Solana. */
export function isEvmAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address.trim());
}

/**
 * Which networks to ask FOMO about when the caller did not name one. An `0x…`
 * address is definitely not Solana but does not say *which* EVM chain, so we
 * probe them all; a base58 address can only be Solana.
 */
export function candidateNetworkIds(tokenAddress: string): BotNetworkId[] {
  return isEvmAddress(tokenAddress) ? [...EVM_NETWORK_IDS] : [DEFAULT_NETWORK_ID];
}

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
export function mapHolders(
  hodlersJson: any,
  tokenAddress: string,
  networkId: number,
  // When a single network was requested we fall back to the first entry, since
  // the API may echo a different casing. When probing several networks at once
  // that fallback would attribute one chain's holders to another, so opt out.
  strict = false,
): BotHolder[] {
  const list: any[] = Array.isArray(hodlersJson?.responseObject) ? hodlersJson.responseObject : [];
  const matched = list.find(
    (e) =>
      String(e?.tokenAddress ?? e?.address ?? '').toLowerCase() === tokenAddress.toLowerCase() &&
      Number(e?.networkId) === Number(networkId),
  );
  const entry = matched ?? (strict ? null : list[0]);
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

/**
 * Pull the array of raw thesis entries out of a FOMO /feed/token/thesis body.
 * The envelope is unverified against a live response, so try the conventions the
 * rest of the client uses (responseObject) plus a bare-array/common fallbacks.
 */
function extractThesesArray(json: any): any[] {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  const obj = json.responseObject;
  if (Array.isArray(obj)) return obj;
  if (obj && typeof obj === 'object') {
    if (Array.isArray(obj.theses)) return obj.theses;
    if (Array.isArray(obj.entries)) return obj.entries;
    if (Array.isArray(obj.items)) return obj.items;
  }
  for (const c of [json.theses, json.data, json.entries, json.items, json.results]) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

// fomo.family logins are X-based, so a bare handle usually IS the X handle. Some
// payloads may also carry an explicit twitter field/URL — prefer those.
// TODO(verify): confirm the real user field aliases against a live thesis response.
function pickXHandle(user: any): string | null {
  const raw = firstString(
    user.twitterHandle,
    user.twitterUsername,
    user.xHandle,
    user.twitter,
    user.userHandle,
    user.handle,
    user.username,
  );
  return raw ? raw.replace(/^@/, '') : null;
}

function buildXUrl(user: any, xHandle: string | null): string | null {
  const explicit = firstString(user.userTwitterUrl, user.twitterUrl, user.xUrl);
  if (explicit) return explicit;
  return xHandle ? `https://x.com/${xHandle}` : null;
}

/**
 * Parse a FOMO /feed/token/thesis payload into BotThesisEntry rows. Best-effort
 * and defensive: reads several field aliases, coerces numeric strings, narrows
 * away the raw `[k]: any` junk, and drops entries that carry no user (per the
 * feature contract) instead of throwing. thesis = comment > text.
 */
export function mapTheses(thesisJson: any): BotThesisEntry[] {
  const rows = extractThesesArray(thesisJson);
  const out: BotThesisEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;

    // Identity is TOP-LEVEL on the real /feed/token/thesis item (userHandle /
    // displayName), NOT nested under row.user — the original guess required a
    // row.user object and so dropped every real row. Support the nested shape
    // as a fallback, prefer the real top-level fields.
    const user = (row.user ?? row.trader ?? row.profile ?? row) as any;
    const handle = firstString(
      row.userHandle,
      row.displayName,
      user.displayName,
      user.userHandle,
      user.username,
      user.name,
      user.handle,
    );
    if (!handle) continue; // no identity → drop

    // `comment` is an OBJECT ({ comment: "text", ... }) on the real feed, not a
    // bare string. Read the nested text first, then the guessed-shape fallbacks.
    const thesis =
      (row.comment && typeof row.comment === 'object'
        ? firstString(row.comment.comment, row.comment.text)
        : firstString(row.comment)) ?? firstString(row.text);

    // Position value and PnL live under authorTrade on the real feed.
    const trade = (row.authorTrade ?? null) as any;
    const valueUsd = asNumber(trade?.usdValue) ?? asNumber(row.value) ?? 0;
    const pnlUsd =
      asNumber(trade?.unrealizedPnlUsd) != null || asNumber(trade?.realizedPnlUsd) != null
        ? (asNumber(trade?.unrealizedPnlUsd) ?? 0) + (asNumber(trade?.realizedPnlUsd) ?? 0)
        : asNumber(row.pnl) ?? 0;

    const xHandle = pickXHandle(user);
    out.push({
      handle,
      xHandle,
      xUrl: buildXUrl(user, xHandle),
      avatar: firstString(row.profilePictureLink, user.profilePictureLink, user.avatar, user.pfp, user.image),
      valueUsd,
      pnlUsd,
      thesis: (thesis ?? '').trim(),
    });
  }
  return out;
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

/**
 * Top FOMO holders for a token. Pass `networkId: null` to let the address
 * decide: `/hodlers/top` takes a batch, so probing every EVM chain costs the
 * same one request as guessing wrong did.
 */
export async function getBotHolders(
  tokenAddress: string,
  networkId: BotNetworkId | null,
): Promise<BotHoldersResponse> {
  const client = await requireFomoClient();
  const candidates = networkId != null ? [networkId] : candidateNetworkIds(tokenAddress);
  const tokens = candidates.map((id) => ({ address: tokenAddress, networkId: id }));

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

  // Whichever candidate actually has holders is the chain the token lives on.
  const multi = candidates.length > 1;
  let resolved: BotNetworkId = candidates[0]!;
  let holders: BotHolder[] = [];
  for (const id of candidates) {
    const found = mapHolders(hodlersJson, tokenAddress, id, multi);
    if (found.length > holders.length) {
      holders = found;
      resolved = id;
    }
  }

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
    const metaCacheKey = `bot:tokenmeta:${resolved}:${tokenAddress.toLowerCase()}`;
    let filterJson = getCached<any>(metaCacheKey);
    if (!filterJson) {
      const result = await client.call('/proxy/filterTokens', {
        method: 'POST',
        body: JSON.stringify([`${tokenAddress}:${resolved}`]),
      });
      if (result.status && result.status >= 200 && result.status < 300) {
        filterJson = result.json;
        setCached(metaCacheKey, filterJson, HODLERS_TTL_MS);
      }
    }
    if (filterJson) token = mapTokenInfo(filterJson, tokenAddress, resolved);
  } catch (err) {
    console.warn('[BotService] token metadata fetch failed:', (err as Error)?.message);
  }

  return {
    token,
    networkId: resolved,
    explorerBase: EXPLORER_BASE[resolved] ?? EXPLORER_BASE[DEFAULT_NETWORK_ID],
    holders,
  };
}

/**
 * Written theses for a token: each row is a FOMO trader's position, PnL and
 * text. Pass `networkId: null` to let the address decide the chain — the thesis
 * endpoint is single-network (unlike the batched holders call), so an `0x…`
 * address probes each EVM chain in turn and stops at the first that has theses.
 * Empty is a normal result (nobody wrote one), so this never throws not_found;
 * it only throws upstream when *every* probed network failed to respond 2xx.
 */
export async function getBotTheses(
  tokenAddress: string,
  networkId: BotNetworkId | null,
): Promise<BotThesesResponse> {
  const client = await requireFomoClient();
  const candidates = networkId != null ? [networkId] : candidateNetworkIds(tokenAddress);

  let resolved: BotNetworkId = candidates[0]!;
  let theses: BotThesisEntry[] = [];
  let sawOk = false;
  let lastStatus: number | undefined;

  for (const id of candidates) {
    const cacheKey = thesesCacheKey(id, tokenAddress);
    let entries = getCached<BotThesisEntry[]>(cacheKey);
    if (!entries) {
      // threshold 0 = no minimum position filter, so we surface EVERY thesis.
      // The client default (1000) silently hid theses from smaller positions —
      // there's no reason to limit; the point of the view is to read them all.
      const result = await client.getTokenTheses(tokenAddress, id, 0);
      lastStatus = result.status;
      if (!result.status || result.status < 200 || result.status >= 300) {
        continue; // this chain failed — try the next candidate
      }
      entries = mapTheses(result.json);
      setCached(cacheKey, entries, THESES_TTL_MS);
    }
    sawOk = true;
    // Whichever candidate actually has theses is the chain the token lives on.
    if (entries.length > theses.length) {
      theses = entries;
      resolved = id;
    }
    if (theses.length > 0) break;
  }

  // Never got a 2xx from any candidate → surface as an upstream failure (502).
  if (!sawOk) assertUpstreamOk(lastStatus, 'theses');

  return {
    networkId: resolved,
    explorerBase: EXPLORER_BASE[resolved] ?? EXPLORER_BASE[DEFAULT_NETWORK_ID],
    theses,
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

/**
 * The tracked FOMO traders of the OCT account linked to this Discord user.
 * Throws BotServiceError('not_linked') when the Discord account has no OCT
 * account — callers turn that into the "link Discord on OCT" message.
 */
export async function getBotTracked(discordUserId: string): Promise<BotTrackedResponse> {
  const db = getFomoServiceClient();
  if (!db) throw new BotServiceError('not_configured', 'FOMO tracking is not available (storage not configured).');

  const octUserId = await resolveOctUserByDiscordId(discordUserId);
  if (!octUserId) {
    throw new BotServiceError(
      'not_linked',
      'This Discord account is not linked to an OCT account.',
    );
  }

  const { data, error } = await db
    .from('fomo_tracked_users')
    .select('fomo_handle, display_name, created_at')
    .eq('user_id', octUserId)
    .order('created_at', { ascending: false });
  if (error) throw new BotServiceError('upstream', 'Could not load your tracked traders.');

  return {
    traders: (data ?? []).map((row: any) => ({
      handle: row.fomo_handle ?? null,
      displayName: row.display_name ?? null,
      trackedAt: row.created_at,
    })),
  };
}

/**
 * Look up a FOMO trader by handle/display name/fuzzy search and return their
 * public wallet addresses + current holdings + PnL. Ported from the standalone
 * Outpost bot's /wallets command (proven against the real API), now reading
 * through FomoClientLike so it also works in proxy mode.
 */
export async function getBotWallet(searchTerm: string): Promise<BotWalletProfile> {
  const client = await requireFomoClient();

  const searchResult = await client.searchUsers(searchTerm);
  assertUpstreamOk(searchResult.status, 'user search');

  const searchJson: any = searchResult.json;
  const users = searchJson?.responseObject?.users ?? searchJson?.responseObject ?? searchJson?.users ?? searchJson?.data ?? [];
  const candidates: any[] = Array.isArray(users) ? users : [];
  if (candidates.length === 0) {
    throw new BotServiceError('not_found', `No FOMO user found matching "${searchTerm}".`);
  }

  const term = searchTerm.toLowerCase();
  const exactMatch = candidates.find((u) => String(u.userHandle ?? u.handle ?? '').toLowerCase() === term);
  const target =
    exactMatch ??
    candidates.reduce((best, u) =>
      Number(u.followers || 0) + Number(u.totalVolume || 0) > Number(best.followers || 0) + Number(best.totalVolume || 0)
        ? u
        : best,
      candidates[0],
    );

  let userId: string | null = firstString(target.id, target.userId, target.user_id);
  let userHandle = firstString(target.userHandle, target.handle, target.username) ?? searchTerm;
  let displayName = firstString(target.displayName, target.name) ?? userHandle;
  const solAddress = firstString(target.address);
  const evmAddress = firstString(target.evmAddress);

  if (!userId && userHandle) {
    const profileResult = await client.getUserByHandle(userHandle);
    if (profileResult.status && profileResult.status >= 200 && profileResult.status < 300) {
      const profile: any = profileResult.json;
      userId = firstString(profile?.id, profile?.userId) ?? userId;
      displayName = firstString(profile?.displayName, profile?.name) ?? displayName;
      userHandle = firstString(profile?.userHandle, profile?.handle) ?? userHandle;
    }
  }

  if (!userId) {
    throw new BotServiceError('not_found', `Found "${displayName}" but couldn't resolve their FOMO id.`);
  }

  const balancesResult = await client.getUserBalances(userId);
  assertUpstreamOk(balancesResult.status, 'balances');

  const balances: any = balancesResult.json;
  const responseObject = balances?.responseObject ?? balances;
  const balanceList: any[] = Array.isArray(responseObject?.balances) ? responseObject.balances : [];
  const otherPnl = asNumber(responseObject?.otherPnl) ?? 0;
  const livePerpPnl = asNumber(responseObject?.livePerpPnl) ?? 0;

  let holdingsPnlSum = 0;
  const holdings = balanceList.slice(0, 10).map((holding) => {
    const token = holding?.tokenFilterResult?.token ?? {};
    const balance = holding?.balance ?? {};
    const userToken = holding?.userToken ?? {};
    const symbol = firstString(token.symbol, token.name, balance.tokenAddress) ?? '???';
    const priceUsd = asNumber(holding?.tokenFilterResult?.priceUSD) ?? 0;
    const shiftedBalance = asNumber(balance.shiftedBalance) ?? 0;
    const currentValue = priceUsd * shiftedBalance;
    const currentCostBasis = asNumber(userToken.currentCostBasisUsd) ?? 0;
    const currentRealizedPnl = asNumber(userToken.currentRealizedPnlUsd) ?? 0;
    const holdingPnl = currentValue - currentCostBasis + currentRealizedPnl;
    holdingsPnlSum += holdingPnl;
    return { symbol, valueUsd: currentValue, pnlUsd: holdingPnl };
  });

  const portfolioPnlUsd = holdingsPnlSum !== 0 ? holdingsPnlSum + otherPnl : otherPnl;

  return {
    displayName,
    handle: userHandle ?? null,
    solAddress,
    evmAddress,
    holdings,
    portfolioPnlUsd,
    livePerpPnlUsd: livePerpPnl,
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
