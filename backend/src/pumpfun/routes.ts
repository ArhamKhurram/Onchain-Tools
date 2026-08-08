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
  getCached,
  setCached,
  tokenCalloutsCacheKey,
  walletCalloutsCacheKey,
  walletProfileCacheKey,
  communityCacheKey,
  TOP_COMMUNITIES_CACHE_KEY,
  TRENDING_FEED_CACHE_KEY,
  TOKEN_CALLOUTS_TTL_MS,
  WALLET_CALLOUTS_TTL_MS,
  WALLET_PROFILE_TTL_MS,
  COMMUNITY_TTL_MS,
  TOP_COMMUNITIES_TTL_MS,
  TRENDING_FEED_TTL_MS,
} from './cache.js';

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

  // Self-gate: if the key is unset the whole surface is a clean 503, and the
  // server still boots. Applied once here rather than per-route so a new route
  // cannot forget it.
  router.use((_req, res, next) => {
    if (!isPumpfunConfigured()) {
      res.status(503).json({ error: 'PUMPFUN_API_KEY not set; pump.fun integration is disabled.' });
      return;
    }
    next();
  });

  // GET /api/pumpfun/token/:mint/callouts — a token's public callouts.
  router.get('/token/:mint/callouts', async (req, res) => {
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
    const { mint } = req.params;
    if (!isValidMint(mint)) {
      return res.status(400).json({ error: 'Invalid token mint.' });
    }
    await serveCached(res, communityCacheKey(mint), COMMUNITY_TTL_MS, () => client.getCommunity(mint));
  });

  // GET /api/pumpfun/wallet/:address/callouts — a caller's callout history.
  router.get('/wallet/:address/callouts', async (req, res) => {
    const { address } = req.params;
    if (!isValidAddress(address)) {
      return res.status(400).json({ error: 'Invalid wallet address.' });
    }
    await serveCached(res, walletCalloutsCacheKey(address), WALLET_CALLOUTS_TTL_MS, () =>
      client.getWalletCallouts(address),
    );
  });

  // GET /api/pumpfun/wallet/:address — a caller's public profile.
  router.get('/wallet/:address', async (req, res) => {
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
    await serveCached(res, TOP_COMMUNITIES_CACHE_KEY, TOP_COMMUNITIES_TTL_MS, () =>
      client.getTopCommunities(),
    );
  });

  // GET /api/pumpfun/feed — the public trending feed slice.
  router.get('/feed', async (_req, res) => {
    await serveCached(res, TRENDING_FEED_CACHE_KEY, TRENDING_FEED_TTL_MS, () => client.getTrendingFeed());
  });

  return router;
}
