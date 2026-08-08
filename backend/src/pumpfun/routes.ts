// REST routes for the pump.fun callouts data layer. Mounted under /api/pumpfun
// from the main router, so authMiddleware has already run and req.userId is set.
//
// This is READ-ONLY public data reachable with the shared x-api-key alone — no
// per-user state, nothing that spends — so /api is the correct home, unlike the
// sniper's own control plane. Tier-1 only: no leaderboard, no personalized feed,
// no bearer (those need a user login and are out of scope).

import { Router } from 'express';
import type { Response } from 'express';
import {
  getPumpfunClient,
  isPumpfunConfigured,
  PumpfunError,
} from './client.js';
import {
  getPumpfunLeaderboardClient,
  looksLikeJwt,
  decodeJwtExpiry,
  sessionStatus,
} from './leaderboardClient.js';
import type { PumpLeaderboardTimeframe } from './types.js';
import { getStorageProvider } from '../storage/index.js';
import {
  getCached,
  setCached,
  tokenCalloutsCacheKey,
  walletCalloutsCacheKey,
  walletProfileCacheKey,
  communityCacheKey,
  walletTransactionsCacheKey,
  walletBalanceCacheKey,
  leaderboardCacheKey,
  rankedCallersCacheKey,
  TOP_COMMUNITIES_CACHE_KEY,
  TRENDING_FEED_CACHE_KEY,
  TOKEN_CALLOUTS_TTL_MS,
  WALLET_CALLOUTS_TTL_MS,
  WALLET_PROFILE_TTL_MS,
  COMMUNITY_TTL_MS,
  TOP_COMMUNITIES_TTL_MS,
  TRENDING_FEED_TTL_MS,
  WALLET_TRANSACTIONS_TTL_MS,
  WALLET_BALANCE_TTL_MS,
  LEADERBOARD_TTL_MS,
} from './cache.js';

// This router is mounted under /api/pumpfun, so authMiddleware has already run
// and req.userId is set ('local' in local mode, the Supabase user id in hosted).
// The leaderboard/session routes are the FIRST in this module that are genuinely
// user-scoped — they read a per-user secret — but they still spend nothing, so
// /api (not the sniper control plane) remains the correct home.
function getUserId(req: { userId?: string }): string {
  return req.userId ?? 'local';
}

// A pump session bearer is a ~30-day JWT. Bound what a client may submit on
// connect so a junk paste can't be stored as a "token" and an oversized blob
// can't be used to bloat storage. JWTs are well under this.
const MAX_PUMP_TOKEN_LEN = 4096;

// The three accepted leaderboard windows. A path/query value outside this set is
// rejected before any upstream call rather than passed through blindly.
const LEADERBOARD_TIMEFRAMES: PumpLeaderboardTimeframe[] = ['7d', '30d', 'all'];

// Bound the rows returned to a client. The upstream board can be long; a caller
// asks for a slice via ?limit and we cap it so a single response stays sane.
const DEFAULT_LEADERBOARD_LIMIT = 50;
const MAX_LEADERBOARD_LIMIT = 200;

// Cap on the batch PnL mint list. The endpoint is a single POST that fans out
// per mint, so an unbounded list is an amplification lever; 100 is generous for a
// wallet's held/traded set and bounds the upstream call.
const MAX_PNL_MINTS = 100;

// A Solana address is base58 (no 0, O, I, l), 32-44 chars. A token mint may also
// be given as an EVM 0x-hex address on the chains coin-communities.xyz indexes.
// Wallets are Solana-only here, so addresses accept base58 alone.
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE = /^0x[a-fA-F0-9]{40}$/;

/** A token mint: base58 OR an EVM 0x-address. */
export function isValidMint(value: string): boolean {
  return BASE58_RE.test(value) || EVM_RE.test(value);
}

/** A wallet address: base58 only. */
export function isValidAddress(value: string): boolean {
  return BASE58_RE.test(value);
}

/**
 * Validate the POST /pnl body `{ mints: [...] }`. Returns the mint list on
 * success, or a string reason on failure that the route turns into a 400. Every
 * element must be a valid mint (base58 or EVM) — a junk mint must never reach the
 * upstream POST — and the list must be non-empty and within MAX_PNL_MINTS.
 * Exported so the validation is unit-testable the way the address validators are.
 */
export function parseMintsBody(body: unknown): { mints: string[] } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Body must be a JSON object with a "mints" array.' };
  }
  const mints = (body as Record<string, unknown>).mints;
  if (!Array.isArray(mints)) {
    return { error: 'Body must include a "mints" array.' };
  }
  if (mints.length === 0) {
    return { error: 'The "mints" array must not be empty.' };
  }
  if (mints.length > MAX_PNL_MINTS) {
    return { error: `The "mints" array must hold at most ${MAX_PNL_MINTS} entries.` };
  }
  for (const m of mints) {
    if (typeof m !== 'string' || !isValidMint(m)) {
      return { error: 'The "mints" array must contain only valid token mints.' };
    }
  }
  return { mints: mints as string[] };
}

/**
 * Translate the client's error taxonomy into HTTP. config-missing is the one
 * that is not a vendor problem, so it is 503 ("we are not set up"); every other
 * kind is an upstream/contract fault behind our gateway, so 502 ("bad response
 * from the thing we depend on"). An unknown error is a 500.
 *
 * The response body carries the constructed message, which never contains the
 * key by construction (see the INVARIANT on PumpfunError).
 */
function sendPumpfunError(res: Response, err: unknown): void {
  if (err instanceof PumpfunError) {
    switch (err.kind) {
      case 'config-missing':
        res.status(503).json({ error: 'PUMPFUN_API_KEY not set; pump.fun integration is disabled.' });
        return;
      case 'auth-expired':
        // The USER's pump session lapsed (not the shared app key). 401 + an
        // explicit reconnect flag so the console can prompt a re-connect rather
        // than treat it as an upstream fault. The message is path-only by the
        // PumpfunError invariant and carries no bearer.
        res.status(401).json({ error: err.message, reconnect: true, connected: false });
        return;
      case 'auth-rejected':
      case 'unexpected-shape':
      case 'request-failed':
        res.status(502).json({ error: err.message });
        return;
    }
  }
  console.error('[PumpfunAPI] Unexpected error:', err instanceof Error ? err.message : err);
  res.status(500).json({ error: 'Failed to read pump.fun data.' });
}

/**
 * Serve a cached value or fetch, cache and serve. Kept generic so every route is
 * one line of intent (key, ttl, fetcher) with the caching boilerplate factored
 * out. The self-gate check lives at each route entry, before this runs.
 */
async function serveCached<T>(
  res: Response,
  cacheKey: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<void> {
  const cached = getCached<T>(cacheKey);
  if (cached !== null) {
    res.json(cached);
    return;
  }
  try {
    const value = await fetcher();
    setCached(cacheKey, value, ttlMs);
    res.json(value);
  } catch (err) {
    sendPumpfunError(res, err);
  }
}

export function createPumpfunRouter(): Router {
  const router = Router();
  const client = getPumpfunClient();

  // Self-gate the KEYED routes only. The callouts/community/profile surface
  // lives on coin-communities and needs PUMPFUN_API_KEY; unset, those are a
  // clean 503 and the server still boots. It is applied per-route below rather
  // than router-wide because the trades/balance/pnl routes read from
  // profile-api.pump.fun, which is keyless — gating them on a key they never use
  // would make the whole activity feature unreachable without a key it does not
  // need.
  // Returns true (and sends a 503) when the KEYED coin-communities surface is
  // asked for without PUMPFUN_API_KEY. Called at the top of each keyed handler
  // rather than as middleware: an inline middleware arg perturbs Express's
  // path-param typing, and the keyless trades/balance/pnl routes must NOT gate.
  const gatedOnMissingKey = (res: Response): boolean => {
    if (isPumpfunConfigured()) return false;
    res.status(503).json({ error: 'PUMPFUN_API_KEY not set; pump.fun callouts are disabled.' });
    return true;
  };

  // GET /api/pumpfun/token/:mint/callouts — a token's public callouts.
  router.get('/token/:mint/callouts', async (req, res) => {
    if (gatedOnMissingKey(res)) return;
    const { mint } = req.params;
    if (!isValidMint(mint)) {
      return res.status(400).json({ error: 'Invalid token mint.' });
    }
    await serveCached(res, tokenCalloutsCacheKey(mint), TOKEN_CALLOUTS_TTL_MS, () =>
      client.getTokenCallouts(mint),
    );
  });

  // GET /api/pumpfun/token/:mint/community — a token's community summary.
  router.get('/token/:mint/community', async (req, res) => {
    if (gatedOnMissingKey(res)) return;
    const { mint } = req.params;
    if (!isValidMint(mint)) {
      return res.status(400).json({ error: 'Invalid token mint.' });
    }
    await serveCached(res, communityCacheKey(mint), COMMUNITY_TTL_MS, () => client.getCommunity(mint));
  });

  // GET /api/pumpfun/wallet/:address/callouts — a caller's callout history.
  router.get('/wallet/:address/callouts', async (req, res) => {
    if (gatedOnMissingKey(res)) return;
    const { address } = req.params;
    if (!isValidAddress(address)) {
      return res.status(400).json({ error: 'Invalid wallet address.' });
    }
    await serveCached(res, walletCalloutsCacheKey(address), WALLET_CALLOUTS_TTL_MS, () =>
      client.getWalletCallouts(address),
    );
  });

  // GET /api/pumpfun/wallet/:address/transactions — a wallet's activity, paged.
  // ?cursor threads the next page; ?dustFilter (default true) is honored when set
  // to 'false'. Served from profile-api.pump.fun (keyless), NOT the keyed host.
  router.get('/wallet/:address/transactions', async (req, res) => {
    const { address } = req.params;
    if (!isValidAddress(address)) {
      return res.status(400).json({ error: 'Invalid wallet address.' });
    }
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const dustFilter = req.query.dustFilter !== 'false';
    await serveCached(
      res,
      walletTransactionsCacheKey(address, cursor, dustFilter),
      WALLET_TRANSACTIONS_TTL_MS,
      () => client.getWalletTransactions(address, { cursor, dustFilter }),
    );
  });

  // GET /api/pumpfun/wallet/:address/balance — a wallet's holdings summary.
  router.get('/wallet/:address/balance', async (req, res) => {
    const { address } = req.params;
    if (!isValidAddress(address)) {
      return res.status(400).json({ error: 'Invalid wallet address.' });
    }
    await serveCached(res, walletBalanceCacheKey(address), WALLET_BALANCE_TTL_MS, () =>
      client.getWalletBalance(address),
    );
  });

  // POST /api/pumpfun/wallet/:address/pnl — per-token realized/unrealized PnL for
  // a caller-supplied mint list. Uncached: a POST over a variable mint set (see
  // cache.ts). Both the wallet param and every mint in the body are validated
  // before the upstream call so no junk reaches profile-api.
  router.post('/wallet/:address/pnl', async (req, res) => {
    const { address } = req.params;
    if (!isValidAddress(address)) {
      return res.status(400).json({ error: 'Invalid wallet address.' });
    }
    const parsed = parseMintsBody(req.body);
    if ('error' in parsed) {
      return res.status(400).json({ error: parsed.error });
    }
    try {
      res.json(await client.getWalletPnl(address, parsed.mints));
    } catch (err) {
      sendPumpfunError(res, err);
    }
  });

  // GET /api/pumpfun/wallet/:address — a caller's public profile.
  router.get('/wallet/:address', async (req, res) => {
    if (gatedOnMissingKey(res)) return;
    const { address } = req.params;
    if (!isValidAddress(address)) {
      return res.status(400).json({ error: 'Invalid wallet address.' });
    }
    await serveCached(res, walletProfileCacheKey(address), WALLET_PROFILE_TTL_MS, () =>
      client.getWalletProfile(address),
    );
  });

  // GET /api/pumpfun/communities/top — the top communities board.
  router.get('/communities/top', async (_req, res) => {
    if (gatedOnMissingKey(res)) return;
    await serveCached(res, TOP_COMMUNITIES_CACHE_KEY, TOP_COMMUNITIES_TTL_MS, () =>
      client.getTopCommunities(),
    );
  });

  // GET /api/pumpfun/feed — the public trending feed slice.
  router.get('/feed', async (_req, res) => {
    if (gatedOnMissingKey(res)) return;
    await serveCached(res, TRENDING_FEED_CACHE_KEY, TRENDING_FEED_TTL_MS, () => client.getTrendingFeed());
  });

  // -------------------------------------------------------------------------
  // Pump session (per-user bearer) — connect / status / disconnect.
  //
  // The token is a credential the user pastes from their own pump.fun session.
  // It is stored (encrypted at rest in hosted mode) and NEVER echoed back: every
  // response below is the token-free `sessionStatus(...)` projection. These
  // routes do NOT gate on PUMPFUN_API_KEY — the leaderboard uses the user's
  // bearer, not the shared key, so it works without one.
  // -------------------------------------------------------------------------

  const leaderboardClient = getPumpfunLeaderboardClient();

  // GET /api/pumpfun/session — connection status. Returns only
  // { connected, expiresAt?, updatedAt? }; never the token.
  router.get('/session', async (req, res) => {
    const storage = getStorageProvider();
    try {
      const session = await storage.getPumpSession(getUserId(req));
      res.json(sessionStatus(session));
    } catch (err) {
      console.error('[PumpfunAPI] Failed to read pump session status:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'Failed to read pump.fun session status.' });
    }
  });

  // POST /api/pumpfun/session — connect: store the pasted bearer. Body { token }.
  // Validates structure and expiry BEFORE storing so obvious junk / already-dead
  // tokens are rejected with a clear reason rather than silently kept.
  router.post('/session', async (req, res) => {
    const body: unknown = req.body;
    const token = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).token : undefined;

    if (typeof token !== 'string' || token.trim() === '') {
      return res.status(400).json({ error: 'Body must include a non-empty "token" string.' });
    }
    const trimmed = token.trim();
    if (trimmed.length > MAX_PUMP_TOKEN_LEN) {
      return res.status(400).json({ error: 'That token is too long to be a pump.fun session bearer.' });
    }
    if (!looksLikeJwt(trimmed)) {
      return res.status(400).json({ error: 'That does not look like a pump.fun session token (expected a JWT).' });
    }
    // Reject a token that is already expired. `exp` may be undecodable on an
    // unverified shape, in which case we do not block — we store it and let the
    // status/expiry surface whatever the JWT actually carries.
    const exp = decodeJwtExpiry(trimmed);
    if (exp !== null && exp * 1000 <= Date.now()) {
      return res.status(400).json({ error: 'That pump.fun session has already expired; connect a fresh one.' });
    }

    const storage = getStorageProvider();
    try {
      await storage.setPumpSession(getUserId(req), trimmed);
      // Re-read so the response reflects exactly what was stored (updatedAt), and
      // is built from the token-free projection — never from the request body.
      const session = await storage.getPumpSession(getUserId(req));
      res.json(sessionStatus(session));
    } catch (err) {
      // Do NOT surface the underlying error verbatim: it is the one place a
      // storage/crypto error could reference the value being stored.
      console.error('[PumpfunAPI] Failed to store pump session:', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'Failed to store pump.fun session.' });
    }
  });

  // DELETE /api/pumpfun/session — disconnect: clear the stored bearer.
  router.delete('/session', async (req, res) => {
    const storage = getStorageProvider();
    try {
      await storage.setPumpSession(getUserId(req), null);
      res.json({ connected: false });
    } catch (err) {
      console.error('[PumpfunAPI] Failed to clear pump session:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'Failed to disconnect pump.fun session.' });
    }
  });

  // -------------------------------------------------------------------------
  // Leaderboard (keyed with the user's bearer). Reads the stored token late,
  // calls coin-communities with it, and caches the narrowed rows per (user,
  // window). 409 when no token is connected; the client maps a 401 (expired
  // session) to a reconnect prompt via sendPumpfunError.
  // -------------------------------------------------------------------------

  // Clamp ?limit to [1, MAX]; default when absent or unparseable.
  const parseLimit = (raw: unknown): number => {
    const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LEADERBOARD_LIMIT;
    return Math.min(n, MAX_LEADERBOARD_LIMIT);
  };

  // GET /api/pumpfun/leaderboard?window=7d&limit=50
  router.get('/leaderboard', async (req, res) => {
    const windowParam = typeof req.query.window === 'string' ? req.query.window : '7d';
    if (!LEADERBOARD_TIMEFRAMES.includes(windowParam as PumpLeaderboardTimeframe)) {
      return res.status(400).json({ error: `Invalid window. Use one of: ${LEADERBOARD_TIMEFRAMES.join(', ')}.` });
    }
    const timeframe = windowParam as PumpLeaderboardTimeframe;
    const limit = parseLimit(req.query.limit);
    const userId = getUserId(req);

    const storage = getStorageProvider();
    let bearer: string;
    try {
      const session = await storage.getPumpSession(userId);
      if (!session) {
        // Not an upstream fault — the user simply hasn't connected. 409 with a
        // clear reason and a connected:false flag the console can key on.
        return res.status(409).json({ error: 'Connect your pump.fun account to see the leaderboard.', connected: false });
      }
      bearer = session.token; // read late; used once below; never returned.
    } catch (err) {
      console.error('[PumpfunAPI] Failed to read pump session:', err instanceof Error ? err.message : err);
      return res.status(500).json({ error: 'Failed to read pump.fun session.' });
    }

    // Serve cached rows if fresh, else fetch with the bearer, cache, and slice.
    const cacheKey = leaderboardCacheKey(userId, timeframe);
    const cached = getCached<Awaited<ReturnType<typeof leaderboardClient.getCalloutLeaderboard>>>(cacheKey);
    if (cached !== null) {
      return res.json(cached.slice(0, limit));
    }
    try {
      const rows = await leaderboardClient.getCalloutLeaderboard(bearer, timeframe);
      setCached(cacheKey, rows, LEADERBOARD_TTL_MS);
      res.json(rows.slice(0, limit));
    } catch (err) {
      sendPumpfunError(res, err);
    }
  });

  // GET /api/pumpfun/leaderboard/ranked — the ranked-callers board (no window).
  router.get('/leaderboard/ranked', async (req, res) => {
    const limit = parseLimit(req.query.limit);
    const userId = getUserId(req);

    const storage = getStorageProvider();
    let bearer: string;
    try {
      const session = await storage.getPumpSession(userId);
      if (!session) {
        return res.status(409).json({ error: 'Connect your pump.fun account to see the leaderboard.', connected: false });
      }
      bearer = session.token;
    } catch (err) {
      console.error('[PumpfunAPI] Failed to read pump session:', err instanceof Error ? err.message : err);
      return res.status(500).json({ error: 'Failed to read pump.fun session.' });
    }

    const cacheKey = rankedCallersCacheKey(userId);
    const cached = getCached<Awaited<ReturnType<typeof leaderboardClient.getRankedCallers>>>(cacheKey);
    if (cached !== null) {
      return res.json(cached.slice(0, limit));
    }
    try {
      const rows = await leaderboardClient.getRankedCallers(bearer);
      setCached(cacheKey, rows, LEADERBOARD_TTL_MS);
      res.json(rows.slice(0, limit));
    } catch (err) {
      sendPumpfunError(res, err);
    }
  });

  return router;
}
