import { Router } from 'express';
import { sendPushover } from '../../utils/pushover.js';
import { buildContractUrl } from '../../utils/contract.js';
import type { RouterContext } from '../context.js';
import { getUserId } from '../shared.js';

// Ad-hoc Pushover notification for signal-convergence events.
export function createPushoverRoutes(ctx: RouterContext): Router {
  const router = Router();
  const { storage } = ctx;

  router.post('/pushover/signal-convergence', async (req, res) => {
    const userId = getUserId(req);
    const { contractAddress, tokenSymbol, traderName, channelName, evmChain } = req.body ?? {};

    if (typeof contractAddress !== 'string' || !contractAddress.trim()) {
      return res.status(400).json({ error: 'contractAddress is required.' });
    }

    const config = await storage.getConfig(userId);
    const cfg = config.pushover;
    if (!cfg?.enabled || !cfg.appToken || !cfg.userKey) {
      return res.json({ sent: false });
    }

    const triggers = cfg.triggers ?? {
      highlightedUser: false,
      highlightedUserContract: true,
      contract: false,
      keyword: false,
      signalConvergence: false,
    };
    if (!triggers.signalConvergence) {
      return res.json({ sent: false });
    }

    const token = tokenSymbol || contractAddress.slice(0, 8);
    const trader = typeof traderName === 'string' && traderName.trim() ? traderName.trim() : 'Tracked trader';
    const channel = typeof channelName === 'string' && channelName.trim() ? channelName.trim() : 'feed';
    const url = buildContractUrl(
      contractAddress.trim(),
      config.contractLinkTemplates,
      typeof evmChain === 'string' ? evmChain : undefined,
    );

    await sendPushover(cfg, {
      title: 'Signal Convergence',
      message: `${trader} bought ${token} — also called in ${channel}`,
      url,
      urlTitle: 'Open chart',
    });

    res.json({ sent: true });
  });

  return router;
}
