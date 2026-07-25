import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { testMissedRunnerForAddress } from '../../alerts/missedRunnerTest.js';
import type { RouterContext } from '../context.js';
import { getUserId, safeError } from '../shared.js';

// Manual missed-runner alert testing (rate-limited).
export function createAlertsRoutes(ctx: RouterContext): Router {
  const router = Router();
  const { wsServer } = ctx;

  const missedRunnerTestLimiter = rateLimit({
    windowMs: 60_000,
    max: 12,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.userId ?? req.ip ?? 'unknown',
    message: { error: 'Too many test alerts — wait a minute and try again.' },
  });

  router.post('/alerts/missed-runner/test', missedRunnerTestLimiter, async (req, res) => {
    try {
      const userId = getUserId(req);
      const address = typeof req.body?.address === 'string' ? req.body.address.trim() : '';
      const force = Boolean(req.body?.force);
      if (!address) {
        return res.status(400).json({ error: 'address is required.' });
      }
      const result = await testMissedRunnerForAddress(wsServer, userId, address, { force });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Missed-runner test failed') });
    }
  });

  return router;
}
