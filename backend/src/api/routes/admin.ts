import { Router } from 'express';
import type { WsServer } from '../../ws/server.js';
import { getFomoServiceClient } from '../../fomo/store.js';
import { isHostedMode } from '../../storage/index.js';
import { requireAdmin, adminGatingConfigured } from '../../auth/admin.js';

export interface AdminStats {
  mode: 'local' | 'hosted';
  /** null when the figure cannot be sourced (local mode, or no service key). */
  signups: { total: number | null; last7d: number | null; last24h: number | null };
  live: { connections: number; users: number; anonymousConnections: number };
  /**
   * Activation funnel — distinct users who reached each stage. Each is a strict
   * prerequisite for the next in practice, so the drop between stages is the
   * interesting number, not the absolutes.
   */
  funnel: {
    signedUp: number | null;
    addedDiscordToken: number | null;
    createdRoom: number | null;
    detectedContract: number | null;
    trackedWallet: number | null;
    addedTelegram: number | null;
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

  router.get('/admin/stats', requireAdmin, async (req, res) => {
    const live = wsServer.getLiveStats();
    const stats: AdminStats = {
      mode: isHostedMode() ? 'hosted' : 'local',
      signups: { total: null, last7d: null, last24h: null },
      live,
      funnel: {
        signedUp: null,
        addedDiscordToken: null,
        createdRoom: null,
        detectedContract: null,
        trackedWallet: null,
        addedTelegram: null,
      },
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
      const [discordTokens, rooms, contracts, wallets, telegram] = await Promise.all([
        countDistinctUsers(db, 'discord_tokens'),
        countDistinctUsers(db, 'rooms'),
        countDistinctUsers(db, 'contracts'),
        countDistinctUsers(db, 'user_tracked_wallets'),
        countDistinctUsers(db, 'telegram_credentials'),
      ]);
      stats.funnel.addedDiscordToken = discordTokens;
      stats.funnel.createdRoom = rooms;
      stats.funnel.detectedContract = contracts;
      stats.funnel.trackedWallet = wallets;
      stats.funnel.addedTelegram = telegram;
    }

    res.json(stats);
  });

  return router;
}
