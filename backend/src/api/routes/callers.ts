import { Router } from 'express';
import { buildCallerScores } from '@oct/shared';
import { getPeaks } from '../../alerts/tokenPeakStore.js';
import type { RouterContext } from '../context.js';
import { getUserId, safeError } from '../shared.js';

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 90;
const MAX_CONTRACTS = 2000;
/** Scores move on the sampler's cadence (3 min), so a short TTL is plenty. */
const CACHE_TTL_MS = 120_000;

interface CacheEntry {
  at: number;
  windowDays: number;
  payload: unknown;
}

const cache = new Map<string, CacheEntry>();

// Caller quality scores, derived on read rather than stored: the inputs
// (contract log + token peaks) already persist, and a derived table would just
// be a second thing to keep in sync. Cached briefly so a Radar render doesn't
// recompute per pane.
export function createCallersRoutes(ctx: RouterContext): Router {
  const router = Router();
  const { storage } = ctx;

  router.get('/callers/scores', async (req, res) => {
    try {
      const userId = getUserId(req);
      const windowDays = Math.max(
        1,
        Math.min(MAX_WINDOW_DAYS, Number.parseInt(req.query.windowDays as string, 10) || DEFAULT_WINDOW_DAYS),
      );

      const cached = cache.get(userId);
      if (cached && cached.windowDays === windowDays && Date.now() - cached.at < CACHE_TTL_MS) {
        return res.json(cached.payload);
      }

      const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
      const contracts = await storage.getContracts(userId, MAX_CONTRACTS, since);
      const peaks = await getPeaks(contracts.map((c) => c.address));
      const scores = buildCallerScores(contracts, (addr) => peaks.get(addr.toLowerCase()), windowDays);

      const payload = {
        windowDays,
        contracts: contracts.length,
        pricedTokens: peaks.size,
        scores,
      };
      cache.set(userId, { at: Date.now(), windowDays, payload });
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to compute caller scores') });
    }
  });

  return router;
}

/** Test seam / invalidation hook for when the contract log changes wholesale. */
export function clearCallerScoreCache(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}
