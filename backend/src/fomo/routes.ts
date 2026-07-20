// REST routes for the FOMO user-tracking feature. Mounted under /api/fomo from
// the main router, so authMiddleware has already populated req.userId.

import { Router } from 'express';
import { isHostedMode } from '../storage/index.js';
import { ensureSharedFomoClient, resolveFomoRefreshToken } from './client.js';
import { ensureSharedAccountFollows } from './follows.js';
import { getFomoPollerStatus } from './poller.js';
import {
  getFomoServiceClient,
  extractLeaderboardEntries,
  matchHoldersToTracked,
  networkIdFromContract,
  type FomoTrackedUserRow,
} from './store.js';
import type { FomoClient } from './client.js';

function getUserId(req: any): string {
  return req.userId ?? 'local';
}

function safeError(err: any, fallback: string): string {
  if (!isHostedMode()) return err?.message ?? fallback;
  console.error(`[FomoAPI] ${fallback}:`, err?.message ?? err);
  return fallback;
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
async function resolveFomoUser(client: FomoClient, query: string): Promise<ResolvedFomoUser | null> {
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

export function createFomoRouter(): Router {
  const router = Router();

  // GET /api/fomo/status — whether the shared FOMO account is configured.
  router.get('/status', async (_req, res) => {
    const refreshToken = await resolveFomoRefreshToken();
    const poller = getFomoPollerStatus();
    res.json({
      configured: !!refreshToken,
      pollerActive: poller.active,
      pollerReason: poller.reason ?? null,
      ensureFollows: process.env.FOMO_ENSURE_FOLLOWS !== 'false',
    });
  });

  // GET /api/fomo/leaderboard?window=24h|all&limit=50
  router.get('/leaderboard', async (req, res) => {
    const windowParam = typeof req.query.window === 'string' ? req.query.window : 'all';
    const window = windowParam === '24h' ? '24h' : undefined;
    const limitRaw = Number.parseInt(String(req.query.limit ?? '50'), 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;

    const client = await ensureSharedFomoClient();
    if (!client) {
      return res.status(503).json({
        error: 'FOMO service account is not configured. Seed fomo_poll_state.refresh_token or set FOMO_REFRESH_TOKEN.',
      });
    }

    try {
      await client.init();
      const result = await client.getLeaderboard(limit, window);
      if (!result.status || result.status < 200 || result.status >= 300) {
        console.error(
          `[FomoAPI] Leaderboard upstream ${result.status ?? 0}:`,
          result.text?.slice?.(0, 500) ?? '(no body)',
        );
        return res.status(502).json({ error: 'Failed to fetch FOMO leaderboard.' });
      }
      const entries = extractLeaderboardEntries(result.json);
      if (entries.length === 0) {
        console.warn('[FomoAPI] Leaderboard returned 0 parsed entries; envelope may have changed.');
      }
      res.json({ entries });
    } catch (err: any) {
      console.error('[FomoAPI] Leaderboard error:', err?.message ?? err);
      res.status(500).json({ error: safeError(err, 'Failed to fetch FOMO leaderboard') });
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

    const client = await ensureSharedFomoClient();
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

      await client.init();
      const holdersQuery = encodeURIComponent(
        JSON.stringify(tokens.map((t) => ({ address: t.address, networkId: t.networkId }))),
      );
      const batchResult = await client.call(`/hodlers/top?tokens=${holdersQuery}`);

      if (!batchResult.status || batchResult.status < 200 || batchResult.status >= 300) {
        return res.status(502).json({ error: 'Failed to fetch FOMO holder data.' });
      }

      const overlaps: Record<string, { trackedCount: number; trackedHandles: string[] }> = {};
      for (const token of tokens) {
        const match = matchHoldersToTracked(
          token.address,
          token.networkId,
          batchResult.json,
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

  // POST /api/fomo/resolve — body { query } → resolve a FOMO user (no DB write).
  // The console persists tracked users via Supabase RLS; this route only needs the
  // shared FOMO service account to look up handles.
  router.post('/resolve', async (req, res) => {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) return res.status(400).json({ error: 'A search query is required.' });

    const client = await ensureSharedFomoClient();
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

    const client = await ensureSharedFomoClient();
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

      // If tradingActivity is following-scoped, make the shared account follow
      // this trader so their trades appear in the global poll feed.
      await ensureSharedAccountFollows(client, resolved.fomoUserId);

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
