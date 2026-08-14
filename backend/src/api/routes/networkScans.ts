import { Router } from 'express';
import type { RouterContext } from '../context.js';
import { lookupNetworkScans } from '../../network/scanPool.js';
import { safeError } from '../shared.js';

const MAX_ADDRESSES = 100;

// Anonymous network scan pool reads (see backend/src/network/scanPool.ts).
// The pool is a shared dataset with no user linkage, so the lookup takes no
// userId — auth still gates the route (authMiddleware on /api) and the hosted
// /api rate limiter covers it like every neighbor. In local mode the pool
// doesn't exist and the lookup returns an empty map.
export function createNetworkScansRoutes(_ctx: RouterContext): Router {
  const router = Router();

  router.post('/network-scans/lookup', async (req, res) => {
    try {
      const raw = req.body?.addresses;
      if (!Array.isArray(raw)) {
        return res.status(400).json({ error: 'addresses must be an array.' });
      }
      const addresses = raw
        .filter((a): a is string => typeof a === 'string' && a.length > 0 && a.length <= 128)
        .slice(0, MAX_ADDRESSES);
      const scans = await lookupNetworkScans(addresses);
      res.json({ scans });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to look up network scans') });
    }
  });

  return router;
}
