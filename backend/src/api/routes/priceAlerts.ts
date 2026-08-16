import { Router } from 'express';
import type { RouterContext } from '../context.js';
import { getUserId, safeError } from '../shared.js';
import type { PriceAlertDirection, PriceAlertMetric, PriceAlertStatus } from '@oct/shared';

/** Anchored base58 Solana address (the shared detector regex is for scanning text). */
const SOL_ADDRESS_EXACT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Free text, echoed back in the alert — long enough to be useful, capped. */
const MAX_NOTE_LEN = 280;
const MAX_SYMBOL_LEN = 32;

/**
 * Sanity bounds on the level. The lower bound rejects a stray 0; the upper one
 * ($1T) rejects a fat-fingered paste that would simply never fire.
 */
const MIN_TARGET_USD = 1e-12;
const MAX_TARGET_USD = 1e12;

// Price alerts — operator-set levels on operator-chosen tokens. No detection,
// no scoring, no discovery; the poller only reports the crossing. Its own
// independent signal (CLAUDE.md), never fused with revival/breakout/
// convergence/FOMO/missed-runner. See backend/src/priceAlerts/.
export function createPriceAlertsRoutes(ctx: RouterContext): Router {
  const router = Router();
  const { storage } = ctx;

  router.get('/price-alerts', async (req, res) => {
    try {
      const userId = getUserId(req);
      const raw = typeof req.query.status === 'string' ? req.query.status : '';
      const status: PriceAlertStatus | undefined =
        raw === 'armed' || raw === 'fired' || raw === 'disabled' ? raw : undefined;
      const alerts = await storage.listPriceAlerts(userId, status);
      res.json({ alerts });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to load price alerts') });
    }
  });

  router.post('/price-alerts', async (req, res) => {
    try {
      const userId = getUserId(req);
      const mint = typeof req.body?.mint === 'string' ? req.body.mint.trim() : '';
      if (!mint) return res.status(400).json({ error: 'Token address is required' });
      // Solana only in v1 — the stored `chain` column is ready for more.
      if (!SOL_ADDRESS_EXACT.test(mint)) {
        return res.status(400).json({ error: 'Not a valid Solana address' });
      }

      const direction: PriceAlertDirection = req.body?.direction === 'below' ? 'below' : 'above';
      const metric: PriceAlertMetric = req.body?.metric === 'price' ? 'price' : 'mcap';

      const targetUsd = Number(req.body?.targetUsd);
      if (!Number.isFinite(targetUsd) || targetUsd < MIN_TARGET_USD || targetUsd > MAX_TARGET_USD) {
        return res.status(400).json({ error: 'Target must be a positive USD number' });
      }

      const noteRaw = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
      const symbolRaw = typeof req.body?.symbol === 'string' ? req.body.symbol.trim() : '';

      const alert = await storage.createPriceAlert(userId, {
        mint,
        chain: 'solana',
        symbol: symbolRaw ? symbolRaw.slice(0, MAX_SYMBOL_LEN) : null,
        direction,
        targetUsd,
        metric,
        note: noteRaw ? noteRaw.slice(0, MAX_NOTE_LEN) : null,
      });
      res.status(201).json(alert);
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to create price alert') });
    }
  });

  router.delete('/price-alerts/:id', async (req, res) => {
    try {
      const userId = getUserId(req);
      const removed = await storage.deletePriceAlert(userId, req.params.id);
      if (!removed) return res.status(404).json({ error: 'Price alert not found' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to delete price alert') });
    }
  });

  return router;
}
