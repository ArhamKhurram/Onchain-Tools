import { Router } from 'express';
import {
  buildCallerScores,
  buildRoomCallerScores,
  splitCallerAggregates,
  DEFAULT_EXCLUDED_CALLERS,
  type CallerAggregateRow,
  type CallerScore,
  type RoomCallerScores,
} from '@oct/shared';
import { getPeaks } from '../../alerts/tokenPeakStore.js';
import { getCallerStatsStore } from '../../callers/callerStatsStore.js';
import { refreshTokenPeak } from '../../callers/tokenPeakRefresh.js';
import type { RouterContext } from '../context.js';
import { getUserId, safeError } from '../shared.js';

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 90;
/**
 * Safety ceiling on the DERIVED read, *not* a page size.
 *
 * This used to be 2000, which silently redefined "last 30 days" as "the newest
 * 2000 rows". Both storage providers return newest-first, so on a busy feed
 * (contract rows include every bot repost) the window collapsed to a couple of
 * days and the leaderboard emptied out — most callers fell back under
 * MIN_RATED_CALLS and vanished, with nothing on screen to say why.
 *
 * The ceiling still applies wherever scores are derived from the contract log,
 * because an unbounded read is a real egress and memory risk. On the persistent
 * path it is irrelevant: that path reads per-caller aggregates, not log rows.
 */
const MAX_CONTRACTS = 20_000;
/** Scores move on the sampler's cadence (3 min), so a short TTL is plenty. */
const CACHE_TTL_MS = 120_000;

interface CacheEntry {
  at: number;
  cacheKey: string;
  payload: unknown;
}

const cache = new Map<string, CacheEntry>();

/**
 * What the board is built from.
 *
 * `persistent` — per-caller records in `caller_calls`, which survive the
 *   contract log rolling off. Once someone scans they stay ranked, and every
 *   later scan updates the record.
 * `derived` — the original fold over the contract log. Still the local-mode
 *   path (no Supabase there), and the fallback if the persistent read fails.
 */
type ScoresMode = 'persistent' | 'derived';

interface ScoresPayload {
  windowDays: number;
  contracts: number;
  pricedTokens: number;
  truncated: boolean;
  coversFrom?: string;
  scores: CallerScore[];
  roomScores: RoomCallerScores;
  /** Added with persistence; older consumers ignore it. */
  mode: ScoresMode;
  /** True when the board covers the caller's whole recorded history. */
  allTime: boolean;
  /** Distinct callers on the persistent record (0 on the derived path). */
  callersTracked: number;
}

/** Oldest call on the record, across the global (all-rooms) aggregate rows. */
function earliestCall(rows: CallerAggregateRow[]): string | undefined {
  let out: string | undefined;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (row.roomId != null && row.roomId !== '') continue;
    const ms = row.firstCallAt ? new Date(row.firstCallAt).getTime() : NaN;
    if (Number.isFinite(ms) && ms < bestMs) {
      bestMs = ms;
      out = row.firstCallAt;
    }
  }
  return out;
}

/** Whole days between a timestamp and now, floored at 1. */
function daysSince(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return undefined;
  return Math.max(1, Math.ceil(ms / 86_400_000));
}

// Caller quality scores. The persistent path (hosted) reads per-caller
// aggregates that outlive the contract log; the derived path (local, or any
// failure of the first) folds the log on read as this route always used to.
// Both produce the identical payload shape, and both run the scoring maths in
// packages/shared so a caller's band can never depend on which one answered.
export function createCallersRoutes(ctx: RouterContext): Router {
  const router = Router();
  const { storage } = ctx;

  router.get('/callers/scores', async (req, res) => {
    try {
      const userId = getUserId(req);
      const rawWindow = req.query.windowDays as string | undefined;
      // An explicit windowDays still means a window. Absent means "everything
      // we have", which on the persistent path is the whole record — the point
      // of storing it. On the derived path there is nothing older than the log,
      // so the historical 30-day default stands in.
      const requestedWindow = rawWindow
        ? Math.max(1, Math.min(MAX_WINDOW_DAYS, Number.parseInt(rawWindow, 10) || DEFAULT_WINDOW_DAYS))
        : null;

      const cacheKey = requestedWindow == null ? 'all' : String(requestedWindow);
      const cached = cache.get(userId);
      if (cached && cached.cacheKey === cacheKey && Date.now() - cached.at < CACHE_TTL_MS) {
        return res.json(cached.payload);
      }

      // Bots are excluded here rather than in the feed: an enrichment bot's
      // reposts are still the data source enrichment reads, they just aren't
      // calls. Config additions layer on top of the known-bot defaults.
      const config = await storage.getConfig(userId).catch(() => null);
      const exclude = [...DEFAULT_EXCLUDED_CALLERS, ...(config?.callerScoreExclusions ?? [])];

      const payload =
        (await persistentScores(userId, requestedWindow, exclude)) ??
        (await derivedScores(userId, requestedWindow ?? DEFAULT_WINDOW_DAYS, exclude));

      cache.set(userId, { at: Date.now(), cacheKey, payload });
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to compute caller scores') });
    }
  });

  /**
   * Refresh one token's peak on demand, then invalidate this user's cached
   * board so the effect is visible immediately.
   *
   * Peaks are joined at read time, so a raised peak re-derives every caller who
   * ever called this token with no further writes. Deliberately one token per
   * call: this is the operator reaching for a specific name they think is
   * mis-scored, not a bulk re-crawl (which is what the sampler and
   * /admin token-peak backfill already are).
   */
  router.post('/callers/peaks/refresh', async (req, res) => {
    try {
      const userId = getUserId(req);
      const address = typeof req.body?.address === 'string' ? req.body.address.trim() : '';
      if (!address) return res.status(400).json({ error: 'address is required.' });

      const evmChain = typeof req.body?.evmChain === 'string' ? req.body.evmChain : undefined;
      const chain: 'evm' | 'sol' | undefined =
        req.body?.chain === 'evm' || req.body?.chain === 'sol' ? req.body.chain : undefined;

      const result = await refreshTokenPeak({ address, chain, evmChain });
      cache.delete(userId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to refresh token peak') });
    }
  });

  /** The persistent board, or null when this deployment has no persistent store. */
  async function persistentScores(
    userId: string,
    requestedWindow: number | null,
    exclude: string[],
  ): Promise<ScoresPayload | null> {
    const store = getCallerStatsStore();
    if (!store.persistent) return null;

    const since =
      requestedWindow == null
        ? undefined
        : new Date(Date.now() - requestedWindow * 86_400_000).toISOString();

    let rows;
    let counts;
    try {
      [rows, counts] = await Promise.all([
        store.loadAggregates(userId, since),
        store.loadTokenCounts(userId, since),
      ]);
    } catch (err) {
      // A persistent read that fails must not blank the board — fall through to
      // the derived path, which is strictly worse but still real.
      console.error('[Callers] persistent read failed:', (err as Error)?.message);
      return null;
    }
    if (!rows) return null;

    // `windowDays` is what `callsPerDay` divides by and what the console words
    // its coverage note around. On an all-time board the honest value is the
    // span actually recorded, not a nominal 30 — with that, the console's
    // "these scores only reach back N days" warning stops firing precisely
    // because it is no longer true. Resolved before scoring so `callsPerDay` is
    // divided by the same number the console displays.
    const windowDays = requestedWindow ?? daysSince(earliestCall(rows)) ?? DEFAULT_WINDOW_DAYS;
    const { scores, roomScores, coversFrom, callers } = splitCallerAggregates(rows, windowDays, {
      exclude,
    });

    return {
      windowDays,
      // Calls on the record, not log rows read — the persistent path never
      // reads the log. Same meaning the console shows it under ("scanned").
      contracts: scores.reduce((sum, s) => sum + s.calls, 0),
      pricedTokens: counts.priced,
      // Nothing was cut short: the record is the whole record.
      truncated: false,
      coversFrom,
      scores,
      roomScores,
      mode: 'persistent',
      allTime: requestedWindow == null,
      callersTracked: callers,
    };
  }

  /** The original derive-on-read board: fold the contract log, join peaks. */
  async function derivedScores(
    userId: string,
    windowDays: number,
    exclude: string[],
  ): Promise<ScoresPayload> {
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const contracts = await storage.getContracts(userId, MAX_CONTRACTS, since);

    const peaks = await getPeaks(contracts.map((c) => c.address));
    const peakFor = (addr: string) => peaks.get(addr.toLowerCase());
    const scores = buildCallerScores(contracts, peakFor, windowDays, { exclude });
    // Room-scoped scores derive from the same inputs (contract rows already
    // carry room_ids in both storage impls), so like the global list they are
    // computed on read. Bots are excluded here too, for the same reason.
    const roomScores = buildRoomCallerScores(contracts, peakFor, windowDays, { exclude });

    // How far back the rows we actually got reach. In hosted mode this is short
    // of `since` when the read hit its ceiling; in local mode when the contract
    // log has rolled old rows off. Either way it, not `windowDays`, is the
    // history these scores are built on — so report it rather than let the
    // console keep claiming 30 days.
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

    return {
      windowDays,
      contracts: contracts.length,
      pricedTokens: peaks.size,
      /** True when the window held more rows than we were willing to read. */
      truncated: contracts.length >= MAX_CONTRACTS,
      coversFrom,
      scores,
      roomScores,
      mode: 'derived',
      allTime: false,
      callersTracked: 0,
    };
  }

  return router;
}

/** Test seam / invalidation hook for when the contract log changes wholesale. */
export function clearCallerScoreCache(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}
