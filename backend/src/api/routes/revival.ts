import { Router } from 'express';
import type { RouterContext } from '../context.js';
import { getUserId, safeError } from '../shared.js';

// Revival alert log — the persisted history of fired revival ignition alerts
// with their 24h outcome tracking (see backend/src/revival/outcomeTracker.ts).
export function createRevivalRoutes(ctx: RouterContext): Router {
  const router = Router();

  router.get('/revival/alerts', async (req, res) => {
    try {
      const userId = getUserId(req);
      const parsed = Number.parseInt(String(req.query.limit ?? ''), 10);
      const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 100;
      const alerts = await ctx.storage.listRevivalAlerts(userId, limit);
      res.json({ alerts });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to load revival alerts') });
    }
  });

  return router;
}
