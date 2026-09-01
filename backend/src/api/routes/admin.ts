import { Router } from 'express';
import type { WsServer } from '../../ws/server.js';
import { getFomoServiceClient } from '../../fomo/store.js';
import { isHostedMode } from '../../storage/index.js';
import { requireAdmin, adminGatingConfigured } from '../../auth/admin.js';
import {
  startTokenPeakBackfill,
  getBackfillStatus,
} from '../../alerts/tokenPeakBackfill.js';

export interface AdminStats {
  mode: 'local' | 'hosted';
  /** null when the figure cannot be sourced (local mode, or no service key). */
  signups: { total: number | null; last7d: number | null; last24h: number | null };
  live: { connections: number; users: number; anonymousConnections: number };
  /**
   * Activation funnel — genuinely sequential stages only, so "% of previous"
   * is meaningful.
   *
   * NOTE there is deliberately no "added a Discord token" stage. In hosted mode
   * the token lives in the browser and never reaches the server (ADR-002), so
   * the `discord_tokens` table is only ever written by local/desktop installs.
   * Counting it here reported 0 while users demonstrably had working feeds.
   * Creating a room is the earliest server-visible proof of a working token,
   * because rooms are built from guilds the browser gateway fetched.
   */
  funnel: {
    signedUp: number | null;
    createdRoom: number | null;
    detectedContract: number | null;
  };
  /**
   * Independent feature adoption. These are NOT funnel stages — a user can
   * track a wallet without ever configuring a feed — so they are counted
   * against signups, never against each other.
   */
  adoption: {
    trackedWallet: number | null;
    addedTelegram: number | null;
    serverSideToken: number | null;
  };
  gatingConfigured: boolean;
  generatedAt: string;
}

/**
 * Count distinct user_id values in a table.
 *
 * Supabase has no COUNT(DISTINCT) over PostgREST, so this pages the column and
 * de-duplicates in memory. These tables are small (one row per user per token /
 * room / wallet), and the alternative — an RPC — would need a migration for a
 * number the operator reads occasionally. Returns null on any failure so a
 * broken lookup never renders as a real zero.
 */
async function countDistinctUsers(
  db: NonNullable<ReturnType<typeof getFomoServiceClient>>,
  table: 'discord_tokens' | 'rooms' | 'contracts' | 'user_tracked_wallets' | 'telegram_credentials',
): Promise<number | null> {
  try {
    const seen = new Set<string>();
    const PAGE = 1000;
    const MAX_PAGES = 50;
    for (let page = 0; page < MAX_PAGES; page++) {
      const from = page * PAGE;
      const { data, error } = await db
        .from(table)
        .select('user_id')
        .range(from, from + PAGE - 1);
      if (error) throw error;
      const rows = data ?? [];
      for (const r of rows) {
        const id = (r as { user_id: string | null }).user_id;
        if (id) seen.add(id);
      }
      if (rows.length < PAGE) break;
    }
    return seen.size;
  } catch (err) {
    console.error(`[admin] distinct-user count failed for ${table}:`, err);
    return null;
  }
}

/**
 * Operator-only stats. Mounted under /admin and gated by requireAdmin, which
 * 404s rather than 403s so the surface stays invisible to everyone else.
 *
 * Signup counts come from Supabase's auth admin API via the service-role
 * client. That client is optional (it needs SUPABASE_SERVICE_ROLE_KEY), so
 * every figure it feeds is nullable rather than zero — "unknown" and "nobody
 * signed up" are very different answers and must not be conflated.
 */
export function createAdminRoutes(wsServer: WsServer): Router {
  const router = Router();

  router.get('/admin/stats', requireAdmin, async (_req, res) => {
    const live = wsServer.getLiveStats();
    const stats: AdminStats = {
      mode: isHostedMode() ? 'hosted' : 'local',
      signups: { total: null, last7d: null, last24h: null },
      live,
      funnel: { signedUp: null, createdRoom: null, detectedContract: null },
      adoption: { trackedWallet: null, addedTelegram: null, serverSideToken: null },
      gatingConfigured: adminGatingConfigured(),
      generatedAt: new Date().toISOString(),
    };

    const db = getFomoServiceClient();
    if (db) {
      try {
        const now = Date.now();
        const d7 = new Date(now - 7 * 24 * 60 * 60 * 1000).getTime();
        const d24 = new Date(now - 24 * 60 * 60 * 1000).getTime();

        // listUsers is paginated; walk it so the total is real rather than a
        // first-page count. Capped so a large tenant can't stall the request.
        let page = 1;
        let total = 0;
        let last7d = 0;
        let last24h = 0;
        const PER_PAGE = 1000;
        const MAX_PAGES = 20;

        for (; page <= MAX_PAGES; page++) {
          const { data, error } = await db.auth.admin.listUsers({ page, perPage: PER_PAGE });
          if (error) throw error;
          const users = data?.users ?? [];
          total += users.length;
          for (const u of users) {
            const created = u.created_at ? new Date(u.created_at).getTime() : NaN;
            if (!Number.isNaN(created)) {
              if (created >= d7) last7d++;
              if (created >= d24) last24h++;
            }
          }
          if (users.length < PER_PAGE) break;
        }

        stats.signups = { total, last7d, last24h };
        stats.funnel.signedUp = total;
      } catch (err) {
        console.error('[admin] signup stats unavailable:', err);
        // leave the nulls in place — the live figures are still worth returning
      }

      // Each stage counts independently rather than nesting, so one failing
      // lookup degrades to a single null instead of collapsing the funnel.
      const [rooms, contracts, wallets, telegram, serverTokens] = await Promise.all([
        countDistinctUsers(db, 'rooms'),
        countDistinctUsers(db, 'contracts'),
        countDistinctUsers(db, 'user_tracked_wallets'),
        countDistinctUsers(db, 'telegram_credentials'),
        countDistinctUsers(db, 'discord_tokens'),
      ]);
      stats.funnel.createdRoom = rooms;
      stats.funnel.detectedContract = contracts;
      stats.adoption.trackedWallet = wallets;
      stats.adoption.addedTelegram = telegram;
      // Expected to be 0 in a hosted-only deployment; surfaced so the number is
      // explained rather than mistaken for a broken query.
      stats.adoption.serverSideToken = serverTokens;
    }

    res.json(stats);
  });

  // Token-peak backfill (Sprint 1 / A1) — seeds `token_peaks` for tokens called
  // before the sampler's first pass, so historical calls earn scores. Admin
  // routine rather than a script: prod is a Railway container with no shell
  // story for one-offs, while this reuses the running server's env, storage
  // provider, and enrichment path, and works identically in local mode (where
  // requireAdmin is a no-op on a loopback-only bind). Idempotent — tokens with
  // an existing peak are skipped, and recordPeak is a max-upsert.
  router.post('/admin/token-peaks/backfill', requireAdmin, (req, res) => {
    const body = (req.body ?? {}) as { lookbackDays?: unknown; force?: unknown };
    const result = startTokenPeakBackfill({
      lookbackDays: typeof body.lookbackDays === 'number' ? body.lookbackDays : undefined,
      force: body.force === true,
    });
    // 409 when a run is already in flight — the caller can watch it instead.
    res.status(result.started ? 202 : 409).json(result);
  });

  router.get('/admin/token-peaks/backfill', requireAdmin, (_req, res) => {
    res.json(getBackfillStatus());
  });

  return router;
}
