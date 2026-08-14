import { Router } from 'express';
import type { RouterContext } from '../context.js';
import { getUserId, safeError } from '../shared.js';
import { abandonedMapFromPositions } from '../../journal/abandoned.js';
import { buildPositions } from '../../journal/positions.js';
import { buildJournalSummary } from '../../journal/stats.js';
import { getHeliusApiKey } from '../../journal/helius.js';
import { nudgeJournalPoller } from '../../journal/poller.js';

/** Summary/pairing work from at most this many trades (newest-first). */
const SUMMARY_TRADE_LIMIT = 20_000;

/** Anchored base58 Solana address (the shared detector regex is for scanning text). */
const SOL_ADDRESS_EXACT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Trade journal — the user's OWN wallets (distinct from tracked/copy wallets):
// wallet CRUD, normalized trade log, FIFO positions, and the summary that
// powers the give-back meter. See backend/src/journal/.
export function createJournalRoutes(ctx: RouterContext): Router {
  const router = Router();
  const { storage } = ctx;

  router.get('/journal/wallets', async (req, res) => {
    try {
      const userId = getUserId(req);
      const wallets = await storage.listJournalWallets(userId);
      // configured: whether ingestion can actually run (self-diagnosis surface).
      res.json({ wallets, heliusConfigured: getHeliusApiKey() != null });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to load journal wallets') });
    }
  });

  router.post('/journal/wallets', async (req, res) => {
    try {
      const userId = getUserId(req);
      const address = typeof req.body?.address === 'string' ? req.body.address.trim() : '';
      const labelRaw = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
      if (!address) return res.status(400).json({ error: 'Address is required' });
      // Solana only in v1.
      if (!SOL_ADDRESS_EXACT.test(address)) {
        return res.status(400).json({ error: 'Not a valid Solana address' });
      }
      const wallet = await storage.addJournalWallet(userId, address, labelRaw || null);
      nudgeJournalPoller();
      res.status(201).json(wallet);
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to add journal wallet') });
    }
  });

  router.delete('/journal/wallets/:id', async (req, res) => {
    try {
      const userId = getUserId(req);
      const removed = await storage.removeJournalWallet(userId, req.params.id);
      if (!removed) return res.status(404).json({ error: 'Wallet not found' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to remove journal wallet') });
    }
  });

  router.get('/journal/trades', async (req, res) => {
    try {
      const userId = getUserId(req);
      const parsed = Number.parseInt(String(req.query.limit ?? ''), 10);
      const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 1000) : 200;
      const walletId = typeof req.query.walletId === 'string' ? req.query.walletId : undefined;
      const trades = await storage.listJournalTrades(userId, limit, walletId);
      res.json({ trades });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to load journal trades') });
    }
  });

  router.get('/journal/positions', async (req, res) => {
    try {
      const userId = getUserId(req);
      const status =
        req.query.status === 'open' ? 'open' : req.query.status === 'closed' ? 'closed' : undefined;
      const positions = await storage.listJournalPositions(userId, status);
      res.json({ positions });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to load journal positions') });
    }
  });

  // Header stats + cumulative realized PnL curve + day list. Recomputed from
  // the trade log on request (pure pairing + stats over ≤20k trades — cheap),
  // so the summary can never drift from the stored trades.
  router.get('/journal/summary', async (req, res) => {
    try {
      const userId = getUserId(req);
      const trades = await storage.listJournalTrades(userId, SUMMARY_TRADE_LIMIT);
      // Auto-closed dead bags are recorded on the stored rows, not derivable
      // from trades — feed them back so the curve books their zero-proceeds
      // loss instead of showing them as still open.
      const closedRows = await storage.listJournalPositions(userId, 'closed');
      const { positions, events } = buildPositions(trades, {
        abandoned: abandonedMapFromPositions(closedRows),
      });
      res.json({ summary: buildJournalSummary(events, positions, trades.length) });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to build journal summary') });
    }
  });

  return router;
}
