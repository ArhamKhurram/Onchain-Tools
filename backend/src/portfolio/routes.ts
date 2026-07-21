import { Router } from 'express';
import { isHostedMode } from '../storage/index.js';
import {
  fetchAllWalletActivityMerged,
  fetchWalletActivityMerged,
  fetchWalletHoldingsMerged,
  fetchWalletStatsMerged,
  gmgnChainToOct,
  resolvePortfolioChains,
  type GmgnChain,
  type OctWalletChain,
} from './gmgnWallet.js';
import { aggregateDailyPnl } from './pnlAggregator.js';
import { userOwnsHoldingWallet } from './ownership.js';

function getUserId(req: { userId?: string }): string {
  return req.userId ?? 'local';
}

function safeError(err: unknown, fallback: string): string {
  if (!isHostedMode()) return err instanceof Error ? err.message : fallback;
  console.error(`[PortfolioAPI] ${fallback}:`, err instanceof Error ? err.message : err);
  return fallback;
}

function parsePeriod(raw: unknown): '7d' | '30d' {
  return raw === '30d' ? '30d' : '7d';
}

function portfolioErrorStatus(result: { needsPrivateKey?: boolean; gmgnConfigured?: boolean }): number {
  if (result.gmgnConfigured === false) return 503;
  if (result.needsPrivateKey) return 403;
  return 502;
}

type ResolvedTarget = {
  chains: GmgnChain[];
  octChains: OctWalletChain[];
  address: string;
  isSolana: boolean;
};

/**
 * Resolve + authorize a portfolio request. Returns null (after sending a
 * response) when the chain is unsupported, address missing, or the wallet is
 * not in the caller's My Wallets.
 */
async function resolveTarget(
  req: { userId?: string; params: { chainParam: string; address: string } },
  res: { status: (n: number) => { json: (b: unknown) => void } },
): Promise<ResolvedTarget | null> {
  const chains = resolvePortfolioChains(req.params.chainParam);
  if (!chains) {
    res.status(400).json({ error: 'Unsupported chain.' });
    return null;
  }

  const isSolana = chains.length === 1 && chains[0] === 'sol';
  const rawAddress = (req.params.address ?? '').trim();
  if (!rawAddress) {
    res.status(400).json({ error: 'address is required.' });
    return null;
  }
  const address = isSolana ? rawAddress : rawAddress.toLowerCase();

  const octChains = chains
    .map((c) => gmgnChainToOct(c))
    .filter((c): c is OctWalletChain => c != null);

  const owned = await userOwnsHoldingWallet(getUserId(req), octChains, address, isSolana);
  if (!owned) {
    res.status(403).json({ error: 'Wallet not in My Wallets for this account.' });
    return null;
  }

  return { chains, octChains, address, isSolana };
}

export function createPortfolioRouter(): Router {
  const router = Router();

  router.get('/:chainParam/:address/stats', async (req, res) => {
    try {
      const target = await resolveTarget(req, res);
      if (!target) return;

      const period = parsePeriod(req.query.period);
      const result = await fetchWalletStatsMerged(target.chains, target.address, period);
      if (!result.ok) return res.status(portfolioErrorStatus(result)).json(result);

      res.json({ period, chains: target.chains, stats: result.data });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to fetch wallet stats') });
    }
  });

  router.get('/:chainParam/:address/holdings', async (req, res) => {
    try {
      const target = await resolveTarget(req, res);
      if (!target) return;

      const extra: Record<string, string | number> = {};
      if (req.query.limit) extra.limit = Number(req.query.limit);
      if (typeof req.query.cursor === 'string') extra.cursor = req.query.cursor;

      const result = await fetchWalletHoldingsMerged(target.chains, target.address, extra);
      if (!result.ok) return res.status(portfolioErrorStatus(result)).json(result);

      res.json({ chains: target.chains, ...result.data });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to fetch wallet holdings') });
    }
  });

  router.get('/:chainParam/:address/activity', async (req, res) => {
    try {
      const target = await resolveTarget(req, res);
      if (!target) return;

      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const result = await fetchWalletActivityMerged(target.chains, target.address, limit);
      if (!result.ok) return res.status(portfolioErrorStatus(result)).json(result);

      res.json({ chains: target.chains, ...result.data });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to fetch wallet activity') });
    }
  });

  router.get('/:chainParam/:address/pnl-daily', async (req, res) => {
    try {
      const target = await resolveTarget(req, res);
      if (!target) return;

      const period = parsePeriod(req.query.period);
      const periodDays = period === '7d' ? 7 : 30;
      const activities = await fetchAllWalletActivityMerged(target.chains, target.address, { periodDays });
      const pnl = aggregateDailyPnl(activities, periodDays);

      res.json({ period, chains: target.chains, ...pnl });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to aggregate daily PnL') });
    }
  });

  return router;
}
