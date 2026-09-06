// REST routes for the FOMO user-tracking feature. Mounted under /api/fomo from
// the main router, so authMiddleware has already populated req.userId.

import { Router } from 'express';
import { isHostedMode } from '../storage/index.js';
import { ensureSharedFomoClientReady, resolveFomoRefreshToken } from './client.js';
import { getFomoPollerStatus } from './poller.js';
import {
  getCached,
  setCached,
  leaderboardCacheKey,
  hodlersCacheKey,
  getFomoCacheStats,
  LEADERBOARD_TTL_MS,
  HODLERS_TTL_MS,
} from './cache.js';
import { getFomoUpstreamHealth } from './health.js';
import {
  fetchMonitor985Snapshot,
  isMonitor985Window,
  select985Board,
  MONITOR_985_CACHE_KEY,
  MONITOR_985_HOME,
  MONITOR_985_LABEL,
  MONITOR_985_SOURCE,
  MONITOR_985_TTL_MS,
  type Monitor985Snapshot,
  type Monitor985Window,
} from './monitor985.js';
import { fetchWorkerHealth, isFomoProxyMode } from './proxy-client.js';
import {
  getFomoServiceClient,
  extractLeaderboardEntries,
  loadFomoTokenRotatedAt,
  matchHoldersToTracked,
  networkIdFromContract,
  type FomoTrackedUserRow,
} from './store.js';
import {
  getBotHolders,
  getBotTheses,
  getBotTraderActivity,
  getBotWallet,
  resolveNetworkId,
} from '../bot/service.js';
import { sendServiceError } from '../bot/errors.js';
import type { FomoClientLike } from './types.js';
import type { WsServer } from '../ws/server.js';
import { deliverRecentTradesToUser, loadDeliveredTrades, MAX_TRADE_HISTORY } from './dispatch.js';

function getUserId(req: any): string {
  return req.userId ?? 'local';
}

function safeError(err: any, fallback: string): string {
  if (!isHostedMode()) return err?.message ?? fallback;
  console.error(`[FomoAPI] ${fallback}:`, err?.message ?? err);
  return fallback;
}

/**
 * What GET /api/fomo/leaderboard returns, whichever source served it. The
 * source fields are not decoration — the console must be able to tell a live
 * fomo.family read from a third-party snapshot, and how stale the latter is.
 */
interface LeaderboardPayload {
  entries: Array<{
    fomoUserId: string;
    fomoHandle: string | null;
    displayName: string | null;
    pnl?: number | null;
    volume?: number | null;
    rank?: number | null;
    followers?: number | null;
    numTrades?: number | null;
  }>;
  window: Monitor985Window;
  source: 'fomo' | typeof MONITOR_985_SOURCE;
  sourceLabel: string;
  sourceUrl: string;
  /** Snapshot generation time (985monitor) or read time (live). ms epoch. */
  updatedAt: number | null;
  live: boolean;
}

/**
 * One cached read of the whole 985monitor file, shared by every window and
 * limit — it is a single static document, so per-window caching would just
 * multiply the same fetch.
 */
async function loadMonitor985Snapshot(): Promise<Monitor985Snapshot> {
  const cached = getCached<Monitor985Snapshot>(MONITOR_985_CACHE_KEY);
  if (cached) return cached;
  const snapshot = await fetchMonitor985Snapshot();
  setCached(MONITOR_985_CACHE_KEY, snapshot, MONITOR_985_TTL_MS);
  return snapshot;
}

interface ResolvedFomoUser {
  fomoUserId: string;
  fomoHandle: string | null;
  displayName: string | null;
}

// Pull a (fomoUserId, handle, displayName) triple out of a FOMO user object.
// TODO(verify): field aliases below are best-effort until confirmed against a
// real /v2/users/* response — id vs userId, userHandle vs handle, etc.
function pickFomoUser(obj: any): ResolvedFomoUser | null {
  if (!obj || typeof obj !== 'object') return null;
  const fomoUserId: string | undefined = obj.id ?? obj.userId ?? obj.user_id;
  if (!fomoUserId) return null;
  return {
    fomoUserId: String(fomoUserId),
    fomoHandle: obj.userHandle ?? obj.handle ?? obj.username ?? null,
    displayName: obj.displayName ?? obj.name ?? null,
  };
}

// Resolve a free-text query to a real FOMO user via handle lookup first, then
// fuzzy search. Returns null when nothing matches.
async function resolveFomoUser(client: FomoClientLike, query: string): Promise<ResolvedFomoUser | null> {
  const handle = query.trim().replace(/^@/, '');

  // 1. Exact handle lookup.
  try {
    const res = await client.getUserByHandle(handle);
    if (res.status >= 200 && res.status < 300 && res.json) {
      // Response may be the user object directly or wrapped in responseObject/data.
      const body: any = res.json;
      const candidate = pickFomoUser(body?.responseObject ?? body?.data ?? body);
      if (candidate) return candidate;
    }
  } catch (err) {
    console.warn('[FomoAPI] getUserByHandle failed, falling back to search:', (err as Error)?.message);
  }

  // 2. Fuzzy search fallback — take the first result.
  try {
    const res = await client.searchUsers(handle);
    if (res.status >= 200 && res.status < 300 && res.json) {
      const body: any = res.json;
      const list: any[] = Array.isArray(body)
        ? body
        : body?.responseObject ?? body?.data ?? body?.results ?? body?.users ?? [];
      for (const item of list) {
        const candidate = pickFomoUser(item);
        if (candidate) return candidate;
      }
    }
  } catch (err) {
    console.warn('[FomoAPI] searchUsers failed:', (err as Error)?.message);
  }

  return null;
}

export function createFomoRouter(wsServer: WsServer): Router {
  const router = Router();

  // GET /api/fomo/status — one-glance health of the whole FOMO pipeline:
  // config, proxy/worker, poller, upstream errors, token age, cache.
  router.get('/status', async (_req, res) => {
    const [refreshToken, tokenRotatedAt, worker] = await Promise.all([
      resolveFomoRefreshToken(),
      loadFomoTokenRotatedAt(),
      fetchWorkerHealth(),
    ]);
    const poller = getFomoPollerStatus();
    const upstream = getFomoUpstreamHealth();
    res.json({
      configured: !!refreshToken,
      proxyMode: isFomoProxyMode(),
      worker: worker ?? null,
      pollerActive: poller.active,
      pollerReason: poller.reason ?? null,
      pollIntervalMs: poller.pollIntervalMs ?? null,
      trackedUserCount: poller.trackedUserCount ?? null,
      lastPollAt: poller.lastPollAt ?? null,
      lastPollError: poller.lastPollError ?? null,
      lastPollErrorAt: poller.lastPollErrorAt ?? null,
      lastSuccessfulPollAt: poller.lastSuccessfulPollAt ?? null,
      // Upstream FOMO API health as seen from this process (resets on deploy).
      upstream,
      // Privy refresh-token age: fomo_poll_state.updated_at moves only on rotation.
      refreshTokenRotatedAt: tokenRotatedAt,
      refreshTokenAgeSec: tokenRotatedAt
        ? Math.max(0, Math.floor((Date.now() - Date.parse(tokenRotatedAt)) / 1000))
        : null,
      cache: getFomoCacheStats(),
    });
  });

  // GET /api/fomo/leaderboard?window=24h|7d|30d|all&limit=50
  //
  // Two sources, in priority order:
  //   1. the live fomo.family service account (24h / all only), when it works;
  //   2. the public 985monitor.xyz snapshot, otherwise.
  //
  // The response always names which one it came from (`source`) and, for the
  // snapshot, how old the data is (`updatedAt`) — the console renders that
  // rather than passing third-party snapshot data off as our own live feed.
  // Before this, an unavailable service account was a dead red error box; the
  // fomo.family account has been Forbidden upstream since 2026-08-26.
  router.get('/leaderboard', async (req, res) => {
    const windowParam = typeof req.query.window === 'string' ? req.query.window : 'all';
    const window: Monitor985Window = isMonitor985Window(windowParam) ? windowParam : 'all';
    const limitRaw = Number.parseInt(String(req.query.limit ?? '50'), 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;

    // The live API only ever exposed 24h and all-time; 7d/30d exist only on the
    // snapshot, so asking for those skips the live path entirely rather than
    // silently serving all-time under a 7d label.
    const liveWindow = window === '24h' ? '24h' : window === 'all' ? undefined : null;

    // 1. Live fomo.family, when the window is one it supports and the shared
    //    service account is usable.
    if (liveWindow !== null) {
      const cacheKey = leaderboardCacheKey(liveWindow, limit);
      const cached = getCached<LeaderboardPayload>(cacheKey);
      if (cached) return res.json(cached);

      const client = await ensureSharedFomoClientReady().catch((err) => {
        console.warn('[FomoAPI] FOMO client unavailable for leaderboard:', (err as Error)?.message);
        return null;
      });

      if (client) {
        try {
          const result = await client.getLeaderboard(limit, liveWindow);
          if (result.status && result.status >= 200 && result.status < 300) {
            const entries = extractLeaderboardEntries(result.json);
            if (entries.length === 0) {
              console.warn('[FomoAPI] Leaderboard returned 0 parsed entries; envelope may have changed.');
            } else {
              const payload: LeaderboardPayload = {
                entries,
                window,
                source: 'fomo',
                sourceLabel: 'fomo.family',
                sourceUrl: 'https://fomo.family',
                updatedAt: Date.now(),
                live: true,
              };
              setCached(cacheKey, payload, LEADERBOARD_TTL_MS);
              return res.json(payload);
            }
          } else {
            console.error(
              `[FomoAPI] Leaderboard upstream ${result.status ?? 0}:`,
              result.text?.slice?.(0, 500) ?? '(no body)',
            );
          }
        } catch (err: any) {
          console.error('[FomoAPI] Leaderboard error:', err?.message ?? err);
        }
      }
    }

    // 2. 985monitor snapshot. Never throws out of here — a third-party file
    //    being down degrades to a labelled error, not a 500.
    try {
      const snapshot = await loadMonitor985Snapshot();
      const entries = select985Board(snapshot, window, limit).map((e) => ({
        fomoUserId: e.fomoUserId,
        fomoHandle: e.fomoHandle,
        displayName: e.displayName,
        pnl: e.pnl,
        volume: e.volume,
        rank: e.rank,
        followers: e.followers,
        numTrades: e.numTrades,
      }));
      const payload: LeaderboardPayload = {
        entries,
        window,
        source: MONITOR_985_SOURCE,
        sourceLabel: MONITOR_985_LABEL,
        sourceUrl: MONITOR_985_HOME,
        updatedAt: snapshot.updatedAt,
        live: false,
      };
      return res.json(payload);
    } catch (err: any) {
      console.error('[FomoAPI] 985monitor leaderboard fallback failed:', err?.message ?? err);
      return res.status(503).json({
        error:
          'Leaderboard unavailable: the fomo.family service account is not usable and the 985monitor snapshot could not be reached.',
        source: MONITOR_985_SOURCE,
      });
    }
  });

  // POST /api/fomo/hodlers/overlap — body { tokens: [{ address, chain, evmChain? }] }
  router.post('/hodlers/overlap', async (req, res) => {
    const userId = getUserId(req);
    const db = getFomoServiceClient();
    if (!db) return res.status(503).json({ error: 'FOMO tracking is not available (storage not configured).' });

    const rawTokens = req.body?.tokens;
    if (!Array.isArray(rawTokens) || rawTokens.length === 0) {
      return res.status(400).json({ error: 'tokens (non-empty array) is required.' });
    }

    const tokens = rawTokens
      .slice(0, 40)
      .map((t: any) => {
        const address = typeof t?.address === 'string' ? t.address.trim() : '';
        const chain = t?.chain === 'sol' ? 'sol' : t?.chain === 'evm' ? 'evm' : null;
        const evmChain = typeof t?.evmChain === 'string' ? t.evmChain : undefined;
        const networkId = chain ? networkIdFromContract(chain, evmChain) : null;
        return address && networkId ? { address, networkId } : null;
      })
      .filter(Boolean) as { address: string; networkId: number }[];

    if (tokens.length === 0) {
      return res.json({ overlaps: {} });
    }

    const client = await ensureSharedFomoClientReady();
    if (!client) {
      return res.status(503).json({
        error: 'FOMO service account is not configured. Seed fomo_poll_state.refresh_token or set FOMO_REFRESH_TOKEN.',
      });
    }

    try {
      const { data: tracked, error: trackedError } = await db
        .from('fomo_tracked_users')
        .select('fomo_user_id, fomo_handle')
        .eq('user_id', userId);
      if (trackedError) throw trackedError;

      const trackedById = new Map<string, { fomo_handle: string | null }>();
      const trackedHandles = new Set<string>();
      for (const row of tracked ?? []) {
        trackedById.set(row.fomo_user_id, { fomo_handle: row.fomo_handle });
        if (row.fomo_handle) trackedHandles.add(row.fomo_handle.toLowerCase());
      }

      const cacheKey = hodlersCacheKey(tokens);
      let batchJson = getCached<any>(cacheKey);
      if (!batchJson) {
        const holdersQuery = encodeURIComponent(
          JSON.stringify(tokens.map((t) => ({ address: t.address, networkId: t.networkId }))),
        );
        const batchResult = await client.call(`/hodlers/top?tokens=${holdersQuery}`);

        if (!batchResult.status || batchResult.status < 200 || batchResult.status >= 300) {
          return res.status(502).json({ error: 'Failed to fetch FOMO holder data.' });
        }
        batchJson = batchResult.json;
        setCached(cacheKey, batchJson, HODLERS_TTL_MS);
      }

      const overlaps: Record<string, { trackedCount: number; trackedHandles: string[] }> = {};
      for (const token of tokens) {
        const match = matchHoldersToTracked(
          token.address,
          token.networkId,
          batchJson,
          trackedById,
          trackedHandles,
        );
        overlaps[token.address.toLowerCase()] = {
          trackedCount: match.trackedCount,
          trackedHandles: match.trackedHandles,
        };
      }

      res.json({ overlaps });
    } catch (err: any) {
      res.status(500).json({ error: safeError(err, 'Failed to compute holder overlap') });
    }
  });

  // GET /api/fomo/hodlers/top?address=…&network=…
  // The console's read of the same board the Discord /holders command renders.
  // `network` is optional: omit it and getBotHolders infers the chain from the
  // address (see candidateNetworkIds). Runs on the shared FOMO service account,
  // so it needs no per-user state beyond an authenticated session.
  router.get('/hodlers/top', async (req, res) => {
    const address = typeof req.query.address === 'string' ? req.query.address.trim() : '';
    if (!address || address.length < 8) {
      return res.status(400).json({ error: 'A token address is required.' });
    }

    const networkRaw = typeof req.query.network === 'string' ? req.query.network.trim() : '';
    const networkId = networkRaw ? resolveNetworkId(networkRaw) : null;
    if (networkRaw && !networkId) {
      return res.status(400).json({ error: `Unsupported network "${networkRaw}".` });
    }

    try {
      res.json(await getBotHolders(address, networkId));
    } catch (err) {
      sendServiceError(res, err, 'Failed to fetch holders');
    }
  });

  // GET /api/fomo/token/:address/theses?network=…
  // The console's read of the same theses the fomo.family token page shows:
  // per-trader position + PnL + written thesis. Like /hodlers/top, `network` is
  // optional — omit it and getBotTheses infers the chain from the address shape.
  // Runs on the shared FOMO service account, so no per-user state is needed.
  router.get('/token/:address/theses', async (req, res) => {
    const address = typeof req.params.address === 'string' ? req.params.address.trim() : '';
    if (!address || address.length < 8) {
      return res.status(400).json({ error: 'A token address is required.' });
    }

    const networkRaw = typeof req.query.network === 'string' ? req.query.network.trim() : '';
    const networkId = networkRaw ? resolveNetworkId(networkRaw) : null;
    if (networkRaw && !networkId) {
      return res.status(400).json({ error: `Unsupported network "${networkRaw}".` });
    }

    try {
      res.json(await getBotTheses(address, networkId));
    } catch (err) {
      sendServiceError(res, err, 'Failed to fetch theses');
    }
  });

  // GET /api/fomo/wallet?q=… — a FOMO trader's public profile, holdings and PnL.
  router.get('/wallet', async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query) return res.status(400).json({ error: 'A search query is required.' });

    try {
      res.json(await getBotWallet(query));
    } catch (err) {
      sendServiceError(res, err, 'Failed to look up trader');
    }
  });

  // GET /api/fomo/activity?userId=…&limit=100 — a trader's recent swaps and
  // transfers. Takes the internal FOMO user id (as returned by /wallet's
  // `fomoUserId`) rather than a search term, so the feed and the profile card
  // are guaranteed to be the same trader.
  //
  // Capped at FOMO_ACTIVITY_MAX_LIMIT (100) — see fomo/activity.ts for the
  // list of pagination parameters that were tried upstream and don't work.
  router.get('/activity', async (req, res) => {
    const fomoUserId = typeof req.query.userId === 'string' ? req.query.userId.trim() : '';
    if (!fomoUserId) return res.status(400).json({ error: 'A FOMO user id is required.' });

    const limitRaw = Number.parseInt(String(req.query.limit ?? ''), 10);
    try {
      res.json(await getBotTraderActivity(fomoUserId, Number.isFinite(limitRaw) ? limitRaw : undefined));
    } catch (err) {
      sendServiceError(res, err, 'Failed to load trader activity');
    }
  });

  // POST /api/fomo/resolve — body { query } → resolve a FOMO user (no DB write).
  // The console persists tracked users via Supabase RLS; this route only needs the
  // shared FOMO service account to look up handles.
  router.post('/resolve', async (req, res) => {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) return res.status(400).json({ error: 'A search query is required.' });

    const client = await ensureSharedFomoClientReady();
    if (!client) {
      return res.status(503).json({
        error: 'FOMO service account is not configured. Seed fomo_poll_state.refresh_token or set FOMO_REFRESH_TOKEN.',
      });
    }

    try {
      const resolved = await resolveFomoUser(client, query);
      if (!resolved) {
        return res.status(404).json({ error: `No FOMO user found for "${query}".` });
      }
      res.json(resolved);
    } catch (err: any) {
      res.status(500).json({ error: safeError(err, 'Failed to resolve FOMO user') });
    }
  });

  // GET /api/fomo/trades?hours=24 — replay the user's recent delivered trades.
  //
  // The live feed is WebSocket-only, so before this the panel started empty on
  // every reload and showed just whatever arrived since. Trades were being
  // stored all along; nothing was reading them back.
  router.get('/trades', async (req, res) => {
    const userId = getUserId(req);
    const db = getFomoServiceClient();
    if (!db) return res.status(503).json({ error: 'FOMO tracking is not available (storage not configured).' });

    const hours = Math.max(1, Math.min(168, Number.parseInt(req.query.hours as string, 10) || 24));
    const limit = Math.max(
      1,
      Math.min(MAX_TRADE_HISTORY, Number.parseInt(req.query.limit as string, 10) || MAX_TRADE_HISTORY),
    );

    try {
      const since = new Date(Date.now() - hours * 3_600_000).toISOString();
      const trades = await loadDeliveredTrades(db, userId, since, limit);
      res.json({ hours, count: trades.length, trades });
    } catch (err: any) {
      res.status(500).json({ error: safeError(err, 'Failed to load FOMO trade history') });
    }
  });

  // GET /api/fomo/tracked — list the authenticated user's tracked FOMO users.
  router.get('/tracked', async (req, res) => {
    const userId = getUserId(req);
    const db = getFomoServiceClient();
    if (!db) return res.status(503).json({ error: 'FOMO tracking is not available (storage not configured).' });

    try {
      const { data, error } = await db
        .from('fomo_tracked_users')
        .select('id, user_id, fomo_user_id, fomo_handle, display_name, notify_pushover, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      res.json((data ?? []) as FomoTrackedUserRow[]);
    } catch (err: any) {
      res.status(500).json({ error: safeError(err, 'Failed to list tracked FOMO users') });
    }
  });

  // POST /api/fomo/tracked — body { query } → resolve + track.
  router.post('/tracked', async (req, res) => {
    const userId = getUserId(req);
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) return res.status(400).json({ error: 'A search query is required.' });

    const db = getFomoServiceClient();
    if (!db) return res.status(503).json({ error: 'FOMO tracking is not available (storage not configured).' });

    const client = await ensureSharedFomoClientReady();
    if (!client) {
      return res.status(503).json({
        error: 'FOMO service account is not configured. Seed fomo_poll_state.refresh_token or set FOMO_REFRESH_TOKEN.',
      });
    }

    try {
      const resolved = await resolveFomoUser(client, query);
      if (!resolved) {
        return res.status(404).json({ error: `No FOMO user found for "${query}".` });
      }

      const { data, error } = await db
        .from('fomo_tracked_users')
        .insert({
          user_id: userId,
          fomo_user_id: resolved.fomoUserId,
          fomo_handle: resolved.fomoHandle,
          display_name: resolved.displayName,
        })
        .select('id, user_id, fomo_user_id, fomo_handle, display_name, notify_pushover, created_at')
        .single();

      if (error) {
        // Unique violation on (user_id, fomo_user_id) => already tracked.
        if (error.code === '23505') {
          return res.status(409).json({ error: 'You are already tracking this FOMO user.' });
        }
        throw error;
      }

      void deliverRecentTradesToUser(db, wsServer, resolved.fomoUserId, userId).catch((err) => {
        console.warn('[FomoAPI] Recent trade backfill failed:', (err as Error)?.message);
      });

      res.status(201).json(data as FomoTrackedUserRow);
    } catch (err: any) {
      res.status(500).json({ error: safeError(err, 'Failed to track FOMO user') });
    }
  });

  // PATCH /api/fomo/tracked/:id — update per-user notification prefs.
  router.patch('/tracked/:id', async (req, res) => {
    const userId = getUserId(req);
    const db = getFomoServiceClient();
    if (!db) return res.status(503).json({ error: 'FOMO tracking is not available (storage not configured).' });

    const notifyPushover = req.body?.notify_pushover;
    if (typeof notifyPushover !== 'boolean') {
      return res.status(400).json({ error: 'notify_pushover (boolean) is required.' });
    }

    try {
      const { data, error } = await db
        .from('fomo_tracked_users')
        .update({ notify_pushover: notifyPushover })
        .eq('id', req.params.id)
        .eq('user_id', userId)
        .select('id, user_id, fomo_user_id, fomo_handle, display_name, notify_pushover, created_at')
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Tracked FOMO user not found.' });
      res.json(data as FomoTrackedUserRow);
    } catch (err: any) {
      res.status(500).json({ error: safeError(err, 'Failed to update tracked FOMO user') });
    }
  });

  // DELETE /api/fomo/tracked/:id — untrack (must belong to the user).
  router.delete('/tracked/:id', async (req, res) => {
    const userId = getUserId(req);
    const db = getFomoServiceClient();
    if (!db) return res.status(503).json({ error: 'FOMO tracking is not available (storage not configured).' });

    try {
      const { count, error } = await db
        .from('fomo_tracked_users')
        .delete({ count: 'exact' })
        .eq('id', req.params.id)
        .eq('user_id', userId);
      if (error) throw error;
      if (!count) return res.status(404).json({ error: 'Tracked FOMO user not found.' });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: safeError(err, 'Failed to untrack FOMO user') });
    }
  });

  return router;
}
