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
  gatingConfigured: boolean;
  generatedAt: string;
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
      } catch (err) {
        console.error('[admin] signup stats unavailable:', err);
        // leave the nulls in place — the live figures are still worth returning
      }
    }

    res.json(stats);
  });

  return router;
}
