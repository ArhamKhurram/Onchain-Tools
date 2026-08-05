import { Router } from 'express';
import { buildCallerScores, buildRoomCallerScores, DEFAULT_EXCLUDED_CALLERS } from '@oct/shared';
import { getPeaks } from '../../alerts/tokenPeakStore.js';
import type { RouterContext } from '../context.js';
import { getUserId, safeError } from '../shared.js';

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 90;
/**
 * Safety ceiling on the scoring read, *not* a page size.
 *
 * This used to be 2000, which silently redefined "last 30 days" as "the newest
 * 2000 rows". Both storage providers return newest-first, so on a busy feed
 * (contract rows include every bot repost) the window collapsed to a couple of
 * days and the leaderboard emptied out — most callers fell back under
 * MIN_RATED_CALLS and vanished, with nothing on screen to say why. Scores are
 * derived on read, so a truncated read is a truncated history.
 *
 * The ceiling stays because an unbounded read is a real egress and memory risk;
 * hitting it is now reported as `truncated` instead of quietly shrinking the
 * window.
 */
const MAX_CONTRACTS = 20_000;
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

      // Bots are excluded here rather than in the feed: an enrichment bot's
      // reposts are still the data source enrichment reads, they just aren't
      // calls. Config additions layer on top of the known-bot defaults.
      const config = await storage.getConfig(userId).catch(() => null);
      const exclude = [...DEFAULT_EXCLUDED_CALLERS, ...(config?.callerScoreExclusions ?? [])];

      const peaks = await getPeaks(contracts.map((c) => c.address));
      const peakFor = (addr: string) => peaks.get(addr.toLowerCase());
      const scores = buildCallerScores(contracts, peakFor, windowDays, { exclude });
      // Room-scoped scores derive from the same persisted inputs (contract
      // rows already carry room_ids in both storage impls), so like the global
      // list they are computed on read rather than stored — no second thing to
      // keep in sync. Bots are excluded here too, for the same reason.
      const roomScores = buildRoomCallerScores(contracts, peakFor, windowDays, { exclude });

      // How far back the rows we actually got reach. In hosted mode this is
      // short of `since` when the read hit its ceiling; in local mode when the
      // contract log has rolled old rows off. Either way it, not `windowDays`,
      // is the history these scores are built on — so report it rather than let
      // the console keep claiming 30 days.
      let coversFrom: string | undefined;
      let coversFromMs = Number.POSITIVE_INFINITY;
      for (const c of contracts) {
        // Compared numerically: the two providers don't agree on offset spelling
        // ("...Z" vs "+00:00"), so string order would be a coin flip.
        const ms = new Date(c.timestamp).getTime();
        if (Number.isFinite(ms) && ms < coversFromMs) {
          coversFromMs = ms;
          coversFrom = c.timestamp;
        }
      }

      const payload = {
        windowDays,
        contracts: contracts.length,
        pricedTokens: peaks.size,
        /** True when the window held more rows than we were willing to read. */
        truncated: contracts.length >= MAX_CONTRACTS,
        coversFrom,
        scores,
        roomScores,
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
