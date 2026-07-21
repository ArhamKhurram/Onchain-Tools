import { Router } from 'express';
import { isHostedMode } from '../storage/index.js';
import {
  fetchPortfolioActivity,
  fetchPortfolioHoldings,
  fetchPortfolioPnlDaily,
  fetchPortfolioStats,
  getPortfolioProvider,
  portfolioErrorStatus,
} from './provider.js';
import {
  gmgnChainToOct,
  resolvePortfolioChains,
  type GmgnChain,
  type OctWalletChain,
} from './gmgnWallet.js';
import { userOwnsHoldingWallet } from './ownership.js';
import { getPortfolioEnvStatus, probePortfolio } from './portfolioStatus.js';

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

  /** Debug: portfolio provider env + optional live probes (no secrets returned). */
  router.get('/status', async (req, res) => {
    try {
      const probeChain = typeof req.query.probeChain === 'string' ? req.query.probeChain : undefined;
      const probeAddress = typeof req.query.probeAddress === 'string' ? req.query.probeAddress : undefined;

      if (probeChain || probeAddress) {
        const full = await probePortfolio({ probeChain, probeAddress });
        return res.json(full);
      }

      res.json(getPortfolioEnvStatus());
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to read portfolio status') });
    }
  });

  router.get('/:chainParam/:address/stats', async (req, res) => {
    try {
      const target = await resolveTarget(req, res);
      if (!target) return;

      const period = parsePeriod(req.query.period);
      const result = await fetchPortfolioStats(target.chains, target.address, period);
      if (!result.ok) return res.status(portfolioErrorStatus(result)).json({ ...result, provider: getPortfolioProvider() });

      res.json({ period, chains: target.chains, provider: getPortfolioProvider(), stats: result.data });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to fetch wallet stats') });
    }
  });

  router.get('/:chainParam/:address/holdings', async (req, res) => {
    try {
      const target = await resolveTarget(req, res);
      if (!target) return;

      const extraLimit = req.query.limit ? Number(req.query.limit) : 50;
      const result = await fetchPortfolioHoldings(target.chains, target.address, extraLimit);
      if (!result.ok) return res.status(portfolioErrorStatus(result)).json({ ...result, provider: getPortfolioProvider() });

      res.json({ chains: target.chains, provider: getPortfolioProvider(), ...result.data });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to fetch wallet holdings') });
    }
  });

  router.get('/:chainParam/:address/activity', async (req, res) => {
    try {
      const target = await resolveTarget(req, res);
      if (!target) return;

      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const result = await fetchPortfolioActivity(target.chains, target.address, limit);
      if (!result.ok) return res.status(portfolioErrorStatus(result)).json({ ...result, provider: getPortfolioProvider() });

      res.json({ chains: target.chains, provider: getPortfolioProvider(), ...result.data });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to fetch wallet activity') });
    }
  });

  router.get('/:chainParam/:address/pnl-daily', async (req, res) => {
    try {
      const target = await resolveTarget(req, res);
      if (!target) return;

      const period = parsePeriod(req.query.period);
      const pnl = await fetchPortfolioPnlDaily(target.chains, target.address, period);
      if ('ok' in pnl && pnl.ok === false) {
        return res.status(portfolioErrorStatus(pnl)).json({ ...pnl, provider: getPortfolioProvider() });
      }

      res.json({ period, chains: target.chains, provider: getPortfolioProvider(), ...pnl });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to aggregate daily PnL') });
    }
  });

  return router;
}
