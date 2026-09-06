// REST routes for the robinhoodtrenches source. Mounted at /api/robinhood, so
// authMiddleware has already populated req.userId.
//
// Every response carries the same envelope: `source`, `sourceLabel`,
// `sourceUrl`, `scope` and `chainId`. That is not decoration — this source
// covers Robinhood Chain (4663) ONLY and must never be mistakable for
// all-chain FOMO coverage in the console.
//
// Read-only, keyless, no persistence, no Supabase reads. When the upstream is
// down each handler answers 503 with `available: false` so the UI can render a
// "source unavailable" state instead of a blank panel.

import { Router } from 'express';
import { getRobinhoodHealth, robinhoodGetCached, ROBINHOOD_TTL } from './client.js';
import { getFeedSize, getRecentFills } from './feed.js';
import { getRobinhoodPollerStatus, isRobinhoodPollerEnabled } from './poller.js';
import {
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_SCOPE_NOTE,
  ROBINHOOD_SOURCE,
  ROBINHOOD_SOURCE_LABEL,
  ROBINHOOD_SOURCE_URL,
  normalizeFills,
  normalizeFlow,
  normalizeOverview,
  normalizeRadar,
  normalizeStatus,
  normalizeTraderProfile,
  normalizeTraders,
} from './normalize.js';

/** The scope envelope every response is wrapped in. */
const ENVELOPE = {
  source: ROBINHOOD_SOURCE,
  sourceLabel: ROBINHOOD_SOURCE_LABEL,
  sourceUrl: ROBINHOOD_SOURCE_URL,
  scope: ROBINHOOD_SCOPE_NOTE,
  chainId: ROBINHOOD_CHAIN_ID,
} as const;

function clampLimit(raw: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), max);
}

/** Upstream is third-party: a failure is a degraded source, never a 500. */
function unavailable(res: any, err: unknown, what: string) {
  const message = (err as Error)?.message ?? String(err);
  console.warn(`[Robinhood] ${what} unavailable:`, message.slice(0, 300));
  return res.status(503).json({
    ...ENVELOPE,
    available: false,
    error: `${ROBINHOOD_SOURCE_LABEL} is unreachable right now.`,
  });
}

export function createRobinhoodRouter(): Router {
  const router = Router();

  // GET /api/robinhood/status — indexer health plus OCT's own poller/feed state.
  // Answers 200 even when upstream is down; `available` says which it is.
  router.get('/status', async (_req, res) => {
    const poller = getRobinhoodPollerStatus();
    const health = getRobinhoodHealth();
    try {
      const { value, stale } = await robinhoodGetCached(
        '/api/status',
        ROBINHOOD_TTL.status,
        normalizeStatus,
      );
      res.json({
        ...ENVELOPE,
        available: true,
        stale,
        upstream: value,
        poller,
        pollerEnabled: isRobinhoodPollerEnabled(),
        bufferedFills: getFeedSize(),
        health,
      });
    } catch {
      res.json({
        ...ENVELOPE,
        available: false,
        stale: false,
        upstream: null,
        poller,
        pollerEnabled: isRobinhoodPollerEnabled(),
        bufferedFills: getFeedSize(),
        health,
      });
    }
  });

  // GET /api/robinhood/tape?limit=100 — the live fill tape.
  //
  // Served from the poller's in-memory buffer when it has anything (that is the
  // set the console's WS frames continue from, so seeding from it keeps the two
  // consistent); otherwise a cached direct read, which is also the path used
  // when the poller is switched off.
  router.get('/tape', async (req, res) => {
    const limit = clampLimit(req.query.limit, 100, 300);

    const buffered = getRecentFills(limit);
    if (buffered.length > 0) {
      return res.json({ ...ENVELOPE, available: true, stale: false, fills: buffered });
    }

    try {
      const { value, stale } = await robinhoodGetCached(
        `/api/tape?limit=${limit}`,
        ROBINHOOD_TTL.tape,
        normalizeFills,
      );
      res.json({ ...ENVELOPE, available: true, stale, fills: value });
    } catch (err) {
      unavailable(res, err, 'tape');
    }
  });

  // GET /api/robinhood/radar?limit=50 — fresh Robinhood Chain tokens ranked by
  // unique tracked buyers. Its own labelled signal; NOT folded into OCT's
  // convergence detector.
  router.get('/radar', async (req, res) => {
    const limit = clampLimit(req.query.limit, 50, 100);
    try {
      const { value, stale } = await robinhoodGetCached(
        `/api/radar?limit=${limit}`,
        ROBINHOOD_TTL.radar,
        normalizeRadar,
      );
      res.json({ ...ENVELOPE, available: true, stale, rows: value });
    } catch (err) {
      unavailable(res, err, 'radar');
    }
  });

  // GET /api/robinhood/overview — 24h aggregates for the chain.
  router.get('/overview', async (_req, res) => {
    try {
      const { value, stale } = await robinhoodGetCached(
        '/api/overview',
        ROBINHOOD_TTL.overview,
        normalizeOverview,
      );
      res.json({ ...ENVELOPE, available: true, stale, overview: value });
    } catch (err) {
      unavailable(res, err, 'overview');
    }
  });

  // GET /api/robinhood/traders?limit=50 — the indexed trader roster.
  router.get('/traders', async (req, res) => {
    const limit = clampLimit(req.query.limit, 50, 200);
    try {
      const { value, stale } = await robinhoodGetCached(
        `/api/traders?limit=${limit}`,
        ROBINHOOD_TTL.traders,
        normalizeTraders,
      );
      res.json({ ...ENVELOPE, available: true, stale, traders: value });
    } catch (err) {
      unavailable(res, err, 'traders');
    }
  });

  // GET /api/robinhood/flow?limit=25 — robinhoodtrenches' own lead/follower
  // read. Surfaced under its own name and kept separate from OCT convergence.
  router.get('/flow', async (req, res) => {
    const limit = clampLimit(req.query.limit, 25, 100);
    try {
      const { value, stale } = await robinhoodGetCached(
        `/api/flow?limit=${limit}`,
        ROBINHOOD_TTL.flow,
        normalizeFlow,
      );
      res.json({ ...ENVELOPE, available: true, stale, rows: value });
    } catch (err) {
      unavailable(res, err, 'flow');
    }
  });

  // GET /api/robinhood/trader/:handle — one trader's profile and open bags.
  // The handle is validated here rather than passed through: it is
  // caller-supplied and goes into an upstream URL path.
  router.get('/trader/:handle', async (req, res) => {
    const handle = typeof req.params.handle === 'string' ? req.params.handle.trim() : '';
    if (!handle || handle.length > 64 || !/^[A-Za-z0-9_.-]+$/.test(handle)) {
      return res.status(400).json({ ...ENVELOPE, available: true, error: 'A valid trader handle is required.' });
    }
    try {
      const { value, stale } = await robinhoodGetCached(
        `/api/trader/${encodeURIComponent(handle)}`,
        ROBINHOOD_TTL.trader,
        normalizeTraderProfile,
      );
      if (!value) {
        return res.status(404).json({ ...ENVELOPE, available: true, error: `No indexed trader "${handle}".` });
      }
      res.json({ ...ENVELOPE, available: true, stale, trader: value });
    } catch (err) {
      unavailable(res, err, 'trader');
    }
  });

  return router;
}
